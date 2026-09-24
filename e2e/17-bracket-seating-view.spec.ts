import { test, expect } from '@playwright/test'
import { openApp, settle, store, setView, w2c } from './helpers'

/** a rail butting into a post, and nothing else to get in the way */
async function corner(page: import('@playwright/test').Page, spec = '2020', postSpec = '2020') {
  await page.evaluate(([s, ps]) => {
    const alongX = { quaternion: [0, 0.7071067811865475, 0, 0.7071067811865476], miterCuts: [], holes: [] }
    const up = { quaternion: [-0.7071067811865475, 0, 0, 0.7071067811865476], miterCuts: [], holes: [] }
    ;(window as any).__aluframe.store.getState().loadDocument({
      profiles: [
        { id: 'rail', spec: s, length: 600, position: [0, 10, 0], ...alongX },
        { id: 'post', spec: ps, length: 600, position: [0, 10, 0], ...up },
      ],
      connectors: [], panels: [],
    })
  }, [spec, postSpec])
  await settle(page)
}

const faults = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as any).__aluframe.bracketFaults())

/**
 * A bracket is two bolts. Each one drops a T-nut into a slot, so a hole that lands on solid
 * metal cannot be fitted at all — which is invisible in a render and priced in a cut list
 * either way. These say where the part actually goes.
 */
test.describe('A bracket goes where it can be bolted', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await corner(page)
    await setView(page, [520, 420, 620], [150, 200, 0])
  })

  test('one click fits them and every one is on its slots', async ({ page }) => {
    await page.getByTestId('connector-bracket').click()
    await page.getByTestId('auto-connect').click()
    await settle(page)
    await page.waitForTimeout(300)
    expect((await store(page)).connectors.length).toBeGreaterThan(0)
    expect(await faults(page)).toEqual([])
  })

  test('it sits inside the corner, on a slot line of both members', async ({ page }) => {
    await page.getByTestId('connector-bracket').click()
    await page.getByTestId('auto-connect').click()
    await settle(page)
    await page.waitForTimeout(300)
    const c = (await store(page)).connectors[0]
    // This is a cast angle bracket, not a plate. Its two flanges lie on the faces the two
    // members turn towards each other, and its bolts drop into a slot in each of those
    // faces. Both faces here are 20 wide with a single slot down the middle, so the part is
    // centred on z = 0 — a plate is the one that lies on the shared outside face at ±10.
    expect(Math.abs(c.position[2])).toBeLessThan(1)
    // and it is in the quadrant the two members enclose, not buried in either of them
    expect(c.position[0]).toBeGreaterThan(5)
    expect(c.position[1]).toBeGreaterThan(5)
  })

  test('dropping one near a corner settles it onto the corner', async ({ page }) => {
    await page.getByTestId('connector-bracket').click()
    const c = await w2c(page, [70, 10, 0])       // 70 mm along the rail from the joint
    await page.mouse.move(c.x - 30, c.y - 30)
    await page.mouse.move(c.x, c.y, { steps: 4 })
    await settle(page)
    await page.waitForTimeout(200)
    await page.mouse.click(c.x, c.y)
    await settle(page)
    await page.waitForTimeout(250)
    const placed = (await store(page)).connectors[0]
    // on the corner rather than at x = 70 where it was dropped. Not at x = 0 either: an
    // angle bracket's vertex is where the two mounting faces meet, which is half a section
    // out from each centreline.
    expect(Math.abs(placed.position[0])).toBeLessThan(25)
    expect(await faults(page)).toEqual([])
  })

  test('the ghost shows the seat, so the part does not jump on the click', async ({ page }) => {
    await page.getByTestId('connector-bracket').click()
    const c = await w2c(page, [70, 10, 0])
    await page.mouse.move(c.x - 30, c.y - 30)
    await page.mouse.move(c.x, c.y, { steps: 4 })
    await settle(page)
    await page.waitForTimeout(200)
    const ghost = await page.evaluate(() => {
      const w = (window as any).__aluframe
      const t = w.tool.getState()
      return w.seatOf ? null : t.currentPoint ? true : false
    })
    expect(ghost).toBe(true)
    await page.mouse.click(c.x, c.y)
    await settle(page)
    await page.waitForTimeout(250)
    expect(await faults(page)).toEqual([])
  })

  test('the sidebar says whether they can all be bolted', async ({ page }) => {
    await page.getByTestId('connector-bracket').click()
    await page.getByTestId('auto-connect').click()
    await settle(page)
    await page.waitForTimeout(300)
    await expect(page.getByTestId('bom-bracket-seating')).toBeVisible()
    const text = await page.getByTestId('bom-bracket-seating').textContent()
    expect(text).not.toMatch(/\d/)          // a count only appears when something is wrong
  })

  test('it calls out a bracket that has been left behind', async ({ page }) => {
    await page.getByTestId('connector-bracket').click()
    await page.getByTestId('auto-connect').click()
    await settle(page)
    await page.waitForTimeout(300)
    await page.evaluate(() => {
      const s = (window as any).__aluframe.store.getState()
      s.commitTransform({ profiles: [{ id: 'rail', updates: { position: [2000, 10, 2000] } }] })
    })
    await settle(page)
    await page.waitForTimeout(250)
    expect((await faults(page)).length).toBeGreaterThan(0)
    await expect(page.getByTestId('bom-bracket-seating')).toContainText(/\d/)
  })
})

