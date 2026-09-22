import { test, expect, type Page } from '@playwright/test'
import { openApp, setView, enterDraw, drawMember, clickWorld, dragHold, store, tool, w2c, r } from './helpers'

/** `r` rounds one number; positions are triples */
const r3 = (v: number[]) => v.map(r)

/** Precision and protection: where a turn happens, typing an exact number, and locking. */

async function emptyHand(page: Page) {
  await page.keyboard.press('Escape')
  if ((await tool(page)).held !== null) await page.keyboard.press('Escape')
  expect((await tool(page)).held).toBe(null)
}
const only = async (page: Page) => (await store(page)).profiles[0]
const pivot = (page: Page) => page.evaluate(() => (window as any).__aluframe.tool.getState().pivotMode)

/** Both ends of the single member, rounded */
async function ends(page: Page) {
  return page.evaluate(() => {
    const p = (window as any).__aluframe.store.getState().profiles[0]
    const THREE = (window as any).__aluframe.three
    const q = p.quaternion
    // start is the position; end is start + dir * length, dir being +Z turned by the quaternion
    const [x, y, z, w] = q
    const d = [
      2 * (x * z + w * y),
      2 * (y * z - w * x),
      1 - 2 * (x * x + y * y),
    ]
    void THREE
    return {
      start: p.position.map((v: number) => Math.round(v)),
      end: [0, 1, 2].map((i) => Math.round(p.position[i] + d[i] * p.length)),
    }
  })
}

test.describe('Rotation pivot', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await setView(page, [1200, 900, 1500], [300, 200, 0])
    await enterDraw(page)
    await drawMember(page, [0, 0, 0], [600, 0, 0])
    await emptyHand(page)
    await clickWorld(page, [300, 10, 0])
    expect((await store(page)).selectedIds.length).toBe(1)
  })

  test('the default pivot is the centre, and a turn keeps the midpoint', async ({ page }) => {
    expect(await pivot(page)).toBe('center')
    const before = await ends(page)
    const midBefore = [0, 1, 2].map((i) => (before.start[i] + before.end[i]) / 2)
    await page.keyboard.press('r')
    const after = await ends(page)
    const midAfter = [0, 1, 2].map((i) => (after.start[i] + after.end[i]) / 2)
    // the floor rule may lift the member, so only the horizontal midpoint is pinned
    expect(Math.abs(midAfter[0] - midBefore[0])).toBeLessThan(2)
    expect(Math.abs(midAfter[2] - midBefore[2])).toBeLessThan(2)
  })

  test('P cycles centre → start → end → centre', async ({ page }) => {
    await page.keyboard.press('p')
    expect(await pivot(page)).toBe('start')
    await page.keyboard.press('p')
    expect(await pivot(page)).toBe('end')
    await page.keyboard.press('p')
    expect(await pivot(page)).toBe('center')
  })

  test('the toolbar button cycles it too', async ({ page }) => {
    // the toolbar is icons: the button carries no text, only the state behind it
    expect(await pivot(page)).toBe('center')
    await page.getByTestId('pivot-toggle').click()
    expect(await pivot(page)).toBe('start')
    await page.getByTestId('pivot-toggle').click()
    expect(await pivot(page)).toBe('end')
  })

  test('turning about the start leaves the start where it was', async ({ page }) => {
    await page.keyboard.press('p')
    expect(await pivot(page)).toBe('start')
    const before = await ends(page)
    await page.keyboard.press('r')
    const after = await ends(page)
    expect(Math.abs(after.start[0] - before.start[0])).toBeLessThan(2)
    expect(Math.abs(after.start[2] - before.start[2])).toBeLessThan(2)
    expect(after.end).not.toEqual(before.end)   // the free end is the one that swings
  })

  test('turning about the end leaves the end where it was', async ({ page }) => {
    await page.keyboard.press('p'); await page.keyboard.press('p')
    expect(await pivot(page)).toBe('end')
    const before = await ends(page)
    await page.keyboard.press('r')
    const after = await ends(page)
    expect(Math.abs(after.end[0] - before.end[0])).toBeLessThan(2)
    expect(Math.abs(after.end[2] - before.end[2])).toBeLessThan(2)
  })

  test('the gizmo moves onto the pivot, so the choice is visible', async ({ page }) => {
    await page.waitForTimeout(150)
    const at = () => page.evaluate(() => {
      const h = (window as any).__aluframe.gizmoHandles?.() ?? []
      return h.length ? h[0].position.map((v: number) => Math.round(v)) : null
    })
    const centre = await at()
    await page.keyboard.press('p')
    await page.waitForTimeout(150)
    expect(await at()).not.toEqual(centre)
  })
})

