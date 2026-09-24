import { test, expect } from '@playwright/test'
import { openApp, settle, setView, store, w2c } from './helpers'

/** a corner where four members meet: two uprights and two rails sharing one point */
async function corner(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const up = [-0.7071067811865475, 0, 0, 0.7071067811865476]
    const alongX = [0, 0.7071067811865475, 0, 0.7071067811865476]
    const alongZ = [0, 0, 0, 1]
    ;(window as any).__aluframe.store.getState().loadDocument({
      profiles: [
        { id: 'post', spec: '2020', length: 800, position: [0, 0, 0], quaternion: up, miterCuts: [], holes: [] },
        { id: 'post2', spec: '2020', length: 800, position: [900, 0, 0], quaternion: up, miterCuts: [], holes: [] },
        { id: 'rail', spec: '2020', length: 900, position: [0, 20, 0], quaternion: alongX, miterCuts: [], holes: [] },
        { id: 'cross', spec: '2020', length: 400, position: [0, 20, 0], quaternion: alongZ, miterCuts: [], holes: [] },
      ],
      connectors: [], panels: [],
    })
  })
  await settle(page)
}

const lengths = async (page: import('@playwright/test').Page) =>
  Object.fromEntries((await store(page)).profiles.map((p) => [p.id, Math.round(p.length)]))

/**
 * One press does one thing.
 *
 * Pressing a member that was not selected used to change the selection *and* then, in the
 * same press, decide whether to stretch — using the identity it had just changed to. At a
 * corner the pointer resolves to whichever member the renderer drew in front, which is
 * usually not the one somebody meant to take hold of, so reaching for a rail shortened an
 * upright and the stretch handle went wherever it pleased.
 */
test.describe('A press in a crowded corner', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await corner(page)
    await setView(page, [1100, 900, 1200], [300, 300, 150])
  })

  test('pressing an unselected member selects it and stretches nothing', async ({ page }) => {
    const before = await lengths(page)
    // aim at the corner itself, where all four members end
    const at = await w2c(page, [0, 20, 0])
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.mouse.move(at.x + 60, at.y - 40, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(250)
    expect(await lengths(page)).toEqual(before)
  })

  test('moving one member never changes another one’s length', async ({ page }) => {
    const before = await lengths(page)
    await page.evaluate(() => (window as any).__aluframe.store.getState().selectItem('rail', false))
    await settle(page)
    const at = await w2c(page, [450, 20, 0])        // the middle of the rail, away from its ends
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.mouse.move(at.x, at.y - 70, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(250)
    const after = await lengths(page)
    for (const id of ['post', 'post2', 'cross']) {
      expect(after[id], `${id} was not the one being moved`).toBe(before[id])
    }
  })

  test('and the member that is selected can still be stretched by its end', async ({ page }) => {
    await page.evaluate(() => (window as any).__aluframe.store.getState().selectItem('rail', false))
    await settle(page)
    const end = await w2c(page, [900, 20, 0])
    await page.mouse.move(end.x, end.y)
    await page.mouse.down()
    await page.mouse.move(end.x - 90, end.y, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(250)
    const after = await lengths(page)
    expect(after.rail).not.toBe(900)
    expect(after.post).toBe(800)
    expect(after.post2).toBe(800)
    expect(after.cross).toBe(400)
  })
})
