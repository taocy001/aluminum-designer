import { test, expect } from '@playwright/test'
import { openApp, store, conflicts } from './helpers'

test('fasten an inset shelf in place, preserve mounts on reload and undo the assembly in one step', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => {
    const api = (window as any).__aluframe
    const rail = (id: string, position: number[], length: number, wide = false) => ({
      id, position, length, spec: wide ? '2040' : '2020', quaternion: wide ? [.5, .5, .5, .5] : [0, 0, 0, 1], miterCuts: [], holes: [],
    })
    api.store.getState().loadDocument({ throughRule: 'rails', profiles: [
      rail('front', [0, 350, 20], 900, true), rail('back', [0, 350, 300], 900, true),
      rail('left', [10, 350, 40], 240), rail('right', [890, 350, 40], 240),
    ], panels: [{ id: 'board', width: 860, height: 240, thickness: 18, position: [450, 355, 160],
      quaternion: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], material: 'ply' }], connectors: [], fittings: [], equipment: [] })
    api.store.getState().selectItems(['board'])
  })
  const before = await store(page)
  await page.getByRole('button', { name: '固定所选层板', exact: true }).click()
  const after = await store(page)
  expect(after.connectors).toHaveLength(8)
  expect(after.panels).toEqual(before.panels)
  expect(after.profiles).toEqual(before.profiles)
  expect(after.past).toBe(before.past + 1)
  expect(after.connectors.every(c => c.panelMount.spacer === 6 && c.panelMount.panelId === 'board')).toBe(true)
  expect((await conflicts(page)).conflicts).toEqual([])
  await page.getByRole('button', { name: '固定所选层板', exact: true }).click()
  expect((await store(page)).connectors).toHaveLength(8)
  expect((await store(page)).past).toBe(after.past)
  await page.keyboard.press('Control+z')
  expect((await store(page)).connectors).toHaveLength(0)
  await page.keyboard.press('Control+y')
  expect((await store(page)).connectors).toHaveLength(8)
  await page.reload()
  await page.waitForFunction(() => (window as any).__aluframe?.setView)
  expect((await store(page)).connectors).toHaveLength(8)
  expect((await store(page)).panels).toEqual(before.panels)
})
