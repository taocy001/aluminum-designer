import { test, expect, type Page } from '@playwright/test'
import { openApp, setView, clickWorld, w2c, settle, store } from './helpers'

/** B covers A's upper end on screen, while remaining 100 mm in front of it in the model. */
async function overlappingEnds(page: Page, includeB = true) {
  await page.evaluate((withB) => {
    const w = (window as any).__aluframe
    w.tool.getState().putDown()
    w.store.getState().loadDocument({ profiles: [
      { id: 'A', spec: '2020', length: 700, position: [400, 0, 0],
        quaternion: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], miterCuts: [], holes: [] },
      ...(withB ? [{ id: 'B', spec: '2020', length: 600, position: [200, 685, 100],
        quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2], miterCuts: [], holes: [] }] : []),
    ], connectors: [], panels: [], fittings: [] })
  }, includeB)
  await setView(page, [400, 400, 2000], [400, 400, 0])
  await settle(page)
  await clickWorld(page, [400, 350, 0])
  expect((await store(page)).selectedIds).toEqual(['A'])
}

const pointerState = (page: Page) => page.evaluate(() => {
  const t = (window as any).__aluframe.tool.getState()
  return { hover: t.hoverProfileId, end: t.hoverEnd, resize: t.resize?.id ?? null,
    drag: t.dragProfileId, dragging: t.isDragging }
})

test.describe('The highlighted part owns the press', () => {
  test.beforeEach(async ({ page }) => { await openApp(page) })

  test('dragging foreground B cannot stretch selected A behind it, and the move is one undo', async ({ page }) => {
    await overlappingEnds(page)
    const before = await store(page)
    const grab = await w2c(page, [400, 685, 100])
    await page.mouse.move(grab.x, grab.y)
    await settle(page)
    expect(await page.evaluate((at) => (window as any).__aluframe.frontmostAt(at.x, at.y)?.id, grab)).toBe('B')
    expect(await pointerState(page)).toMatchObject({ hover: 'B', end: null, resize: null })

    await page.mouse.down()
    expect(await pointerState(page)).toMatchObject({ resize: null, drag: 'B', dragging: true })
    await page.mouse.move(grab.x + 70, grab.y - 35, { steps: 8 })
    await settle(page)
    const during = await store(page)
    expect(during.profiles.find((p) => p.id === 'A')).toMatchObject(before.profiles.find((p) => p.id === 'A'))
    expect(during.profiles.find((p) => p.id === 'B').length).toBe(600)
    expect(during.profiles.find((p) => p.id === 'B').position).not.toEqual([200, 685, 100])
    await page.mouse.up()
    await settle(page)
    expect((await store(page)).past).toBe(before.past + 1)
    await page.keyboard.press('Control+z')
    expect((await store(page)).profiles).toEqual(before.profiles)
  })

  test('Tab deliberately chooses the selected end behind B and keeps that choice through pointer jitter', async ({ page }) => {
    await overlappingEnds(page)
    const before = await store(page)
    const grab = await w2c(page, [400, 685, 100])
    await page.mouse.move(grab.x, grab.y)
    await settle(page)
    expect((await pointerState(page)).hover).toBe('B')
    await page.keyboard.press('Tab')
    expect(await pointerState(page)).toMatchObject({ hover: 'A', end: 'end' })
    await page.mouse.move(grab.x + 1, grab.y)
    await settle(page)
    expect(await pointerState(page)).toMatchObject({ hover: 'A', end: 'end' })
    await page.mouse.down()
    expect(await pointerState(page)).toMatchObject({ resize: 'A', drag: null, dragging: false })
    await page.mouse.move(grab.x + 1, grab.y - 60, { steps: 8 })
    await page.mouse.up()
    await settle(page)
    const after = await store(page)
    expect(after.profiles.find((p) => p.id === 'A').length).toBeGreaterThan(700)
    expect(after.profiles.find((p) => p.id === 'A').position).toEqual([400, 0, 0])
    expect(after.profiles.find((p) => p.id === 'B')).toMatchObject(before.profiles.find((p) => p.id === 'B'))
    expect(after.past).toBe(before.past + 1)
    await page.keyboard.press('Control+z')
    expect((await store(page)).profiles).toEqual(before.profiles)
  })

  test('a visible selected end still stretches while its opposite end stays fixed', async ({ page }) => {
    await overlappingEnds(page, false)
    const before = await store(page)
    const grab = await w2c(page, [400, 700, 0])
    await page.mouse.move(grab.x, grab.y)
    await settle(page)
    expect(await pointerState(page)).toMatchObject({ hover: 'A', end: 'end' })
    await page.mouse.down()
    expect(await pointerState(page)).toMatchObject({ resize: 'A', drag: null })
    await page.mouse.move(grab.x, grab.y - 60, { steps: 8 })
    await page.mouse.up()
    await settle(page)
    const after = await store(page)
    expect(after.profiles[0].length).toBeGreaterThan(700)
    expect(after.profiles[0].position).toEqual([400, 0, 0])
    expect(after.past).toBe(before.past + 1)
    await page.keyboard.press('Control+z')
    expect((await store(page)).profiles).toEqual(before.profiles)
  })
})
