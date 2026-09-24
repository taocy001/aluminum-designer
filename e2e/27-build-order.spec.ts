import { test, expect } from '@playwright/test'
import { openApp, settle, setView, store } from './helpers'

async function cabinet(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const up = [-0.7071067811865475, 0, 0, 0.7071067811865476]
    const alongX = [0, 0.7071067811865475, 0, 0.7071067811865476]
    const alongZ = [0, 0, 0, 1]
    const P: unknown[] = []
    for (const x of [0, 600]) for (const z of [0, 400]) {
      P.push({ id: `p${x}_${z}`, spec: '2020', length: 800, position: [x, 0, z], quaternion: up, miterCuts: [], holes: [] })
    }
    for (const y of [20, 780]) {
      for (const z of [0, 400]) P.push({ id: `rx${y}_${z}`, spec: '2020', length: 600, position: [0, y, z], quaternion: alongX, miterCuts: [], holes: [] })
      for (const x of [0, 600]) P.push({ id: `rz${x}_${y}`, spec: '2020', length: 400, position: [x, y, 0], quaternion: alongZ, miterCuts: [], holes: [] })
    }
    ;(window as any).__aluframe.store.getState().loadDocument({ profiles: P, connectors: [], panels: [], fittings: [] })
  })
  await settle(page)
}

/** the members the renderer is actually drawing */
const drawn = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const w = (window as any).__aluframe
  const seen = new Set<string>()
  for (let y = 40; y < 880; y += 5) for (let x = 340; x < 1380; x += 5) {
    const h = w.frontmostAt(x, y)
    if (h) seen.add(h.id)
  }
  return [...seen]
})

/**
 * A drawing says what the thing is and says nothing about the order it goes together in,
 * which is the question everybody actually has in front of a pile of extrusion.
 */
test.describe('What to build first', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await cabinet(page)
    await setView(page, [1800, 1300, 2000], [300, 400, 200])
  })

  test('the whole thing is shown until the steps are asked for', async ({ page }) => {
    await expect(page.getByTestId('build-block')).toBeVisible()
    await expect(page.getByTestId('build-step')).toHaveCount(0)
    expect((await drawn(page)).length).toBeGreaterThan(6)
  })

  test('the first step is a few parts, not all of them', async ({ page }) => {
    const whole = await drawn(page)
    await page.getByTestId('build-toggle').click()
    await page.waitForTimeout(350)
    await expect(page.getByTestId('build-step')).toBeVisible()
    const first = await drawn(page)
    expect(first.length).toBeGreaterThan(0)
    expect(first.length).toBeLessThan(whole.length)
  })

  test('stepping forward only ever adds', async ({ page }) => {
    await page.getByTestId('build-toggle').click()
    await page.waitForTimeout(300)
    let previous = await drawn(page)
    for (let i = 0; i < 3; i++) {
      const next = page.getByTestId('build-next')
      if (await next.isDisabled()) break
      await next.click()
      await page.waitForTimeout(300)
      const now = await drawn(page)
      for (const id of previous) expect(now).toContain(id)
      previous = now
    }
  })

  test('the last step is the whole thing again', async ({ page }) => {
    const whole = await drawn(page)
    await page.getByTestId('build-toggle').click()
    await page.waitForTimeout(300)
    for (let i = 0; i < 20; i++) {
      const next = page.getByTestId('build-next')
      if (await next.isDisabled()) break
      await next.click()
      await page.waitForTimeout(120)
    }
    await page.waitForTimeout(300)
    expect((await drawn(page)).sort()).toEqual(whole.sort())
  })

  test('a step can be selected, so you can see which parts it means', async ({ page }) => {
    await page.getByTestId('build-toggle').click()
    await page.waitForTimeout(300)
    await page.getByTestId('build-select').click()
    await page.waitForTimeout(200)
    const s = await store(page)
    expect(s.selectedIds.length).toBeGreaterThan(0)
    expect(s.selectedIds.length).toBeLessThan(s.profiles.length)
  })

  test('and turning it off puts the whole thing back', async ({ page }) => {
    const whole = await drawn(page)
    await page.getByTestId('build-toggle').click()
    await page.waitForTimeout(300)
    await page.getByTestId('build-toggle').click()
    await page.waitForTimeout(350)
    expect((await drawn(page)).sort()).toEqual(whole.sort())
  })
})