test.describe('Exact values mid-gesture', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await setView(page, [1200, 900, 1500], [300, 200, 0])
    await enterDraw(page)
    await drawMember(page, [0, 0, 0], [600, 0, 0])
    await emptyHand(page)
    await clickWorld(page, [300, 10, 0])
  })

  test('typing a distance mid-drag finishes the move at exactly that distance', async ({ page }) => {
    const before = await only(page)
    const from = await w2c(page, [300, 10, 0])
    await dragHold(page, from, { x: from.x + 90, y: from.y })
    await expect(page.getByTestId('exact-hud')).toBeVisible()
    await page.getByTestId('exact-input').fill('250')
    await page.getByTestId('exact-input').press('Enter')
    await page.mouse.up()
    const after = await only(page)
    const moved = Math.hypot(
      after.position[0] - before.position[0],
      after.position[1] - before.position[1],
      after.position[2] - before.position[2],
    )
    expect(Math.abs(moved - 250)).toBeLessThan(1)
    expect((await tool(page)).isDragging).toBe(false)
  })

  test('the exact box only appears once the drag has actually travelled', async ({ page }) => {
    const from = await w2c(page, [300, 10, 0])
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await expect(page.getByTestId('exact-hud')).toHaveCount(0)
    await page.mouse.up()
  })

  test('an exact move is one undo step', async ({ page }) => {
    const before = await store(page)
    const from = await w2c(page, [300, 10, 0])
    await dragHold(page, from, { x: from.x + 90, y: from.y })
    await page.getByTestId('exact-input').fill('150')
    await page.getByTestId('exact-input').press('Enter')
    await page.mouse.up()
    expect((await store(page)).past).toBe(before.past + 1)
    await page.keyboard.press('Control+z')
    expect(r3((await only(page)).position)).toEqual(r3(before.profiles[0].position))
  })

  test('typing a length mid-stretch sets the member to exactly that length', async ({ page }) => {
    const from = await w2c(page, [598, 10, 0])
    await dragHold(page, from, { x: from.x + 60, y: from.y })
    await expect(page.getByTestId('exact-hud')).toBeVisible()
    await page.getByTestId('exact-input').fill('820')
    await page.getByTestId('exact-input').press('Enter')
    await page.mouse.up()
    expect(Math.abs((await only(page)).length - 820)).toBeLessThan(0.5)
  })

  test('a stretch to an exact length keeps the fixed end put and is one undo step', async ({ page }) => {
    const before = await store(page)
    const start = before.profiles[0].position
    const from = await w2c(page, [598, 10, 0])
    await dragHold(page, from, { x: from.x + 60, y: from.y })
    await page.getByTestId('exact-input').fill('900')
    await page.getByTestId('exact-input').press('Enter')
    await page.mouse.up()
    expect(r3((await only(page)).position)).toEqual(r3(start))
    expect((await store(page)).past).toBe(before.past + 1)
  })
})

test.describe('Locked parts', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await setView(page, [1200, 900, 1500], [300, 200, 0])
    await enterDraw(page)
    await drawMember(page, [0, 0, 0], [600, 0, 0])
    await emptyHand(page)
    await clickWorld(page, [300, 10, 0])
    expect((await store(page)).selectedIds.length).toBe(1)
  })

  const locked = (page: Page) => page.evaluate(() => !!(window as any).__aluframe.store.getState().profiles[0].locked)

  test('L locks the selection and locks it again off', async ({ page }) => {
    await page.keyboard.press('l')
    expect(await locked(page)).toBe(true)
    await page.keyboard.press('l')
    expect(await locked(page)).toBe(false)
  })

  test('the panel button locks it and the trash button goes dead', async ({ page }) => {
    await page.getByTestId('lock-toggle').click()
    expect(await locked(page)).toBe(true)
    await expect(page.getByTestId('delete-selected')).toBeDisabled()
  })

  test('a locked member cannot be dragged', async ({ page }) => {
    await page.keyboard.press('l')
    const before = r3((await only(page)).position)
    const from = await w2c(page, [300, 10, 0])
    await dragHold(page, from, { x: from.x + 120, y: from.y - 40 })
    await page.mouse.up()
    expect(r3((await only(page)).position)).toEqual(before)
  })

  test('Delete leaves a locked member alone', async ({ page }) => {
    await page.keyboard.press('l')
    await page.keyboard.press('Delete')
    expect((await store(page)).profiles.length).toBe(1)
  })

  test('arrow keys and R leave a locked member alone', async ({ page }) => {
    await page.keyboard.press('l')
    const before = await only(page)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('r')
    const after = await only(page)
    expect(r3(after.position)).toEqual(r3(before.position))
    expect(after.quaternion.map((v: number) => Math.round(v * 100))).toEqual(before.quaternion.map((v: number) => Math.round(v * 100)))
  })

  test('a locked member shows no stretch grip and no gizmo', async ({ page }) => {
    await page.keyboard.press('l')
    await page.waitForTimeout(150)
    const handles = await page.evaluate(() => ((window as any).__aluframe.gizmoHandles?.() ?? []).length)
    expect(handles).toBe(0)
  })

  test('unlocking gives everything back', async ({ page }) => {
    await page.keyboard.press('l')
    await page.keyboard.press('l')
    await page.waitForTimeout(150)
    const handles = await page.evaluate(() => ((window as any).__aluframe.gizmoHandles?.() ?? []).length)
    expect(handles).toBe(6)
    const before = r3((await only(page)).position)
    await page.keyboard.press('ArrowRight')
    expect(r3((await only(page)).position)).not.toEqual(before)
  })

  test('a locked member is still a snapping reference for the one being moved', async ({ page }) => {
    await page.keyboard.press('l')
    await emptyHand(page)
    await page.keyboard.press('Escape')
    await enterDraw(page)
    await drawMember(page, [0, 0, 400], [600, 0, 400])
    await emptyHand(page)
    const moving = (await store(page)).profiles[1]
    await clickWorld(page, [300, 10, 400])
    const from = await w2c(page, [300, 10, 400])
    const to = await w2c(page, [300, 10, 30])
    await dragHold(page, from, to)
    const guides = await page.evaluate(() => (window as any).__aluframe.tool.getState().snapGuides.length)
    await page.mouse.up()
    expect(guides).toBeGreaterThan(0)
    expect(moving.id).toBeTruthy()
  })
})
