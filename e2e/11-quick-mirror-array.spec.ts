import { test, expect, type Page } from '@playwright/test'
import { openApp, setView, enterDraw, drawMember, clickWorld, store, tool, r } from './helpers'

/** The Space menu at the cursor, and the two moves a cabinet is mostly made of. */

const r3 = (v: number[]) => v.map(r)

async function emptyHand(page: Page) {
  await page.keyboard.press('Escape')
  if ((await tool(page)).held !== null) await page.keyboard.press('Escape')
  expect((await tool(page)).held).toBe(null)
}

async function oneMemberSelected(page: Page) {
  await openApp(page)
  await setView(page, [1200, 900, 1500], [300, 200, 0])
  await enterDraw(page)
  await drawMember(page, [0, 0, 0], [600, 0, 0])
  await emptyHand(page)
  await clickWorld(page, [300, 10, 0])
  expect((await store(page)).selectedIds.length).toBe(1)
}

test.describe('Quick menu', () => {
  test.beforeEach(async ({ page }) => { await oneMemberSelected(page) })

  test('Space opens it at the cursor and Space closes it again', async ({ page }) => {
    await page.mouse.move(800, 400)
    await page.keyboard.press('Space')
    const menu = page.getByTestId('quick-menu')
    await expect(menu).toBeVisible()
    const box = await menu.boundingBox()
    expect(box!.x).toBeGreaterThan(700)
    expect(box!.y).toBeGreaterThan(300)
    await page.keyboard.press('Space')
    await expect(menu).toHaveCount(0)
  })

  test('Escape closes it before it clears the selection', async ({ page }) => {
    await page.mouse.move(800, 400)
    await page.keyboard.press('Space')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('quick-menu')).toHaveCount(0)
    expect((await store(page)).selectedIds.length).toBe(1)
  })

  test('it does not open with nothing selected', async ({ page }) => {
    await page.keyboard.press('Escape')
    expect((await store(page)).selectedIds.length).toBe(0)
    await page.mouse.move(800, 400)
    await page.keyboard.press('Space')
    await expect(page.getByTestId('quick-menu')).toHaveCount(0)
  })

  test('it stays inside the window when opened near the edge', async ({ page }) => {
    const size = page.viewportSize()!
    await page.mouse.move(size.width - 5, size.height - 5)
    await page.keyboard.press('Space')
    const box = await page.getByTestId('quick-menu').boundingBox()
    expect(box!.x + box!.width).toBeLessThanOrEqual(size.width)
    expect(box!.y + box!.height).toBeLessThanOrEqual(size.height)
  })

  test('turning from the menu turns the member and closes it', async ({ page }) => {
    const before = (await store(page)).profiles[0].quaternion
    await page.mouse.move(700, 400)
    await page.keyboard.press('Space')
    await page.getByTestId('quick-rot-y').click()
    await expect(page.getByTestId('quick-menu')).toHaveCount(0)
    expect((await store(page)).profiles[0].quaternion).not.toEqual(before)
  })

  test('the two turn buttons on a row undo each other', async ({ page }) => {
    const q = async () => (await store(page)).profiles[0].quaternion.map((v: number) => Math.round(v * 1000))
    const before = await q()
    await page.mouse.move(700, 400)
    await page.keyboard.press('Space')
    await page.getByTestId('quick-rot-y').click()
    const turned = await q()
    expect(turned).not.toEqual(before)
    await page.mouse.move(700, 400)
    await page.keyboard.press('Space')
    await page.getByTestId('quick-rot-y-back').click()
    expect(await q()).toEqual(before)
  })

  test('duplicate and lock are reachable from the menu', async ({ page }) => {
    await page.mouse.move(700, 400)
    await page.keyboard.press('Space')
    await page.getByTestId('quick-duplicate').click()
    expect((await store(page)).profiles.length).toBe(2)
    await page.mouse.move(700, 400)
    await page.keyboard.press('Space')
    await page.getByTestId('quick-lock').click()
    const locked = await page.evaluate(() => (window as any).__aluframe.store.getState().profiles.filter((p: any) => p.locked).length)
    expect(locked).toBeGreaterThan(0)
  })

  test('a press on the canvas closes it', async ({ page }) => {
    await page.mouse.move(700, 400)
    await page.keyboard.press('Space')
    await expect(page.getByTestId('quick-menu')).toBeVisible()
    await page.mouse.click(400, 600)
    await expect(page.getByTestId('quick-menu')).toHaveCount(0)
  })
})

