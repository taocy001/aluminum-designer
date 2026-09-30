import { test, expect, type Page } from '@playwright/test'
import { openApp, setView, w2c, settle, store, clickWorld } from './helpers'

async function bodies(page: Page) {
  await settle(page)
  return page.evaluate(() => {
    const w = (window as any).__aluframe
    const meshes: Record<string, { position: number[]; length: number }> = {}
    w.sceneRoot.traverse((o: any) => {
      if (o.isMesh && o.userData.profileId) meshes[o.userData.profileId] = { position: o.position.toArray(), length: o.scale.z }
    })
    return { meshes, trims: w.trims() }
  })
}

async function joinedPair(page: Page, rule: 'rails' | 'posts', locked = true) {
  await page.evaluate(({ rule, locked }) => {
    const w = (window as any).__aluframe
    w.tool.getState().putDown()
    w.store.getState().loadDocument({ profiles: [
      { id: 'A', spec: '4040', length: 800, position: [0, 0, 0], quaternion: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], holes: [], miterCuts: [], locked },
      { id: 'B', spec: '4040', length: 600, position: [0, 800, 0], quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2], holes: [], miterCuts: [] },
    ], connectors: [], panels: [], fittings: [], throughRule: rule })
    w.store.getState().clearSelection()
  }, { rule, locked })
  await setView(page, [1400, 1200, 1800], [200, 450, 0])
  await settle(page)
}

async function moveB(page: Page, inspect?: () => Promise<void>) {
  const from = await w2c(page, [300, 800, 0])
  await page.mouse.move(from.x, from.y)
  await page.keyboard.down('Shift')
  await page.mouse.down()
  expect(await page.evaluate(() => (window as any).__aluframe.tool.getState().dragProfileId)).toBe('B')
  for (const z of [5, 15, 25, 60, 150]) {
    const to = await w2c(page, [300, 800, z])
    await page.mouse.move(to.x, to.y, { steps: 3 })
    await settle(page)
    await inspect?.()
  }
  await page.mouse.up()
  await page.keyboard.up('Shift')
  await settle(page)
}

test.describe('Dragging a member preserves existing physical lengths', () => {
  test.beforeEach(async ({ page }) => { await openApp(page) })

  for (const rule of ['rails', 'posts'] as const) test(`${rule}: B moves without changing locked A, including undo, redo and reload`, async ({ page }) => {
    await joinedPair(page, rule)
    const before = await store(page)
    const original = await bodies(page)
    expect(original.meshes.A.length).toBeCloseTo(rule === 'rails' ? 780 : 820)
    expect(original.meshes.B.length).toBeCloseTo(rule === 'rails' ? 620 : 580)
    const unchangedLengths = async () => {
      const actual = await bodies(page)
      expect(actual.meshes.A).toEqual(original.meshes.A)
      expect(actual.meshes.B.length).toBeCloseTo(original.meshes.B.length)
      expect(actual.trims.A.cutLength).toBeCloseTo(original.meshes.A.length)
      expect(actual.trims.B.cutLength).toBeCloseTo(original.meshes.B.length)
      expect((await store(page)).profiles[0].length).toBe(800)
    }
    await moveB(page, unchangedLengths)
    await unchangedLengths()
    const after = await store(page)
    expect(after.profiles[1].position[2]).toBeCloseTo(150)
    expect(after.past).toBe(before.past + 1)
    await page.screenshot({ path: test.info().outputPath(`B-moved-A-unchanged-${rule}.png`) })
    await page.keyboard.press('Control+z')
    expect((await store(page)).profiles).toEqual(before.profiles)
    await page.keyboard.press('Control+y')
    expect((await store(page)).profiles).toEqual(after.profiles)
    await unchangedLengths()
    await page.reload()
    await page.waitForFunction(() => (window as any).__aluframe?.setView)
    expect((await store(page)).profiles).toEqual(after.profiles)
    await unchangedLengths()
  })

  test('recalculating joints is explicit, undoable, and preserves locked A', async ({ page }) => {
    await joinedPair(page, 'rails')
    await moveB(page)
    const before = await store(page)
    const original = await bodies(page)
    await page.getByTestId('recalculate-joints').click()
    await expect.poll(async () => (await bodies(page)).meshes.B.length).toBe(600)
    expect((await bodies(page)).meshes.A).toEqual(original.meshes.A)
    expect((await store(page)).past).toBe(before.past + 1)
    await page.keyboard.press('Control+z')
    expect((await store(page)).profiles).toEqual(before.profiles)
    expect((await bodies(page)).meshes).toEqual(original.meshes)
  })

  test('typing a stretch length measures the solid and keeps the opposite cut end fixed', async ({ page }) => {
    await page.evaluate(() => {
      const w = (window as any).__aluframe
      w.tool.getState().putDown()
      w.store.getState().loadDocument({ profiles: [{ id: 'A', spec: '2020', length: 600,
        position: [0, 100, 0], quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2], holes: [], miterCuts: [], fixedTrims: { start: 100, end: 20 } }],
      connectors: [], panels: [], fittings: [] })
    })
    await setView(page, [1000, 800, 1600], [350, 100, 0])
    await clickWorld(page, [350, 100, 0])
    const before = await store(page)
    const original = await bodies(page)
    expect(original.meshes.A.length).toBe(480)
    const at = await w2c(page, [580, 100, 0])
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    expect(await page.evaluate(() => (window as any).__aluframe.tool.getState().resize?.id)).toBe('A')
    await page.getByTestId('exact-input').fill('800')
    await page.getByTestId('exact-input').press('Enter')
    await page.mouse.up()
    const after = await bodies(page)
    expect(after.meshes.A.length).toBe(800)
    expect(after.meshes.A.position).toEqual(original.meshes.A.position)
    expect(after.trims.A.cutLength).toBe(800)
    expect((await store(page)).past).toBe(before.past + 1)
    await page.keyboard.press('Control+z')
    expect((await store(page)).profiles).toEqual(before.profiles)
  })

  test('an extended end behind the model origin does not jump when stretched', async ({ page }) => {
    await page.evaluate(() => {
      const w = (window as any).__aluframe
      w.tool.getState().putDown()
      w.store.getState().loadDocument({ profiles: [{ id: 'A', spec: '2020', length: 100,
        position: [400, 100, 0], quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2], holes: [], miterCuts: [], fixedTrims: { start: -200, end: 150 } }],
      connectors: [], panels: [], fittings: [] })
    })
    await setView(page, [400, 300, 900], [300, 100, 0])
    await clickWorld(page, [275, 100, 0])
    const original = await bodies(page)
    expect(original.meshes.A.length).toBe(150)
    const from = await w2c(page, [350, 100, 0])
    const to = await w2c(page, [380, 100, 0])
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    expect(await page.evaluate(() => (window as any).__aluframe.tool.getState().resize?.end)).toBe('end')
    await page.mouse.move(to.x, to.y, { steps: 6 })
    await page.mouse.up()
    const after = await bodies(page)
    expect(after.meshes.A.length).toBeCloseTo(180)
    expect(after.meshes.A.position).toEqual(original.meshes.A.position)
  })
})
