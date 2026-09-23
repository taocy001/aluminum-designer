import { test, expect } from '@playwright/test'
import { openApp, settle, setView } from './helpers'

/** a shelf rail of the given span between two posts, and the rail selected */
async function shelf(page: import('@playwright/test').Page, span: number, spec = '2020') {
  await page.evaluate(([n, s]) => {
    const up = { quaternion: [-0.7071067811865475, 0, 0, 0.7071067811865476], miterCuts: [], holes: [] }
    const alongX = { quaternion: [0, 0.7071067811865475, 0, 0.7071067811865476], miterCuts: [], holes: [] }
    const w = (window as any).__aluframe
    w.store.getState().loadDocument({
      profiles: [
        { id: 'a', spec: '2020', length: 800, position: [0, 0, 0], ...up },
        { id: 'b', spec: '2020', length: 800, position: [n as number, 0, 0], ...up },
        { id: 'rail', spec: s, length: n as number, position: [0, 400, 0], ...alongX },
      ],
      connectors: [], panels: [],
    })
    w.store.getState().selectItem('rail', false)
  }, [span, spec] as [number, string])
  await settle(page)
}

const sag = async (page: import('@playwright/test').Page) =>
  parseFloat((await page.getByTestId('deflection-sag').textContent())!.replace(/[^\d.]/g, ''))

/**
 * "It will hold" and "it will look straight" are different questions, and the tool only ever
 * answered the first. A 2020 carrying a box of books over 1.8 m drops most of a centimetre,
 * which until now you found out by building it.
 */
test.describe('how far a span will bend', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await setView(page, [1600, 1200, 1800], [600, 400, 0])
  })

  test('a selected rail says how far it drops, and under what', async ({ page }) => {
    await shelf(page, 1000)
    await expect(page.getByTestId('deflection')).toBeVisible()
    await expect(page.getByTestId('deflection-load')).toHaveValue('20')
    expect(await sag(page)).toBeGreaterThan(5)
    expect(await sag(page)).toBeLessThan(15)
  })

  test('a heavier load drops it further, straight away', async ({ page }) => {
    await shelf(page, 1000)
    const light = await sag(page)
    await page.getByTestId('deflection-load').fill('60')
    await page.waitForTimeout(120)
    expect(await sag(page)).toBeGreaterThan(light * 2.5)
  })

  test('a 2040 in the same opening barely moves', async ({ page }) => {
    await shelf(page, 1000)
    const thin = await sag(page)
    await shelf(page, 1000, '2040')
    expect(await sag(page)).toBeLessThan(thin / 3)
  })

  test('a post is not a beam, so it is not asked the question', async ({ page }) => {
    await shelf(page, 1000)
    await page.evaluate(() => (window as any).__aluframe.store.getState().selectItem('a', false))
    await settle(page)
    await expect(page.getByTestId('deflection')).toHaveCount(0)
  })

  test('the summary calls out the spans that would look bent', async ({ page }) => {
    await shelf(page, 400)
    await expect(page.getByTestId('bom-sagging')).toHaveCount(0)
    await shelf(page, 1800)
    await expect(page.getByTestId('bom-sagging')).toBeVisible()
    await expect(page.getByTestId('bom-sagging')).toContainText('20 kg')
  })
})
