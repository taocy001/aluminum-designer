import { test, expect } from '@playwright/test'
import { openApp, settle, store, setView } from './helpers'

/** An empty canvas asks you to know the answer before you have seen one */
test.describe('Starting from something', () => {
  test.beforeEach(async ({ page }) => openApp(page))

  for (const id of ['bench', 'shelving', 'cabinet', 'rack', 'table']) {
    test(`${id} lands, and lands buildable`, async ({ page }) => {
      await page.getByTestId(`template-${id}`).click()
      await settle(page)
      await page.getByTestId('template-place').click()
      await settle(page)
      await page.waitForTimeout(300)
      const s = await store(page)
      expect(s.profiles.length).toBeGreaterThan(3)
      expect(await page.evaluate(() => (window as any).__aluframe.conflicts().conflicts.length)).toBe(0)
      expect(await page.evaluate(() => (window as any).__aluframe.unflush())).toBe(0)
    })
  }

  test('its numbers are yours to change before placing it', async ({ page }) => {
    await page.getByTestId('template-shelving').click()
    await settle(page)
    const f = page.getByTestId('template-block').locator('input[type=number]')
    await f.nth(2).fill('7')
    await f.nth(2).press('Enter')
    await settle(page)
    await page.getByTestId('template-place').click()
    await settle(page)
    await page.waitForTimeout(300)
    const withSeven = (await store(page)).profiles.length
    await page.evaluate(() => (window as any).__aluframe.store.getState().clearAll())
    await page.getByTestId('template-shelving').click()
    await settle(page)
    await page.getByTestId('template-place').click()
    await settle(page)
    await page.waitForTimeout(300)
    expect(withSeven).toBeGreaterThan((await store(page)).profiles.length)
  })

  test('what it places is ordinary: selectable, movable, deletable', async ({ page }) => {
    await page.getByTestId('template-cabinet').click()
    await settle(page)
    await page.getByTestId('template-place').click()
    await settle(page)
    await page.waitForTimeout(300)
    const before = (await store(page)).profiles.length
    expect((await store(page)).selectedIds.length).toBe(before)
    await page.keyboard.press('ArrowRight')
    await settle(page)
    await page.keyboard.press('Delete')
    await settle(page)
    expect((await store(page)).profiles.length).toBe(0)
  })

  test('placing one is a single undo', async ({ page }) => {
    await page.getByTestId('template-cabinet').click()
    await settle(page)
    await page.getByTestId('template-place').click()
    await settle(page)
    await page.waitForTimeout(300)
    expect((await store(page)).profiles.length).toBeGreaterThan(0)
    await page.keyboard.press('Control+z')
    await settle(page)
    expect((await store(page)).profiles.length).toBe(0)
  })
})

/** "How far is that from that" is the question a drawing gets asked most */
test.describe('Measuring', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await page.getByTestId('template-shelving').click()
    await settle(page)
    await page.getByTestId('template-place').click()
    await settle(page)
    await page.waitForTimeout(300)
    await page.keyboard.press('Escape')
    await setView(page, [1600, 1200, 1900], [450, 500, 200])
  })

  const measured = (page: import('@playwright/test').Page) => page.evaluate(() => {
    const m = (window as any).__aluframe.tool.getState().measuring
    if (!m?.from || !m?.to) return null
    return Math.round(m.to.clone().sub(m.from).length())
  })

  const clickWorldPoint = async (page: import('@playwright/test').Page, p: number[]) => {
    const c = await page.evaluate((pt) => (window as any).__aluframe.worldToClient(pt[0], pt[1], pt[2]), p)
    await page.mouse.click(c.x, c.y)
    await page.waitForTimeout(200)
  }

  test('two clicks give the distance between them', async ({ page }) => {
    await page.getByTestId('measure-toggle').click()
    await settle(page)
    await clickWorldPoint(page, [0, 40, 0])
    await clickWorldPoint(page, [900, 40, 0])
    expect(await measured(page)).toBe(900)
  })

  test('it snaps to the frame, so the number is the one it is built to', async ({ page }) => {
    await page.getByTestId('measure-toggle').click()
    await settle(page)
    // aimed a few millimetres off the members, and still reads the round number
    await clickWorldPoint(page, [3, 43, 2])
    await clickWorldPoint(page, [897, 42, 1])
    expect(await measured(page)).toBe(900)
  })

  test('a third click starts a new measurement', async ({ page }) => {
    await page.getByTestId('measure-toggle').click()
    await settle(page)
    await clickWorldPoint(page, [0, 40, 0])
    await clickWorldPoint(page, [900, 40, 0])
    await clickWorldPoint(page, [0, 40, 400])
    expect(await measured(page)).toBe(null)
    await clickWorldPoint(page, [900, 40, 400])
    expect(await measured(page)).toBe(900)
  })

  test('Escape puts the tape measure away', async ({ page }) => {
    await page.getByTestId('measure-toggle').click()
    await settle(page)
    await clickWorldPoint(page, [0, 40, 0])
    await page.keyboard.press('Escape')
    await settle(page)
    expect(await page.evaluate(() => (window as any).__aluframe.tool.getState().measuring)).toBe(null)
  })

  test('measuring does not select or move anything', async ({ page }) => {
    await page.evaluate(() => (window as any).__aluframe.store.getState().clearSelection())
    await settle(page)
    const before = await store(page)
    await page.getByTestId('measure-toggle').click()
    await settle(page)
    await clickWorldPoint(page, [0, 40, 0])
    await clickWorldPoint(page, [900, 40, 0])
    const after = await store(page)
    expect(after.selectedIds).toEqual([])
    expect(after.profiles.map((p: { position: number[] }) => p.position)).toEqual(before.profiles.map((p: { position: number[] }) => p.position))
  })
})
