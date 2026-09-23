import { test, expect } from '@playwright/test'
import { openApp, settle, store, setView } from './helpers'

const UP = [-0.7071067811865475, 0, 0, 0.7071067811865476]
const ALONG_X = [0, 0.7071067811865475, 0, 0.7071067811865476]

async function corner(page: import('@playwright/test').Page) {
  await page.evaluate(([up, ax]) => {
    ;(window as any).__aluframe.store.getState().loadDocument({
      profiles: [
        { id: 'post', spec: '2020', length: 300, position: [0, 0, 0], quaternion: up, miterCuts: [], holes: [] },
        { id: 'rail', spec: '2020', length: 300, position: [0, 300, 0], quaternion: ax, miterCuts: [], holes: [] },
      ], connectors: [], panels: [], fittings: [],
    })
  }, [UP, ALONG_X])
  await settle(page)
}

const conflicts = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as any).__aluframe.conflicts().conflicts as Array<{ a: string; b: string; depth: number }>)

/**
 * A bracket buried in a member is as much a thing that cannot be built as two members running
 * through each other — and easier to draw by accident, because a twenty-millimetre part inside
 * a rail is invisible.
 */
test.describe('A connector in the way is reported', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await corner(page)
    await setView(page, [500, 500, 500], [50, 250, 0])
  })

  test('one fitted properly is not a conflict', async ({ page }) => {
    await page.getByTestId('connector-bracket').click()
    await page.getByTestId('auto-connect').click()
    await settle(page)
    await page.waitForTimeout(300)
    expect((await store(page)).connectors.length).toBeGreaterThan(0)
    expect(await conflicts(page)).toEqual([])
  })

  test('one sunk into a member is', async ({ page }) => {
    await page.getByTestId('connector-bracket').click()
    await page.getByTestId('auto-connect').click()
    await settle(page)
    await page.waitForTimeout(300)
    await page.evaluate(() => {
      const s = (window as any).__aluframe.store.getState()
      s.addConnector({ ...s.connectors[0], id: 'buried', position: [150, 300, 0] })
    })
    await settle(page)
    await page.waitForTimeout(300)
    const c = await conflicts(page)
    expect(c.length).toBeGreaterThan(0)
    expect(c.some((x) => x.a === 'buried' || x.b === 'buried')).toBe(true)
    await expect(page.getByTestId('bom-penetrations')).toContainText(/\d/)
  })

  test('two on top of each other are', async ({ page }) => {
    await page.getByTestId('connector-bracket').click()
    await page.getByTestId('auto-connect').click()
    await settle(page)
    await page.waitForTimeout(300)
    const before = (await conflicts(page)).length
    await page.evaluate(() => {
      const s = (window as any).__aluframe.store.getState()
      s.addConnector({ ...s.connectors[0], id: 'double' })
    })
    await settle(page)
    await page.waitForTimeout(300)
    expect((await conflicts(page)).length).toBeGreaterThan(before)
  })

  test('the conflict line selects them, so they can be found', async ({ page }) => {
    await page.getByTestId('connector-bracket').click()
    await page.getByTestId('auto-connect').click()
    await settle(page)
    await page.evaluate(() => {
      const s = (window as any).__aluframe.store.getState()
      s.addConnector({ ...s.connectors[0], id: 'buried', position: [150, 300, 0] })
    })
    await settle(page)
    await page.waitForTimeout(300)
    await page.getByTestId('bom-penetrations').click()
    await settle(page)
    expect((await store(page)).selectedIds).toContain('buried')
  })
})

/** A number on the drawing that does not say which field it is sends you counting axes */
test.describe('A board and a drawer say their size on the drawing', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await page.evaluate(([up]) => {
      ;(window as any).__aluframe.store.getState().loadDocument({
        profiles: [
          { id: 'u1', spec: '2020', length: 800, position: [0, 0, 0], quaternion: up, miterCuts: [], holes: [] },
          { id: 'u2', spec: '2020', length: 800, position: [600, 0, 0], quaternion: up, miterCuts: [], holes: [] },
          { id: 'u3', spec: '2020', length: 800, position: [0, 0, 600], quaternion: up, miterCuts: [], holes: [] },
          { id: 'u4', spec: '2020', length: 800, position: [600, 0, 600], quaternion: up, miterCuts: [], holes: [] },
        ],
        connectors: [],
        panels: [{ id: 'b1', width: 560, height: 350, thickness: 18, position: [300, 400, 300], quaternion: [0, 0, 0, 1], material: 'mdf' }],
        fittings: [],
      })
    }, [UP])
    await settle(page)
    await setView(page, [1400, 900, 1600], [300, 400, 300])
  })

  test('a board is labelled with the same letters its fields use', async ({ page }) => {
    await page.evaluate(() => (window as any).__aluframe.store.getState().selectItem('b1', false))
    await settle(page)
    const fields = await page.getByTestId('panel-props').locator('input[type=number]')
      .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))
    expect(fields.slice(0, 3)).toEqual(['560', '350', '18'])
  })

  test('a drawer has fields of its own, in the same order', async ({ page }) => {
    await page.evaluate(() => (window as any).__aluframe.store.getState().selectItems(['u1', 'u2', 'u3', 'u4']))
    await settle(page)
    await page.getByTestId('drawer-height').fill('250')
    await page.getByTestId('add-drawer').click()
    await settle(page)
    await page.waitForTimeout(300)
    const f = (await store(page)).fittings[0]
    await page.evaluate((id) => (window as any).__aluframe.store.getState().selectItem(id, false), f.id)
    await settle(page)
    await expect(page.getByTestId('fitting-props')).toBeVisible()
    const fields = await page.getByTestId('fitting-props').locator('input[type=number]')
      .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))
    expect(fields).toEqual([String(Math.round(f.width)), String(Math.round(f.height)), String(Math.round(f.depth))])
  })

  test('the labels go away with the ruler, like every other dimension', async ({ page }) => {
    const on = await page.evaluate(() => (window as any).__aluframe.spriteCount())
    await page.getByTestId('labels-toggle').click()
    await settle(page)
    await page.waitForTimeout(200)
    const off = await page.evaluate(() => (window as any).__aluframe.spriteCount())
    expect(off).toBeLessThan(on)
  })

  test('a drawer can be opened from its own panel while looking', async ({ page }) => {
    await page.evaluate(() => (window as any).__aluframe.store.getState().selectItems(['u1', 'u2', 'u3', 'u4']))
    await settle(page)
    await page.getByTestId('add-drawer').click()
    await settle(page)
    await page.waitForTimeout(300)
    const f = (await store(page)).fittings[0]
    await page.evaluate((id) => (window as any).__aluframe.store.getState().selectItem(id, false), f.id)
    await settle(page)
    await page.getByTestId('fitting-open').fill('100')
    await settle(page)
    await page.waitForTimeout(200)
    expect((await store(page)).fittings[0].open).toBeCloseTo(1, 2)
  })
})
