import { test, expect, type Page } from '@playwright/test'
import { openApp, setView, enterDraw, drawMember, clickWorld, hoverWorld, dragHold, store, tool, w2c } from './helpers'

/**
 * There is no drawing mode any more: the sidebar puts a part in your hand, and an empty hand
 * is the plain canvas. These tests pin the hand down — what fills it, what empties it, and
 * what changes meaning while something is in it.
 */

const cam = (page: Page) => page.evaluate(() => (window as any).__aluframe.camera.position.toArray().map(Math.round))
const camTarget = (page: Page) => page.evaluate(() => {
  const c = (window as any).__aluframe.controls
  return c ? c.target.toArray().map(Math.round) : null
})

async function emptyHand(page: Page) {
  await page.keyboard.press('Escape')
  if ((await tool(page)).held !== null) await page.keyboard.press('Escape')
  expect((await tool(page)).held).toBe(null)
}

test.describe('The hand replaces the draw/navigate modes', () => {
  test.beforeEach(async ({ page }) => { await openApp(page) })

  test('the app starts empty-handed', async ({ page }) => {
    expect((await tool(page)).held).toBe(null)
    await expect(page.getByTestId('held-chip')).toBeDisabled()
  })

  test('picking a profile fills the hand and the chip names it', async ({ page }) => {
    await page.getByTestId('spec-3030').click()
    expect((await tool(page)).held).toBe('profile')
    await expect(page.getByTestId('held-chip')).toContainText('3030')
    await expect(page.getByTestId('held-chip')).toBeEnabled()
  })

  test('clicking the same profile again empties the hand', async ({ page }) => {
    await page.getByTestId('spec-2020').click()
    expect((await tool(page)).held).toBe('profile')
    await page.getByTestId('spec-2020').click()
    expect((await tool(page)).held).toBe(null)
  })

  test('the chip puts the part down', async ({ page }) => {
    await enterDraw(page)
    await page.getByTestId('held-chip').click()
    expect((await tool(page)).held).toBe(null)
    await expect(page.getByTestId('held-chip')).toBeDisabled()
  })

  test('Escape empties the hand, and a second Escape clears the selection', async ({ page }) => {
    await enterDraw(page)
    await drawMember(page, [0, 0, 0], [600, 0, 0])
    expect((await tool(page)).held).toBe('profile')
    await page.keyboard.press('Escape')
    expect((await tool(page)).held).toBe(null)
    // still selectable with an empty hand
    await clickWorld(page, [300, 10, 0])
    expect((await store(page)).selectedIds.length).toBe(1)
    await page.keyboard.press('Escape')
    expect((await store(page)).selectedIds.length).toBe(0)
  })

  test('a half-drawn line is abandoned before the hand is emptied', async ({ page }) => {
    await enterDraw(page)
    await clickWorld(page, [0, 0, 0])
    expect((await tool(page)).isDrawing).toBe(true)
    await page.keyboard.press('Escape')
    expect((await tool(page)).isDrawing).toBe(false)
    expect((await tool(page)).held).toBe('profile')   // the part is still in hand
    await page.keyboard.press('Escape')
    expect((await tool(page)).held).toBe(null)
  })

  test('a connector in hand replaces a profile in hand', async ({ page }) => {
    await enterDraw(page)
    expect((await tool(page)).held).toBe('profile')
    await page.getByTestId('connector-bracket').click()
    expect((await tool(page)).held).toBe('connector')
    await page.getByTestId('spec-2020').click()
    expect((await tool(page)).held).toBe('profile')
  })
})

