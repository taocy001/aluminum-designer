import { test, expect, type Page } from '@playwright/test'
import { openApp, setView, clickWorld, w2c, dragHold, settle, store } from './helpers'

async function guides(page: Page) {
  return page.evaluate(() => {
    const out: any[] = []
    ;(window as any).__aluframe.sceneRoot.traverseVisible((o: any) => { if (o.userData.editAlignment) out.push(o.userData) })
    return out
  })
}
async function bodies(page: Page) {
  return page.evaluate(() => {
    const out: Record<string, { start: number[]; length: number }> = {}
    ;(window as any).__aluframe.sceneRoot.traverseVisible((o: any) => {
      if (o.isMesh && o.userData.profileId) out[o.userData.profileId] = { start: o.position.toArray(), length: o.scale.z }
    })
    return out
  })
}
async function seed(page: Page, resize = false) {
  await page.evaluate((resize) => {
    const w = (window as any).__aluframe
    w.tool.getState().putDown()
    const base = { spec: '2020', quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2], holes: [], miterCuts: [] }
    w.store.getState().loadDocument({ profiles: resize ? [
      { ...base, id: 'reference', position: [0, 100, 0], length: 650, fixedTrims: { start: 50, end: 50 } },
      { ...base, id: 'moving', position: [100, 100, 200], length: 400, fixedTrims: { start: 20, end: 20 } },
    ] : [
      { ...base, id: 'reference', position: [0, 100, 0], length: 600, fixedTrims: { start: 0, end: 0 } },
      { ...base, id: 'moving', position: [0, 100, 300], length: 600, fixedTrims: { start: 0, end: 0 } },
    ], connectors: [], panels: [], fittings: [], throughRule: 'rails' })
    w.store.getState().clearSelection()
  }, resize)
  await setView(page, [1200, 1100, 1800], [300, 100, 100])
}

test.describe('Visible alignment guides for moving and resizing', () => {
  test.beforeEach(async ({ page }) => { await openApp(page) })

  test('an exact end alignment gets a visible dashed extension even without a snap correction', async ({ page }) => {
    await seed(page)
    const before = await store(page)
    await dragHold(page, await w2c(page, [300, 100, 300]), await w2c(page, [300, 100, 100]))
    await expect.poll(async () => (await guides(page)).length).toBeGreaterThan(0)
    const line = (await guides(page)).find((g) => g.alignmentKind === 'end')
    expect(line).toBeDefined()
    expect(line.gesture).toBe('move')
    expect(line.refId).toBe('reference')
    expect(Math.hypot(...line.alignmentLine[0].map((v: number, i: number) => v - line.alignmentLine[1][i]))).toBeGreaterThan(100)
    expect((await store(page)).profiles[0]).toEqual(before.profiles[0])
    expect((await bodies(page)).moving.length).toBe(600)
    await page.screenshot({ path: test.info().outputPath('move-exact-alignment.png') })
    await page.keyboard.down('Shift')
    await settle(page)
    expect(await guides(page)).toEqual([])
    await page.keyboard.up('Shift')
    const back = await w2c(page, [300, 100, 100])
    await page.mouse.move(back.x + 1, back.y)
    await expect.poll(async () => (await guides(page)).length).toBeGreaterThan(0)
    await page.mouse.up()
    await settle(page)
    expect(await guides(page)).toEqual([])
    await page.keyboard.press('Control+z')
    expect((await store(page)).profiles).toEqual(before.profiles)
  })

  for (const end of ['start', 'end'] as const) test(`resizing the ${end} shows the actual trimmed reference end and holds the opposite end fixed`, async ({ page }) => {
    await seed(page, true)
    await clickWorld(page, [300, 100, 200])
    const before = await store(page), original = await bodies(page)
    await dragHold(page, await w2c(page, [end === 'start' ? 120 : 480, 100, 200]), await w2c(page, [end === 'start' ? 50 : 600, 100, 200]))
    await expect.poll(async () => (await guides(page)).length).toBeGreaterThan(0)
    const shown = await guides(page)
    expect(shown).toHaveLength(1)
    expect(shown[0].gesture).toBe('resize')
    expect(shown[0].alignmentKind).toBe('end')
    expect(shown[0].to[0]).toBeCloseTo(end === 'start' ? 50 : 600)
    expect(shown[0].from[0]).toBeCloseTo(shown[0].to[0])
    expect(Math.hypot(...shown[0].alignmentLine[0].map((v: number, i: number) => v - shown[0].alignmentLine[1][i]))).toBeGreaterThan(200)
    const current = await bodies(page)
    expect(current.reference).toEqual(original.reference)
    if (end === 'start') expect(current.moving.start[0] + current.moving.length).toBeCloseTo(480)
    else expect(current.moving.start).toEqual(original.moving.start)
    await page.screenshot({ path: test.info().outputPath(`resize-${end}-alignment.png`) })
    await page.keyboard.down('Shift')
    await settle(page)
    expect(await guides(page)).toEqual([])
    await page.keyboard.up('Shift')
    await page.mouse.up()
    await settle(page)
    expect(await guides(page)).toEqual([])
    expect((await store(page)).past).toBe(before.past + 1)
    await page.keyboard.press('Control+z')
    expect((await store(page)).profiles).toEqual(before.profiles)
  })

  test('Escape finishes an aligned gesture and subsequent pointer movement cannot edit it', async ({ page }) => {
    await seed(page)
    await dragHold(page, await w2c(page, [300, 100, 300]), await w2c(page, [300, 100, 100]))
    await expect.poll(async () => (await guides(page)).length).toBeGreaterThan(0)
    await page.keyboard.press('Escape')
    await settle(page)
    expect(await guides(page)).toEqual([])
    const stopped = await store(page)
    const pointer = await w2c(page, [450, 100, 300])
    await page.mouse.move(pointer.x, pointer.y)
    await page.mouse.up()
    expect((await store(page)).profiles).toEqual(stopped.profiles)
  })
})