test.describe('Mirror', () => {
  test.beforeEach(async ({ page }) => { await oneMemberSelected(page) })

  test('mirroring about X adds a copy on the other side and selects it', async ({ page }) => {
    const before = (await store(page)).profiles[0]
    await page.getByTestId('mirror-x').click()
    const after = await store(page)
    expect(after.profiles.length).toBe(2)
    expect(after.selectedIds.length).toBe(1)
    expect(after.selectedIds[0]).not.toBe(before.id)
  })

  test('the plane is the frame\'s, not the selection\'s: a side mirrors to the other side', async ({ page }) => {
    // two rails 600 mm apart in Z; the frame centre is at z = 300
    await page.getByTestId('array-count').fill('1')
    await page.getByTestId('array-spacing').fill('600')
    await page.getByTestId('array-z').click()
    expect((await store(page)).profiles.length).toBe(2)

    // now select just the near rail and mirror it across the frame
    await emptyHand(page)
    await clickWorld(page, [300, 10, 0])
    expect((await store(page)).selectedIds.length).toBe(1)
    await page.getByTestId('mirror-z').click()
    const after = await store(page)
    expect(after.profiles.length).toBe(3)
    // the copy landed on the far side, at the other rail's depth
    const copy = after.profiles[after.profiles.length - 1]
    expect(Math.round(copy.position[2])).toBe(600)
  })

  test('a copy keeps the length and the span of the original', async ({ page }) => {
    const before = (await store(page)).profiles[0]
    await page.getByTestId('mirror-x').click()
    const copy = (await store(page)).profiles[1]
    expect(Math.round(copy.length)).toBe(Math.round(before.length))
    expect(r3(copy.position)[1]).toBe(r3(before.position)[1])
  })

  test('the mirror is one undo step', async ({ page }) => {
    const before = await store(page)
    await page.getByTestId('mirror-x').click()
    expect((await store(page)).profiles.length).toBe(2)
    await page.keyboard.press('Control+z')
    expect((await store(page)).profiles.length).toBe(before.profiles.length)
  })
})

test.describe('Array', () => {
  test.beforeEach(async ({ page }) => { await oneMemberSelected(page) })

  test('three copies 200 mm apart land where they should', async ({ page }) => {
    const before = (await store(page)).profiles[0]
    await page.getByTestId('array-count').fill('3')
    await page.getByTestId('array-spacing').fill('200')
    await page.getByTestId('array-z').click()
    const after = await store(page)
    expect(after.profiles.length).toBe(4)
    const zs = after.profiles.map((p: any) => Math.round(p.position[2])).sort((a: number, b: number) => a - b)
    expect(zs).toEqual([before.position[2], before.position[2] + 200, before.position[2] + 400, before.position[2] + 600].map(Math.round))
  })

  test('the copies are selected, so a second array builds on them', async ({ page }) => {
    await page.getByTestId('array-count').fill('2')
    await page.getByTestId('array-spacing').fill('150')
    await page.getByTestId('array-z').click()
    expect((await store(page)).selectedIds.length).toBe(2)
  })

  test('a whole array is one undo step', async ({ page }) => {
    await page.getByTestId('array-count').fill('4')
    await page.getByTestId('array-spacing').fill('100')
    await page.getByTestId('array-z').click()
    expect((await store(page)).profiles.length).toBe(5)
    await page.keyboard.press('Control+z')
    expect((await store(page)).profiles.length).toBe(1)
  })

  test('a nonsense spacing leaves the buttons dead', async ({ page }) => {
    await page.getByTestId('array-spacing').fill('0')
    await expect(page.getByTestId('array-z')).toBeDisabled()
    await page.getByTestId('array-spacing').fill('300')
    await expect(page.getByTestId('array-z')).toBeEnabled()
  })

  test('the array never sinks below the floor', async ({ page }) => {
    await page.getByTestId('array-count').fill('2')
    await page.getByTestId('array-spacing').fill('-400')
    await page.getByTestId('array-y').click()
    const ys = (await store(page)).profiles.map((p: any) => p.position[1])
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0)
  })

  test('copies come out unlocked even when the original is locked', async ({ page }) => {
    await page.keyboard.press('l')
    await page.getByTestId('array-count').fill('1')
    await page.getByTestId('array-spacing').fill('300')
    await page.getByTestId('array-z').click()
    const after = await store(page)
    expect(after.profiles.length).toBe(2)
    expect(after.profiles.filter((p: any) => p.locked).length).toBe(1)
  })
})
