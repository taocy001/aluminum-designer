import { test, expect, type Page } from '@playwright/test'
import { clickWorld, openApp, setView, settle, store, type V3 } from './helpers'

type Solid = { start: V3; end: V3; length: number }
const distance = (a: number[], b: number[]) => Math.hypot(...a.map((v, i) => v - b[i]))

/** Read the displayed extrusion itself, independently of pivot and joint calculations. */
async function solids(page: Page): Promise<Record<string, Solid>> {
  return page.evaluate(() => {
    const result: Record<string, Solid> = {}
    ;(window as any).__aluframe.sceneRoot.traverseVisible((o: any) => {
      if (!o.isMesh || !o.userData.profileId) return
      o.updateWorldMatrix(true, false)
      const start = o.localToWorld(o.position.clone().set(0, 0, 0))
      const end = o.localToWorld(o.position.clone().set(0, 0, 1))
      result[o.userData.profileId] = { start: start.toArray(), end: end.toArray(), length: start.distanceTo(end) }
    })
    return result
  })
}

const anchor = (page: Page) => page.evaluate(() => {
  const handles = (window as any).__aluframe.gizmoHandles()
  const x = handles.find((h: any) => h.kind === 'move' && h.axis === 'x')
  const y = handles.find((h: any) => h.kind === 'move' && h.axis === 'y')
  return x && y ? [y.position[0], x.position[1], x.position[2]] : null
})

async function workbench(page: Page) {
  await openApp(page)
  await page.getByTestId('template-bench').click()
  await page.getByTestId('template-place').click()
  await page.keyboard.press('Escape')
  await setView(page, [2000, 1700, 2600], [750, 450, 350])
  // The 4040 rails share the posts' centreline; the displayed end extends 20 mm.
  const rail = (await store(page)).profiles.find((p) => p.position[0] === 0 && p.position[1] === 900 && p.position[2] === 700)
  expect(rail).toBeTruthy()
  await clickWorld(page, [400, 900, 710])
  expect((await store(page)).selectedIds).toEqual([rail.id])
  return rail
}

for (const mode of ['start', 'end'] as const) {
  test(`workbench ${mode} gizmo and keyboard rotation keep the actual extended cap fixed`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const rail = await workbench(page)
    const beforeStore = await store(page)
    const before = await solids(page)
    expect(before[rail.id].length).toBeCloseTo(1540, 3)
    expect(distance(before[rail.id].start, rail.position)).toBeCloseTo(20, 3)
    await page.keyboard.press('p')
    if (mode === 'end') await page.keyboard.press('p')
    await expect.poll(async () => {
      const at = await anchor(page)
      return at ? distance(at, before[rail.id][mode]) : Infinity
    }).toBeLessThan(0.01)
    await page.keyboard.press('r')
    await page.keyboard.press('y')
    await settle(page)
    const after = await solids(page)
    expect(distance(after[rail.id][mode], before[rail.id][mode])).toBeLessThan(0.01)
    expect(distance(after[rail.id][mode === 'start' ? 'end' : 'start'], before[rail.id][mode === 'start' ? 'end' : 'start'])).toBeGreaterThan(1000)
    for (const [id, solid] of Object.entries(before)) {
      expect(after[id].length).toBeCloseTo(solid.length, 3)
      if (id === rail.id) continue
      expect(distance(after[id].start, solid.start)).toBeLessThan(0.01)
      expect(distance(after[id].end, solid.end)).toBeLessThan(0.01)
    }
    expect((await store(page)).past).toBe(beforeStore.past + 1)
    await page.keyboard.press('Control+z')
    await settle(page)
    expect((await store(page)).profiles).toEqual(beforeStore.profiles)
    const undone = await solids(page)
    for (const [id, solid] of Object.entries(before)) {
      expect(distance(undone[id].start, solid.start)).toBeLessThan(0.01)
      expect(distance(undone[id].end, solid.end)).toBeLessThan(0.01)
    }
    expect(errors).toEqual([])
  })
}

test('a locked selected reference does not move the gizmo away from the actual rotation pivot', async ({ page }) => {
  const rail = await workbench(page)
  await clickWorld(page, [1500, 450, 700])
  const lockedId = (await store(page)).selectedIds[0]
  expect(lockedId).not.toBe(rail.id)
  await page.keyboard.press('l')
  expect((await store(page)).profiles.find((p) => p.id === lockedId).locked).toBe(true)
  await clickWorld(page, [400, 900, 710])
  await clickWorld(page, [1500, 450, 700], { modifiers: ['Shift'] })
  expect((await store(page)).selectedIds.sort()).toEqual([rail.id, lockedId].sort())
  const before = await solids(page)
  const beforeStore = await store(page)
  await page.keyboard.press('p')
  await expect.poll(async () => {
    const at = await anchor(page)
    return at ? distance(at, before[rail.id].start) : Infinity
  }).toBeLessThan(0.01)
  await page.keyboard.press('r')
  await page.keyboard.press('y')
  await settle(page)
  const after = await solids(page)
  expect(distance(after[rail.id].start, before[rail.id].start)).toBeLessThan(0.01)
  expect(distance(after[lockedId].start, before[lockedId].start)).toBeLessThan(0.01)
  expect(distance(after[lockedId].end, before[lockedId].end)).toBeLessThan(0.01)
  expect((await store(page)).past).toBe(beforeStore.past + 1)
})

test('changing the joint rule refreshes both physical endpoint pivots while selection stays active', async ({ page }) => {
  const rail = await workbench(page)
  expect((await store(page)).profiles.every((p) => !p.fixedTrims)).toBe(true)
  const initial = (await solids(page))[rail.id]
  await page.keyboard.press('p')
  await expect.poll(async () => {
    const at = await anchor(page)
    return at ? distance(at, initial.start) : Infinity
  }).toBeLessThan(0.01)

  await page.getByTestId('sidebar-tab-add').click()
  await page.getByTestId('through-posts').click()
  await settle(page)
  expect((await store(page)).selectedIds).toEqual([rail.id])
  const postsThrough = (await solids(page))[rail.id]
  expect(distance(postsThrough.start, initial.start)).toBeGreaterThan(10)
  await expect.poll(async () => {
    const at = await anchor(page)
    return at ? distance(at, postsThrough.start) : Infinity
  }).toBeLessThan(0.01)

  await page.keyboard.press('p')
  await page.getByTestId('through-rails').click()
  await settle(page)
  expect((await store(page)).selectedIds).toEqual([rail.id])
  const railsThrough = (await solids(page))[rail.id]
  expect(distance(railsThrough.end, postsThrough.end)).toBeGreaterThan(10)
  await expect.poll(async () => {
    const at = await anchor(page)
    return at ? distance(at, railsThrough.end) : Infinity
  }).toBeLessThan(0.01)
  const beforeTurn = await store(page)
  await page.keyboard.press('r')
  await page.keyboard.press('y')
  await settle(page)
  expect(distance((await solids(page))[rail.id].end, railsThrough.end)).toBeLessThan(0.01)
  expect((await store(page)).past).toBe(beforeTurn.past + 1)
})
