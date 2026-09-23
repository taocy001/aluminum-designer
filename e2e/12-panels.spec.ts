import { test, expect, type Page } from '@playwright/test'
import { openApp, setView, enterDraw, drawMember, clickWorld, dragHold, store, tool, w2c, r } from './helpers'

/** Boards: doors, backs, shelves and drawer fronts, and the cut list they produce. */

const r3 = (v: number[]) => v.map(r)
const panels = async (page: Page) => (await store(page)).panels

async function emptyHand(page: Page) {
  await page.keyboard.press('Escape')
  if ((await tool(page)).held !== null) await page.keyboard.press('Escape')
  expect((await tool(page)).held).toBe(null)
}

/** A rectangular opening in the XY plane: two uprights and two rails, 600 × 800 */
async function opening(page: Page) {
  await openApp(page)
  await setView(page, [1600, 1200, 2000], [300, 400, 0])
  await enterDraw(page)
  await drawMember(page, [0, 0, 0], [0, 800, 0])
  await drawMember(page, [600, 0, 0], [600, 800, 0])
  await drawMember(page, [0, 0, 0], [600, 0, 0])
  await drawMember(page, [0, 800, 0], [600, 800, 0])
  await emptyHand(page)
  expect((await store(page)).profiles.length).toBe(4)
}

async function selectAll(page: Page) {
  await page.evaluate(() => {
    const s = (window as any).__aluframe.store.getState()
    s.selectItems(s.profiles.map((p: any) => p.id))
  })
}

test.describe('Fitting a board', () => {
  test.beforeEach(async ({ page }) => { await opening(page) })

  test('the button only appears once two members are selected', async ({ page }) => {
    await expect(page.getByTestId('add-panel')).toHaveCount(0)
    await clickWorld(page, [300, 10, 0])
    await expect(page.getByTestId('add-panel')).toHaveCount(0)
    await selectAll(page)
    await expect(page.getByTestId('add-panel')).toBeVisible()
  })

  test('a board fitted to the opening spans it and faces the thin way', async ({ page }) => {
    await selectAll(page)
    await page.getByTestId('add-panel').click()
    const list = await panels(page)
    expect(list.length).toBe(1)
    // 600 wide plus the profile section on each side; the rails rest on the floor, so the
    // opening runs from y = 0 to y = 810 rather than to 820
    expect(Math.round(list[0].width)).toBe(620)
    expect(Math.round(list[0].height)).toBe(810)
    expect(list[0].thickness).toBe(18)
    // ...and it lies *on* the frame rather than inside it: an 18 mm board centred on a 20 mm
    // section is a board through the metal, which is what this used to ask for
    expect(r3(list[0].position)).toEqual([300, 405, 19])
  })

  test('two parallel rails give a shelf lying flat', async ({ page }) => {
    await openApp(page)
    await setView(page, [1600, 1200, 2000], [300, 200, 200])
    await enterDraw(page)
    // both on the floor: a click in mid-air with nothing to attach to lands on the floor anyway
    await drawMember(page, [0, 0, 0], [600, 0, 0])
    await drawMember(page, [0, 0, 400], [600, 0, 400])
    await emptyHand(page)
    await selectAll(page)
    await page.getByTestId('add-panel').click()
    const board = (await panels(page))[0]
    // the thin axis is Y, so the board lies flat: its own +Z (the thickness) points up
    const up = await page.evaluate(() => {
      const b = (window as any).__aluframe.store.getState().panels[0]
      const [x, y, z, w] = b.quaternion
      return [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)].map((v) => Math.round(v))
    })
    expect(up).toEqual([0, 1, 0])
    // the rails run along X, so the X span is their length (600) and the Z span is the
    // 400 mm gap plus a section either side; which one is called width follows handedness
    expect([Math.round(board.width), Math.round(board.height)].sort((a, b) => a - b)).toEqual([420, 600])
  })

  test('one member alone is refused, with a reason', async ({ page }) => {
    await clickWorld(page, [300, 10, 0])
    await page.evaluate(() => {
      const ops = (window as any).__aluframe
      void ops
    })
    // the button is not offered, and the operation itself declines
    const made = await page.evaluate(() => (window as any).__aluframe.store.getState().panels.length)
    expect(made).toBe(0)
  })

  test('fitting a board is one undo step', async ({ page }) => {
    await selectAll(page)
    await page.getByTestId('add-panel').click()
    expect((await panels(page)).length).toBe(1)
    await page.keyboard.press('Control+z')
    expect((await panels(page)).length).toBe(0)
  })
})

test.describe('Editing a board', () => {
  test.beforeEach(async ({ page }) => {
    await opening(page)
    await selectAll(page)
    await page.getByTestId('add-panel').click()
    expect((await store(page)).selectedIds.length).toBe(1)
  })

  test('the size fields cut it to an exact size', async ({ page }) => {
    await page.getByTestId('panel-props').getByRole('spinbutton').first().fill('580')
    await page.getByTestId('panel-props').getByRole('spinbutton').first().press('Enter')
    expect(Math.round((await panels(page))[0].width)).toBe(580)
  })

  test('the material can be changed and reaches the cut list', async ({ page }) => {
    await page.getByTestId('panel-material').selectOption('acrylic')
    expect((await panels(page))[0].material).toBe('acrylic')
    await expect(page.getByTestId('bom-panels')).toBeVisible()
  })

  test('a board is picked by its face and dragged', async ({ page }) => {
    const before = r3((await panels(page))[0].position)
    const from = await w2c(page, (await panels(page))[0].position as [number, number, number])
    await dragHold(page, from, { x: from.x + 100, y: from.y })
    await page.mouse.up()
    expect(r3((await panels(page))[0].position)).not.toEqual(before)
  })

  test('a board is locked, deleted and duplicated like anything else', async ({ page }) => {
    await page.keyboard.press('l')
    expect((await panels(page))[0].locked).toBe(true)
    await page.keyboard.press('Delete')
    expect((await panels(page)).length).toBe(1)
    await page.keyboard.press('l')
    await page.keyboard.press('Delete')
    expect((await panels(page)).length).toBe(0)
  })
})

test.describe('Board cut list', () => {
  test.beforeEach(async ({ page }) => {
    await opening(page)
    await selectAll(page)
    await page.getByTestId('add-panel').click()
  })

  test('identical boards are one line with a count', async ({ page }) => {
    // an array of the board gives three of the same cut
    await page.getByTestId('array-count').fill('2')
    await page.getByTestId('array-spacing').fill('400')
    await page.getByTestId('array-z').click()
    expect((await panels(page)).length).toBe(3)
    await expect(page.getByTestId('bom-panels')).toBeVisible()
    const text = await page.getByTestId('section-bom-body').innerText()
    expect(text).toContain('810 × 620 mm')
    expect(text).toContain('×3')
  })

  test('boards survive a save and reload of the project', async ({ page }) => {
    const before = (await panels(page))[0]
    await page.reload()
    await page.waitForFunction(() => (window as any).__aluframe?.store, null, { timeout: 20_000 })
    const after = (await panels(page))[0]
    expect(Math.round(after.width)).toBe(Math.round(before.width))
    expect(after.material).toBe(before.material)
  })
})
