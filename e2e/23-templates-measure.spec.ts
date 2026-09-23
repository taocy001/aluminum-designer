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

/**
 * An open tool spreads by being sent to people, and a file attachment is not being sent to
 * people — it is being asked to download something.
 */
test.describe('A drawing in a link', () => {
  test('a link opens the drawing it carries, in a browser that has never seen it', async ({ browser }) => {
    const sender = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    const a = await sender.newPage()
    await a.goto('/')
    await a.evaluate(() => localStorage.clear())
    await a.goto('/')
    await a.waitForFunction(() => (window as any).__aluframe?.setView, null, { timeout: 20_000 })
    await a.getByTestId('template-shelving').click()
    await a.getByTestId('template-place').click()
    await a.waitForTimeout(400)
    const sent = await a.evaluate(() => (window as any).__aluframe.store.getState().profiles.length)
    await a.getByTestId('share-link').click()
    await a.waitForTimeout(400)
    const link = await a.evaluate(() => navigator.clipboard.readText())
    expect(link).toContain('#d=')

    const receiver = await browser.newContext()
    const b = await receiver.newPage()
    await b.goto(link)
    await b.waitForFunction(() => (window as any).__aluframe?.setView, null, { timeout: 20_000 })
    await b.waitForTimeout(700)
    expect(await b.evaluate(() => (window as any).__aluframe.store.getState().profiles.length)).toBe(sent)

    // the link is taken out of the bar, so a reload is not a reset to what was sent
    expect(await b.evaluate(() => location.hash.includes('d='))).toBe(false)
    await b.reload()
    await b.waitForFunction(() => (window as any).__aluframe?.setView, null, { timeout: 20_000 })
    await b.waitForTimeout(600)
    expect(await b.evaluate(() => (window as any).__aluframe.store.getState().profiles.length)).toBe(sent)

    await sender.close()
    await receiver.close()
  })

  test('a plain visit is an empty drawing, so what arrives really came from the link', async ({ browser }) => {
    const c = await browser.newContext()
    const p = await c.newPage()
    await p.goto('/')
    await p.waitForFunction(() => (window as any).__aluframe?.setView, null, { timeout: 20_000 })
    await p.waitForTimeout(400)
    expect(await p.evaluate(() => (window as any).__aluframe.store.getState().profiles.length)).toBe(0)
    await c.close()
  })

  test('a link we cannot read leaves the drawing alone', async ({ browser }) => {
    const c = await browser.newContext()
    const p = await c.newPage()
    await p.goto('/#d=bm90b3Vycw')
    await p.waitForFunction(() => (window as any).__aluframe?.setView, null, { timeout: 20_000 })
    await p.waitForTimeout(600)
    expect(await p.evaluate(() => (window as any).__aluframe.store.getState().profiles.length)).toBe(0)
    expect(await p.evaluate(() => location.hash.includes('d='))).toBe(false)
    await c.close()
  })
})

/**
 * On a phone the drawing is what you came for, so it takes the screen and the panel is a
 * sheet along the bottom edge rather than a column stealing half the width.
 */
test.describe('Narrow screens', () => {
  const sizes = [
    { name: 'phone', width: 390, height: 844, stacked: true },
    { name: 'tablet', width: 820, height: 1180, stacked: false },
    { name: 'laptop', width: 1440, height: 900, stacked: false },
  ]

  for (const s of sizes) {
    test(`${s.name}: the drawing gets the room, and the toolbar fits`, async ({ browser }) => {
      const c = await browser.newContext({ viewport: { width: s.width, height: s.height }, hasTouch: true })
      const p = await c.newPage()
      await p.goto('/')
      await p.evaluate(() => localStorage.clear())
      await p.goto('/')
      await p.waitForFunction(() => (window as any).__aluframe?.setView, null, { timeout: 20_000 })
      await p.waitForTimeout(500)

      const canvasWidth = await p.evaluate(() => Math.round(document.querySelector('canvas')!.getBoundingClientRect().width))
      if (s.stacked) {
        // the panel is out of the way, and the drawing has the whole width
        expect(canvasWidth).toBeGreaterThan(s.width * 0.9)
        await expect(p.getByTestId('sidebar-rail')).toBeVisible()
      } else {
        await expect(p.getByTestId('sidebar')).toBeVisible()
        expect(canvasWidth).toBeLessThan(s.width)
      }

      // every toolbar button is on screen, not off the end of a strip that scrolls
      const offscreen = await p.evaluate(() => {
        const ids = ['fit-view', 'zoom-in', 'zoom-out', 'labels-toggle', 'mode-toggle', 'measure-toggle', 'fittings-toggle']
        return ids.filter((id) => {
          const el = document.querySelector(`[data-testid="${id}"]`)
          if (!el) return false
          const r = el.getBoundingClientRect()
          return r.right > window.innerWidth + 1 || r.left < -1 || r.bottom > window.innerHeight + 1
        })
      })
      expect(offscreen).toEqual([])
      await c.close()
    })
  }

  test('the panel opens and closes on a phone', async ({ browser }) => {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })
    const p = await c.newPage()
    await p.goto('/')
    await p.evaluate(() => localStorage.clear())
    await p.goto('/')
    await p.waitForFunction(() => (window as any).__aluframe?.setView, null, { timeout: 20_000 })
    await expect(p.getByTestId('sidebar')).toHaveCount(0)
    await p.getByTestId('sidebar-expand').click()
    await expect(p.getByTestId('sidebar')).toBeVisible()
    await p.getByTestId('sidebar-collapse').click()
    await expect(p.getByTestId('sidebar')).toHaveCount(0)
    await c.close()
  })

  test('a frame can be placed from a phone', async ({ browser }) => {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })
    const p = await c.newPage()
    await p.goto('/')
    await p.evaluate(() => localStorage.clear())
    await p.goto('/')
    await p.waitForFunction(() => (window as any).__aluframe?.setView, null, { timeout: 20_000 })
    await p.getByTestId('sidebar-expand').click()
    await p.getByTestId('template-cabinet').click()
    await p.getByTestId('template-place').click()
    await p.waitForTimeout(400)
    expect(await p.evaluate(() => (window as any).__aluframe.store.getState().profiles.length)).toBeGreaterThan(3)
    await c.close()
  })
})
