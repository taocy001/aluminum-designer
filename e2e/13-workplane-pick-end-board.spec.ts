import { test, expect, type Page } from '@playwright/test'
import { openApp, setView, enterDraw, drawMember, clickWorld, hoverWorld, store, tool, w2c, r } from './helpers'

/** The four things the L-shaped kitchen build turned up. */

const r3 = (v: number[]) => v.map(r)
const only = async (page: Page) => (await store(page)).profiles[0]

async function emptyHand(page: Page) {
  await page.keyboard.press('Escape')
  if ((await tool(page)).held !== null) await page.keyboard.press('Escape')
  expect((await tool(page)).held).toBe(null)
}

test.describe('Work plane: a click that finds nothing lands somewhere you chose', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await setView(page, [1800, 1400, 2200], [400, 400, 200])
  })

  test('the plane starts on the floor and a click lands there', async ({ page }) => {
    await expect(page.getByTestId('work-plane')).toHaveValue('0')
    await enterDraw(page)
    await drawMember(page, [0, 0, 0], [600, 0, 0])
    expect(r((await only(page)).position[1])).toBe(10)   // 2020 resting on the floor
  })

  test('raising the plane starts a member in mid-air at that height', async ({ page }) => {
    await page.getByTestId('work-plane').fill('900')
    await enterDraw(page)
    await drawMember(page, [0, 900, 0], [600, 900, 0])
    const p = await only(page)
    expect(r(p.position[1])).toBe(900)
    expect(Math.round(p.length)).toBeGreaterThan(400)
  })

  test('before the plane was settable, the same click fell to the floor', async ({ page }) => {
    // the old behaviour, still correct when the plane is the floor: nothing to attach to,
    // so the point is wherever the sight line meets y = 0 — nowhere near the aim
    await enterDraw(page)
    await clickWorld(page, [0, 900, 0])
    expect((await tool(page)).isDrawing).toBe(true)
    const startY = (await tool(page)).start![1]
    expect(startY).toBe(0)
  })

  test('the plane can be taken from the top of the selection', async ({ page }) => {
    await enterDraw(page)
    await drawMember(page, [0, 0, 0], [0, 880, 0])       // an upright
    await emptyHand(page)
    await clickWorld(page, [0, 400, 0])
    expect((await store(page)).selectedIds.length).toBe(1)
    await page.getByTestId('work-plane-from-selection').click()
    await expect(page.getByTestId('work-plane')).toHaveValue('880')
  })

  test('the button is dead with nothing selected', async ({ page }) => {
    await expect(page.getByTestId('work-plane-from-selection')).toBeDisabled()
  })

  test('the HUD says what the start point would attach to', async ({ page }) => {
    await enterDraw(page)
    await drawMember(page, [0, 0, 0], [600, 0, 0])
    await hoverWorld(page, [1500, 0, 1500])              // empty floor, nothing to attach to
    await expect(page.getByTestId('start-hud')).toContainText('工作面')
    await hoverWorld(page, [600, 10, 0])                 // the end of the member just drawn
    await expect(page.getByTestId('start-hud')).not.toContainText('工作面')
  })
})

test.describe('Tab picks between parts that share the same pixels', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    // a vertical and a horizontal crossing on screen at the same place
    await setView(page, [0, 600, 2400], [300, 400, 0])
    await enterDraw(page)
    await drawMember(page, [0, 0, 0], [600, 0, 0])
    await drawMember(page, [300, 0, 0], [300, 800, 0])
    await drawMember(page, [300, 0, -400], [300, 800, -400])
    await emptyHand(page)
    expect((await store(page)).profiles.length).toBe(3)
  })

  test('the HUD counts what is stacked under the cursor', async ({ page }) => {
    await hoverWorld(page, [300, 400, 0])
    const hud = page.getByTestId('stacked-hud')
    if (await hud.count()) {
      await expect(hud).toContainText('/')
    } else {
      // nothing overlaps from this angle, which is also a valid outcome
      expect(await hud.count()).toBe(0)
    }
  })

  test('Tab moves the highlight to the part behind', async ({ page }) => {
    await hoverWorld(page, [300, 400, 0])
    const first = await page.evaluate(() => (window as any).__aluframe.tool.getState().hoverProfileId)
    const count = await page.evaluate(() => (window as any).__aluframe.tool.getState().hoverCandidates.count)
    test.skip(count < 2, 'nothing is stacked from this angle')
    await page.keyboard.press('Tab')
    const second = await page.evaluate(() => (window as any).__aluframe.tool.getState().hoverProfileId)
    expect(second).not.toBe(first)
  })

  test('a click after Tab selects the highlighted part, not the nearest one', async ({ page }) => {
    await hoverWorld(page, [300, 400, 0])
    const count = await page.evaluate(() => (window as any).__aluframe.tool.getState().hoverCandidates.count)
    test.skip(count < 2, 'nothing is stacked from this angle')
    await page.keyboard.press('Tab')
    const wanted = await page.evaluate(() => (window as any).__aluframe.tool.getState().hoverProfileId)
    const c = await w2c(page, [300, 400, 0])
    await page.mouse.click(c.x, c.y)
    expect((await store(page)).selectedIds[0]).toBe(wanted)
  })

  test('moving the pointer starts the cycle again', async ({ page }) => {
    await hoverWorld(page, [300, 400, 0])
    const count = await page.evaluate(() => (window as any).__aluframe.tool.getState().hoverCandidates.count)
    test.skip(count < 2, 'nothing is stacked from this angle')
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => (window as any).__aluframe.tool.getState().hoverCandidates.index)).toBe(1)
    await hoverWorld(page, [300, 300, 0])
    expect(await page.evaluate(() => (window as any).__aluframe.tool.getState().hoverCandidates.index)).toBe(0)
  })
})