test.describe('One button mapping for the whole canvas', () => {
  test.beforeEach(async ({ page }) => { await openApp(page) })

  test('right-drag pans with an empty hand', async ({ page }) => {
    await enterDraw(page)
    await drawMember(page, [0, 0, 0], [600, 0, 0])
    await emptyHand(page)
    const before = await camTarget(page)
    await page.mouse.move(700, 400)
    await page.mouse.down({ button: 'right' })
    for (let i = 1; i <= 6; i++) { await page.mouse.move(700 + i * 15, 400); await page.waitForTimeout(15) }
    await page.mouse.up({ button: 'right' })
    const after = await camTarget(page)
    expect(after).not.toEqual(before)
  })

  test('right-drag pans the same way with a part in hand', async ({ page }) => {
    await enterDraw(page)
    const before = await camTarget(page)
    await page.mouse.move(700, 400)
    await page.mouse.down({ button: 'right' })
    for (let i = 1; i <= 6; i++) { await page.mouse.move(700 + i * 15, 400); await page.waitForTimeout(15) }
    await page.mouse.up({ button: 'right' })
    expect(await camTarget(page)).not.toEqual(before)
    expect((await tool(page)).held).toBe('profile')   // panning never empties the hand
  })

  test('a right click still cancels a half-drawn line', async ({ page }) => {
    await enterDraw(page)
    await clickWorld(page, [0, 0, 0])
    expect((await tool(page)).isDrawing).toBe(true)
    await clickWorld(page, [300, 0, 0], { button: 'right' })
    expect((await tool(page)).isDrawing).toBe(false)
  })

  test('left-drag on empty space orbits whatever is in hand', async ({ page }) => {
    await enterDraw(page)
    const before = await cam(page)
    await dragHold(page, { x: 900, y: 300 }, { x: 1010, y: 340 })
    await page.mouse.up()
    expect(await cam(page)).not.toEqual(before)
    expect((await store(page)).profiles.length).toBe(0)   // the orbit drew nothing
  })
})

test.describe('End faces mean different things in each hand', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await setView(page, [1200, 900, 1500], [300, 200, 0])
    await enterDraw(page)
    await drawMember(page, [0, 0, 0], [600, 0, 0])
  })

  test('with an empty hand the end of the selected member offers the stretch grip', async ({ page }) => {
    await emptyHand(page)
    await clickWorld(page, [300, 10, 0])
    await hoverWorld(page, [595, 10, 0])
    expect((await tool(page)).hoverEnd).not.toBe(null)
  })

  test('with a part in hand the same end offers nothing to stretch', async ({ page }) => {
    await emptyHand(page)
    await clickWorld(page, [300, 10, 0])
    await page.getByTestId('spec-2020').click()
    await hoverWorld(page, [595, 10, 0])
    expect((await tool(page)).hoverEnd).toBe(null)
  })

  test('with a part in hand a click on an end face starts a line there', async ({ page }) => {
    const before = (await store(page)).profiles.length
    await clickWorld(page, [600, 10, 0])
    expect((await tool(page)).isDrawing).toBe(true)
    const s = (await tool(page)).start!
    expect(Math.abs(s[0] - 600)).toBeLessThan(40)
    expect((await store(page)).profiles.length).toBe(before)
  })
})

test.describe('Selecting and editing never needed an empty hand', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await setView(page, [1200, 900, 1500], [300, 200, 0])
    await enterDraw(page)
    await drawMember(page, [0, 0, 0], [600, 0, 0])
  })

  test('a member can be dragged with a part still in hand', async ({ page }) => {
    const id = (await store(page)).profiles[0].id
    const from = await w2c(page, [300, 10, 0])
    await dragHold(page, from, { x: from.x, y: from.y - 60 })
    await page.mouse.up()
    const after = (await store(page)).profiles.find((p) => p.id === id)!
    expect(after.position).not.toEqual([0, 0, 0])
    expect((await store(page)).profiles.length).toBe(1)   // no stray member was drawn
  })

  test('the gizmo stays on the selection after a part is picked up', async ({ page }) => {
    await emptyHand(page)
    await clickWorld(page, [300, 10, 0])
    expect((await store(page)).selectedIds.length).toBe(1)
    await page.getByTestId('spec-2020').click()      // hand filled again
    await page.waitForTimeout(150)
    const handles = await page.evaluate(() => ((window as any).__aluframe.gizmoHandles?.() ?? []).length)
    expect(handles).toBe(6)
    expect((await store(page)).selectedIds.length).toBe(1)   // picking a part keeps the selection
  })
})
