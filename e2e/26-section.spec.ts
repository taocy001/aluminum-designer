import { test, expect } from '@playwright/test'
import { openApp, settle, setView, store } from './helpers'

/** a two-bay cabinet, 1200 long */
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
}

/** how many of the members the renderer draws anywhere on screen */
const drawn = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const w = (window as any).__aluframe
  const seen = new Set<string>()
  for (let y = 40; y < 880; y += 6) for (let x = 340; x < 1380; x += 6) {
    const h = w.frontmostAt(x, y)
    if (h) seen.add(h.id)
  }
  return [...seen]
})

/**
 * Hiding parts to see inside a cabinet works until the thing you want to see is behind the
 * part you would have to hide. A plane takes away one side of itself wherever it falls.
 */
test.describe('A cut through the drawing', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await cabinet(page)
    await setView(page, [2000, 1500, 2200], [600, 440, 300])
  })

  test('nothing is cut until you ask', async ({ page }) => {
    await expect(page.getByTestId('section-block')).toBeVisible()
    expect((await drawn(page)).length).toBeGreaterThan(6)
  })

  test('cutting along X takes away the far half', async ({ page }) => {
    const before = await drawn(page)
    await page.getByTestId('section-x').click()
    await page.waitForTimeout(350)
    const after = await drawn(page)
    expect(after.length).toBeLessThan(before.length)
    // and the members that survive are the ones on the near side of the cut
    const s = await store(page)
    const mid = 600
    for (const id of after) {
      const p = s.profiles.find((q) => q.id === id)
      if (p) expect(p.position[0]).toBeLessThan(mid + 60)
    }
  })

  test('flipping it keeps the other half instead', async ({ page }) => {
    await page.getByTestId('section-x').click()
    await page.waitForTimeout(300)
    const near = await drawn(page)
    await page.getByTestId('section-flip').click()
    await page.waitForTimeout(350)
    const far = await drawn(page)
    expect(far.length).toBeGreaterThan(0)
    expect(far.some((id) => !near.includes(id))).toBe(true)
  })

  test('sliding it moves where the cut falls', async ({ page }) => {
    await page.getByTestId('section-x').click()
    await page.waitForTimeout(300)
    const mid = await drawn(page)
    await page.getByTestId('section-at').fill('1150')
    await page.waitForTimeout(350)
    expect((await drawn(page)).length).toBeGreaterThan(mid.length)
  })

  test('turning it off puts everything back', async ({ page }) => {
    const before = await drawn(page)
    await page.getByTestId('section-y').click()
    await page.waitForTimeout(300)
    await page.getByTestId('section-off').click()
    await page.waitForTimeout(350)
    expect((await drawn(page)).length).toBe(before.length)
  })
})
