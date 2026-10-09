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
  await page.getByRole('button', { name: '固定所选板材', exact: true }).click()
  const after = await store(page)
  expect(after.connectors).toHaveLength(8)
  expect(after.panels).toEqual(before.panels)
  expect(after.profiles).toEqual(before.profiles)
  expect(after.past).toBe(before.past + 1)
  expect(after.connectors.every(c => c.panelMount.spacer === 6 && c.panelMount.panelId === 'board')).toBe(true)
  expect((await conflicts(page)).conflicts).toEqual([])
  await page.getByRole('button', { name: '固定所选板材', exact: true }).click()
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

test('panel meshes survive rigid moves, but change when fastening holes are removed', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => {
    const s = (window as any).__aluframe.store.getState()
    const panel = { id: 'board', width: 860, height: 240, thickness: 18, position: [450, 350, 160],
      quaternion: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], material: 'ply' }
    const rail = (id: string, z: number) => ({ id, position: [0, 350, z], length: 900, spec: '2040',
      quaternion: [.5, .5, .5, .5], miterCuts: [], holes: [] })
    const doc = { profiles: [rail('front', 20), rail('back', 300)], panels: [panel], connectors: [], fittings: [], equipment: [] }
    s.loadDocument(doc)
    s.selectItems(['board'])
  })
  await page.getByRole('button', { name: '固定所选板材', exact: true }).click()
  const mesh = () => page.evaluate(() => {
    let result: { uuid: string; vertices: number } | null = null
    ;(window as any).__aluframe.sceneRoot.traverse((o: any) => {
      if (o.userData.panelId === 'board') {
        const mesh = o.children.find((c: any) => c.isMesh)
        result = { uuid: mesh.geometry.uuid, vertices: mesh.geometry.attributes.position.count }
      }
    })
    return result
  })
  await expect.poll(mesh).not.toBeNull()
  const before = await mesh()
  expect((await store(page)).connectors.length).toBeGreaterThan(0)
  await page.evaluate(() => {
    const s = (window as any).__aluframe.store.getState()
    const updates = (parts: any[]) => parts.map(p => ({ id: p.id, updates: { position: [p.position[0] + 100, p.position[1], p.position[2] + 50] } }))
    s.commitTransform({ profiles: updates(s.profiles), connectors: updates(s.connectors), panels: updates(s.panels) })
  })
  await expect.poll(async () => (await store(page)).panels[0].position[0]).toBe(550)
  expect(await mesh()).toEqual(before)
  const seating = page.getByTestId('bom-bracket-seating')
  const beforeSeating = await seating.textContent()
  await page.evaluate(() => {
    const api = (window as any).__aluframe, s = api.store.getState()
    api.tool.setState({ isDragging: true })
    const c = s.connectors[0]
    s.updateConnector(c.id, { position: [c.position[0], c.position[1] + 100, c.position[2]] })
  })
  await expect(page.getByTestId('installation-pending')).toHaveCount(1)
  expect(await seating.textContent()).toBe(beforeSeating)
  await page.evaluate(() => (window as any).__aluframe.tool.getState().stopDrag())
  await expect(page.getByTestId('installation-pending')).toHaveCount(0)
  await expect(seating).not.toHaveText(beforeSeating!)
  await page.evaluate(() => {
    const s = (window as any).__aluframe.store.getState()
    s.removeConnectors(s.connectors.map((c: any) => c.id))
  })
  await expect.poll(async () => (await mesh())?.uuid).not.toBe(before!.uuid)
  expect((await mesh())!.vertices).toBeLessThan(before!.vertices)
})