/** Where the camera goes when you ask it to come closer, and what it turns about */
test.describe('Coming in, and turning about what you are looking at', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await corner(page)
    await setView(page, [2000, 1600, 2400], [300, 300, 200])
  })

  const cam = (page: import('@playwright/test').Page) => page.evaluate(() => ({
    pos: (window as any).__aluframe.camera.position.toArray().map(Math.round),
    target: (window as any).__aluframe.controls.target.toArray().map(Math.round),
  }))

  test('a double click on a member comes in on that member', async ({ page }) => {
    const c = await w2c(page, [300, 10, 0])
    // the pointer really is over the rail before we ask what a double click does there
    await expect.poll(async () => (await page.evaluate(([x, y]) =>
      (window as any).__aluframe.pickAt(x, y).map((p: any) => p.id), [c.x, c.y]))[0]).toBe('rail')
    await page.mouse.dblclick(c.x, c.y)
    await page.waitForTimeout(350)
    const after = await cam(page)
    // It comes in on the rail. Exactly where on it is not the promise: when the pick lands
    // on the member the target is the point on its centreline under the pointer, and when
    // it narrowly misses the target is the same depth along the same ray — a hand's breadth
    // away on a rail this long, and the same thing to look at. What would be wrong is
    // coming in somewhere else entirely, or diving to the floor.
    const before = { pos: [2000, 1600, 2400], target: [300, 300, 200] }
    const dist = (a: number[], b: number[]) => Math.hypot(...a.map((v, i) => v - b[i]))
    expect(dist(after.pos, after.target)).toBeLessThan(dist(before.pos, before.target))
    expect(dist(after.target, [300, 10, 0])).toBeLessThan(200)
  })

  test('a double click on empty sky stays at the depth you were looking at', async ({ page }) => {
    const before = await cam(page)
    const depthBefore = Math.hypot(...before.pos.map((v, i) => v - before.target[i]))
    await page.mouse.dblclick(1150, 160)         // above the frame, nothing there
    await page.waitForTimeout(350)
    const after = await cam(page)
    // it must come in, and it must not dive to a point on the floor far below
    expect(Math.hypot(...after.pos.map((v, i) => v - after.target[i]))).toBeLessThan(depthBefore)
    expect(Math.abs(after.target[1] - before.target[1])).toBeLessThan(depthBefore)
  })

  test('a press on empty space re-aims the pivot without moving the picture', async ({ page }) => {
    // pan, which leaves the pivot behind
    await page.mouse.move(700, 500)
    await page.mouse.down({ button: 'right' })
    await page.mouse.move(980, 560, { steps: 8 })
    await page.mouse.up({ button: 'right' })
    await page.waitForTimeout(250)
    const panned = await cam(page)
    await page.mouse.move(1150, 180)
    await page.mouse.down()
    await page.waitForTimeout(150)
    const aimed = await cam(page)
    await page.mouse.up()
    expect(aimed.target).not.toEqual(panned.target)      // the pivot moved
    expect(aimed.pos).toEqual(panned.pos)                // the camera did not
  })
})
