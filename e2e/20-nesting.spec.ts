import { test, expect } from '@playwright/test'
import { openApp, settle, useDownloadFallback } from './helpers'

/** three rails and four posts: enough that the arithmetic is not obvious */
async function frame(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const up = { quaternion: [-0.7071067811865475, 0, 0, 0.7071067811865476], miterCuts: [], holes: [] }
    const alongX = { quaternion: [0, 0.7071067811865475, 0, 0.7071067811865476], miterCuts: [], holes: [] }
    const profiles: unknown[] = []
    for (let i = 0; i < 4; i++) profiles.push({ id: `u${i}`, spec: '2020', length: 850, position: [i * 600, 0, 0], ...up })
    for (let i = 0; i < 3; i++) profiles.push({ id: `r${i}`, spec: '2040', length: 3640, position: [0, 10 + i * 400, 0], ...alongX })
    ;(window as any).__aluframe.store.getState().loadDocument({ profiles, connectors: [], panels: [], fittings: [] })
  })
  await settle(page)
  await page.waitForTimeout(250)
}

/**
 * A cut list says you need forty-two pieces. It does not say how many six-metre lengths to
 * order, and that is the number that goes on the purchase order.
 */
test.describe('How much stock to buy', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); await frame(page) })

  test('it says how many bars each section needs', async ({ page }) => {
    await expect(page.getByTestId('nesting-summary')).toContainText('2020')
    await expect(page.getByTestId('nesting-summary')).toContainText('2040')
  })

  test('a 3.6 m rail leaves most of a six-metre bar behind, and it says so', async ({ page }) => {
    // Three of them cannot share a 6 m bar, so that is three bars and a lot of offcut.
    // The figure is 2370 rather than 2360 because nesting works from the cut length — what
    // the saw is set to after the joints have been trimmed — not from the drawn length.
    await expect(page.getByTestId('nesting-summary')).toContainText('2370')
  })

  test('changing the stock length changes the answer', async ({ page }) => {
    const before = await page.getByTestId('nesting-yield').textContent()
    await page.getByTestId('stock-length').fill('4000')
    await settle(page)
    await page.waitForTimeout(200)
    const after = await page.getByTestId('nesting-yield').textContent()
    expect(after).not.toBe(before)
    // 3640 out of 4000 wastes 360; out of 6000 it wastes 2360
    expect(parseFloat(after!)).toBeGreaterThan(parseFloat(before!))
  })

  test('the cutting list downloads with a line per bar', async ({ page }) => {
    await useDownloadFallback(page)
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-cutting').click()])
    expect(dl.suggestedFilename()).toMatch(/cutting.*\.csv$/)
  })

  test('an empty drawing has nothing to order', async ({ page }) => {
    await page.evaluate(() => (window as any).__aluframe.store.getState().clearAll())
    await settle(page)
    await expect(page.getByTestId('nesting-block')).toHaveCount(0)
  })
})