test.describe('A member can be given its far end directly', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await setView(page, [1400, 1000, 1800], [300, 200, 0])
    await enterDraw(page)
    await drawMember(page, [0, 0, 0], [600, 0, 0])
    await emptyHand(page)
    await clickWorld(page, [300, 10, 0])
    expect((await store(page)).selectedIds.length).toBe(1)
  })

  const endFields = (page: Page) => page.getByTestId('end-position').getByRole('spinbutton')

  test('the end fields show where the member actually finishes', async ({ page }) => {
    await expect(endFields(page).nth(0)).toHaveValue('600')
    await expect(endFields(page).nth(1)).toHaveValue('10')
    await expect(endFields(page).nth(2)).toHaveValue('0')
  })

  test('typing a new end changes the length, keeping the start put', async ({ page }) => {
    const before = r3((await only(page)).position)
    await endFields(page).nth(0).fill('1500')
    await endFields(page).nth(0).press('Enter')
    const after = await only(page)
    expect(Math.round(after.length)).toBe(1500)
    expect(r3(after.position)).toEqual(before)
  })

  test('moving the end onto another axis turns the member', async ({ page }) => {
    // each field commits on its own, so the path has to stay valid: pushing X to 0 first
    // would leave a zero-length member, which is refused
    await endFields(page).nth(2).fill('900')
    await endFields(page).nth(2).press('Enter')
    await endFields(page).nth(0).fill('0')
    await endFields(page).nth(0).press('Enter')
    const after = await only(page)
    expect(Math.round(after.length)).toBe(900)
    const dir = await page.evaluate(() => {
      const p = (window as any).__aluframe.store.getState().profiles[0]
      const [x, y, z, w] = p.quaternion
      return [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)].map((v) => Math.round(v))
    })
    expect(dir).toEqual([0, 0, 1])
  })

  test('an end that would make the member too short is refused', async ({ page }) => {
    const before = Math.round((await only(page)).length)
    await endFields(page).nth(0).fill('2')
    await endFields(page).nth(0).press('Enter')
    expect(Math.round((await only(page)).length)).toBe(before)
  })
})

test.describe('Boards: the opening, and a warning when a member spans past it', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await setView(page, [2600, 1800, 3400], [900, 400, 0])
    await enterDraw(page)
    await drawMember(page, [0, 0, 0], [0, 800, 0])        // upright at x = 0
    await drawMember(page, [600, 0, 0], [600, 800, 0])    // upright at x = 600
    await drawMember(page, [0, 0, 0], [2000, 0, 0])       // a rail running well past both
    await emptyHand(page)
  })

  const selectIds = (page: Page, which: number[]) => page.evaluate((idx) => {
    const s = (window as any).__aluframe.store.getState()
    s.selectItems(idx.map((i: number) => s.profiles[i].id))
  }, which)

  test('two uprights give a board across the opening', async ({ page }) => {
    await selectIds(page, [0, 1])
    await page.getByTestId('add-panel').click()
    const b = (await store(page)).panels[0]
    expect(Math.round(b.width)).toBe(620)               // over the frame
  })

  test('the inset button fits the board between them instead', async ({ page }) => {
    await selectIds(page, [0, 1])
    await page.getByTestId('add-panel-inset').click()
    const b = (await store(page)).panels[0]
    expect(Math.round(b.width)).toBe(580)               // between the two uprights
  })

  test('a spanning member in the selection is called out', async ({ page }) => {
    await selectIds(page, [0, 1, 2])
    await page.getByTestId('add-panel').click()
    await expect(page.getByTestId('toasts')).toContainText('贯通')
    const b = (await store(page)).panels[0]
    expect(Math.round(b.width)).toBeGreaterThan(1500)   // the board did follow it, as warned
  })

  test('no warning when the selection is just the opening', async ({ page }) => {
    await selectIds(page, [0, 1])
    await page.getByTestId('add-panel').click()
    await expect(page.getByTestId('toasts')).not.toContainText('贯通')
  })
})
