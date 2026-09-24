import { test, expect } from '@playwright/test'
import { openApp, settle, setView, store } from './helpers'

/** a two-bay cabinet, with a door on each bay and a shelf in each */
async function cabinet(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const up = [-0.7071067811865475, 0, 0, 0.7071067811865476]
    const alongX = [0, 0.7071067811865475, 0, 0.7071067811865476]
    const alongZ = [0, 0, 0, 1]
    const P: unknown[] = []
    for (const x of [0, 600, 1200]) for (const z of [0, 600]) {
      P.push({ id: `p${x}_${z}`, spec: '2020', length: 880, position: [x, 0, z], quaternion: up, miterCuts: [], holes: [] })
    }
    for (const y of [20, 860]) {
      for (const [a, b] of [[0, 600], [600, 1200]]) for (const z of [0, 600]) {
        P.push({ id: `r${a}_${y}_${z}`, spec: '2020', length: b - a, position: [a, y, z], quaternion: alongX, miterCuts: [], holes: [] })
      }
      for (const x of [0, 600, 1200]) P.push({ id: `c${x}_${y}`, spec: '2020', length: 600, position: [x, y, 0], quaternion: alongZ, miterCuts: [], holes: [] })
    }
    ;(window as any).__aluframe.store.getState().loadDocument({ profiles: P, connectors: [], panels: [], fittings: [] })
  })
  await settle(page)
  for (const [x1, x2] of [[0, 600], [600, 1200]]) {
    await page.evaluate(([a, b]) => (window as any).__aluframe.store.getState().selectItems([`p${a}_0`, `p${b}_0`]), [x1, x2])
    await settle(page)
    await page.getByTestId('add-door').click()
    await page.waitForTimeout(150)
  }
  await page.evaluate(() => (window as any).__aluframe.store.getState().clearSelection())
  await settle(page)
}

const sel = async (page: import('@playwright/test').Page) => (await store(page)).selectedIds

/**
 * A door and a shelf are parts like any other. They could be selected one at a time and then
 * only the first of them could be edited, which is "no multiple selection" from the far side
 * of the screen: the selection was honoured everywhere except where it mattered.
 */
test.describe('Doors, boards and brackets select together', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await cabinet(page)
    await setView(page, [2200, 1400, 2400], [600, 440, 300])
  })

  test('select-all takes the doors too', async ({ page }) => {
    await page.keyboard.press('Control+a')
    await page.waitForTimeout(150)
    const s = await store(page)
    for (const f of s.fittings) expect(s.selectedIds).toContain(f.id)
  })

  test('a box dragged round them catches them, not just the frame behind', async ({ page }) => {
    await page.getByTestId('select-toggle').click()
    await page.waitForTimeout(100)
    await page.mouse.move(360, 60)
    await page.mouse.down()
    await page.mouse.move(1380, 860, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(250)
    const s = await store(page)
    const picked = await sel(page)
    expect(s.fittings.every((f) => picked.includes(f.id))).toBe(true)
  })

  test('one hinge angle typed sets every door that is selected', async ({ page }) => {
    const ids = (await store(page)).fittings.map((f) => f.id)
    await page.evaluate((x) => (window as any).__aluframe.store.getState().selectItems(x), ids)
    await settle(page)
    await expect(page.getByTestId('fitting-multi')).toBeVisible()
    await page.getByTestId('fitting-angle-165').click()
    await page.waitForTimeout(200)
    for (const f of (await store(page)).fittings) expect(f.swing).toBe(165)
  })

  test('and it is one thing to undo, not several', async ({ page }) => {
    const ids = (await store(page)).fittings.map((f) => f.id)
    await page.evaluate((x) => (window as any).__aluframe.store.getState().selectItems(x), ids)
    await settle(page)
    await page.getByTestId('fitting-angle-165').click()
    await page.waitForTimeout(200)
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(200)
    for (const f of (await store(page)).fittings) expect(f.swing).not.toBe(165)
  })
})
