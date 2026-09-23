import { test, expect } from '@playwright/test'
import { openApp, settle, store, setView, w2c, enterDraw, drawMember } from './helpers'

const log = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as any).__aluframe.opLog() as Array<{ label: string; detail: string }>)

/**
 * Undo keeps the last few states in memory and loses them on reload, so "why would this rail
 * not move" had no answer the next morning. The log is the answer: what the document actually
 * did, measured rather than announced.
 */
test.describe('What happened', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await setView(page, [1300, 900, 1500], [300, 300, 200])
    await page.evaluate(() => (window as any).__aluframe.clearOpLog())
  })

  test('drawing a member is one entry that says so', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 0, 0])
    await settle(page)
    const l = await log(page)
    expect(l).toHaveLength(1)
    expect(l[0].label).toBe('add')
    expect(l[0].detail).toContain('member')
  })

  test('a nudge records how far, not just that something happened', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 0, 0])
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    const c = await w2c(page, [300, 10, 0])
    await page.mouse.click(c.x, c.y)
    await settle(page)
    await page.keyboard.press('ArrowRight')
    await settle(page)
    const last = (await log(page)).at(-1)!
    expect(last.label).toBe('nudge')
    expect(last.detail).toContain('[5, 0, 0]')
  })

  test('a whole drag is one entry, not one per frame', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 0, 0])
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    const c = await w2c(page, [300, 10, 0])
    await page.mouse.click(c.x, c.y)
    await settle(page)
    const before = (await log(page)).length
    await page.mouse.move(c.x, c.y)
    await page.mouse.down()
    for (let i = 1; i <= 14; i++) { await page.mouse.move(c.x + i * 8, c.y + i * 3); await page.waitForTimeout(16) }
    await page.mouse.up()
    await page.waitForTimeout(250)
    const l = await log(page)
    expect(l.length).toBe(before + 1)
    expect(l.at(-1)!.label).toBe('drag')
    expect(l.at(-1)!.detail).toContain('moved')
  })

  test('a turn is named with its axis and angle', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 0, 0])
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    const c = await w2c(page, [300, 10, 0])
    await page.mouse.click(c.x, c.y)
    await settle(page)
    await page.keyboard.press('r')
    await page.keyboard.press('y')
    await settle(page)
    expect((await log(page)).at(-1)!.label).toBe('turn Y 90°')
  })

  test('opening a drawer is not a change to the design, so it is not logged', async ({ page }) => {
    await page.evaluate(() => {
      const up = { quaternion: [-0.7071067811865475, 0, 0, 0.7071067811865476], miterCuts: [], holes: [] }
      ;(window as any).__aluframe.store.getState().loadDocument({
        profiles: [
          { id: 'u1', spec: '2020', length: 800, position: [0, 0, 0], ...up },
          { id: 'u2', spec: '2020', length: 800, position: [600, 0, 0], ...up },
          { id: 'u3', spec: '2020', length: 800, position: [0, 0, 600], ...up },
          { id: 'u4', spec: '2020', length: 800, position: [600, 0, 600], ...up },
        ], connectors: [], panels: [], fittings: [],
      })
      const s = (window as any).__aluframe.store.getState()
      s.selectItems(['u1', 'u2', 'u3', 'u4'])
    })
    await settle(page)
    await page.getByTestId('add-drawer').click()
    await settle(page)
    await page.waitForTimeout(250)
    const before = (await log(page)).length
    const id = (await store(page)).fittings[0].id
    await page.evaluate((x) => (window as any).__aluframe.store.getState().updateFitting(x, { open: 1 }, false), id)
    await page.waitForTimeout(250)
    expect((await log(page)).length).toBe(before)
  })

  test('it survives a reload, which is the whole point', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 0, 0])
    await settle(page)
    const before = await log(page)
    expect(before.length).toBeGreaterThan(0)
    await page.reload()
    await page.waitForFunction(() => (window as any).__aluframe?.opLog, null, { timeout: 20_000 })
    expect(await log(page)).toEqual(before)
  })

  test('the panel lists it and can be emptied', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 0, 0])
    await page.keyboard.press('Escape')
    await settle(page)
    await page.getByTestId('section-log').click()
    await expect(page.getByTestId('op-log')).toContainText('add')
    await page.getByTestId('op-log-clear').click()
    await settle(page)
    expect(await log(page)).toHaveLength(0)
  })
})
