import { test, expect, type Page } from '@playwright/test'
import { openApp, setView, enterDraw, drawMember, drawExact, clickWorld, dragWorld, store, tool, conflicts, w2c, r , useDownloadFallback } from './helpers'

async function toNavigate(page: Page) {
  await page.keyboard.press('Escape')
  if ((await tool(page)).held !== null) await page.keyboard.press('Escape')
  expect((await tool(page)).held).toBe(null)
}

/** unit direction of a member, from its quaternion */
function dirOf(p: any): [number, number, number] {
  const [x, y, z, w] = p.quaternion
  return [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)]
}
const round2 = (v: number) => Math.round(v * 100) / 100

test.describe('Free rotation about any axis', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); await setView(page, [1900, 1500, 2300], [300, 400, 200]) })

  test('a member rotates about X, Y and Z by the angle in the panel', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])    // along +X
    await toNavigate(page)
    await clickWorld(page, [300, 10, 0])
    await expect(page.getByTestId('rotate-block')).toBeVisible()

    await page.getByTestId('rot-y-plus').click()       // 90° about Y: +X → -Z (right-handed)
    let p = (await store(page)).profiles[0]
    expect(dirOf(p).map(round2)).toEqual([0, 0, -1])

    await page.getByTestId('rot-y-minus').click()      // back to +X
    p = (await store(page)).profiles[0]
    expect(dirOf(p).map(round2)).toEqual([1, 0, 0])

    await page.getByTestId('rot-z-plus').click()       // 90° about Z: +X → +Y
    p = (await store(page)).profiles[0]
    expect(dirOf(p).map(round2)).toEqual([0, 1, 0])

    await page.getByTestId('rot-x-plus').click()       // 90° about X: +Y → +Z
    p = (await store(page)).profiles[0]
    expect(dirOf(p).map(round2)).toEqual([0, 0, 1])
  })

  test('any angle works, not just 90°, and the panel reports the orientation', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await toNavigate(page)
    await clickWorld(page, [300, 10, 0])
    const angle = page.getByTestId('rotate-angle')
    await angle.fill('30')
    await page.getByTestId('rot-y-plus').click()
    let d = dirOf((await store(page)).profiles[0])
    expect(round2(d[0])).toBeCloseTo(Math.cos(Math.PI / 6), 2)
    expect(round2(d[2])).toBeCloseTo(-Math.sin(Math.PI / 6), 2)
    await expect(page.getByTestId('profile-orientation')).toHaveText('0 / 120 / 0')   // 90° base + 30°
    // three more 30° steps add up to 120° of turn
    for (let i = 0; i < 3; i++) await page.getByTestId('rot-y-plus').click()
    d = dirOf((await store(page)).profiles[0])
    expect(d.map(round2)).toEqual([-0.5, 0, -0.87])
    await angle.fill('360')                            // a full turn is a no-op, so it is refused
    await expect(page.getByTestId('rot-y-plus')).toBeDisabled()
    expect(dirOf((await store(page)).profiles[0]).map(round2)).toEqual([-0.5, 0, -0.87])
  })

  test('rotation keeps the selection centred and is one undo step', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await drawMember(page, [0, 0, 400], [600, 10, 400])
    await toNavigate(page)
    await clickWorld(page, [300, 10, 0])
    await clickWorld(page, [300, 10, 400], { modifiers: ['Control'] })
    const before = (await store(page)).profiles.map((p) => p.position.map(r))
    await page.getByTestId('rot-y-plus').click()
    const after = (await store(page)).profiles.map((p) => p.position.map(r))
    expect(after).not.toEqual(before)
    expect((await store(page)).selectedIds).toHaveLength(2)
    await page.keyboard.press('Control+z')
    expect((await store(page)).profiles.map((p) => p.position.map(r))).toEqual(before)
  })

  // R asks which axis; X/Y/Z answers. It used to mean Y without saying so.
  test('R then Y turns 90° about Y, Shift+R then Y the other way', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await toNavigate(page)
    await clickWorld(page, [300, 10, 0])
    await page.keyboard.press('r')
    await expect(page.getByTestId('rotate-axis-hud')).toBeVisible()
    await page.keyboard.press('y')
    expect(dirOf((await store(page)).profiles[0]).map(round2)).toEqual([0, 0, -1])
    await page.keyboard.press('Shift+R')
    await page.keyboard.press('y')
    expect(dirOf((await store(page)).profiles[0]).map(round2)).toEqual([1, 0, 0])
  })

  /**
   * A connector used to turn and slide like anything else. It does not any more: between two
   * aligned members there is one bracket that fits and one way it goes on, so every one of
   * those gestures could only take it off the joint.
   */
  test('a connector stays where the joint put it, whatever is pressed', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await page.getByRole('button', { name: 'L型角码', exact: true }).click()
    await clickWorld(page, [600, 10, 0])
    await toNavigate(page)
    await clickWorld(page, [600, 10, 0])
    const c0 = (await store(page)).connectors[0]
    expect((await store(page)).selectedIds).toEqual([c0.id])

    await page.getByTestId('rot-x-plus').click()
    await page.getByTestId('rot-z-plus').click()
    expect((await store(page)).connectors[0].quaternion).toEqual(c0.quaternion)

    const before = (await store(page)).connectors[0].position.map(r)
    await dragWorld(page, [600, 10, 0], [600, 10, 200])
    expect((await store(page)).connectors[0].position.map(r)).toEqual(before)
  })

  test('a connector shows where it is but has no field to move it', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await page.getByRole('button', { name: '端盖', exact: true }).click()
    await clickWorld(page, [600, 10, 0])
    await toNavigate(page)
    await clickWorld(page, [600, 10, 0])
    await expect(page.getByTestId('connector-position')).toBeVisible()
    await expect(page.getByTestId('connector-position').locator('input')).toHaveCount(0)
  })
})

test.describe('Interference is reported, never blocked', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); await setView(page, [1900, 1500, 2300], [300, 400, 200]) })

  test('rotating a member into another one flags both and the panel can select them', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 200], [600, 10, 200])      // rail A
    await drawMember(page, [0, 0, 0], [600, 10, 0])          // rail B, parallel and clear
    await toNavigate(page)
    expect((await conflicts(page)).conflicts).toEqual([])
    await clickWorld(page, [300, 10, 0])
    await page.getByTestId('rot-y-plus').click()             // B turns across A at the same height
    const c = await conflicts(page)
    expect(c.conflicts).toHaveLength(1)
    expect(c.conflicts[0].depth).toBeGreaterThan(0)
    await expect(page.getByTestId('toasts')).toContainText('干涉')
    await expect(page.getByTestId('bom-penetrations')).toHaveText('1 处')
    await page.getByTestId('bom-penetrations').click()
    expect((await store(page)).selectedIds.sort()).toEqual(c.ids.sort())
  })

  test('a rotated member that clears everything is not flagged', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await drawMember(page, [0, 0, 400], [600, 10, 400])
    await toNavigate(page)
    await clickWorld(page, [300, 10, 400])
    await page.getByTestId('rotate-angle').fill('45')
    await page.getByTestId('rot-y-plus').click()
    expect((await conflicts(page)).conflicts).toEqual([])    // diagonal, still clear of the other rail
    await expect(page.getByTestId('bom-penetrations')).toHaveText('无干涉')
  })

  test('undo removes the interference again', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [400, 10, 0])
    expect(await drawMember(page, [100, 10, 0], [300, 10, 0])).toBe(1)
    expect((await conflicts(page)).conflicts).toHaveLength(1)
    await page.keyboard.press('Control+z')
    expect((await store(page)).profiles).toHaveLength(1)
    expect((await conflicts(page)).conflicts).toEqual([])
  })
})

test.describe('Rotated parts survive a save/open round trip', () => {
  test('orientation and conflicts are restored from a project file', async ({ page }) => {
    await useDownloadFallback(page)
    await openApp(page)
    await setView(page, [1900, 1500, 2300], [300, 400, 200])
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 200], [600, 10, 200])
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await toNavigate(page)
    await clickWorld(page, [300, 10, 0])
    await page.getByTestId('rotate-angle').fill('37')
    await page.getByTestId('rot-y-plus').click()
    const before = (await store(page)).profiles.map((p) => [p.position.map(r), p.quaternion.map((v: number) => Math.round(v * 1000))])
    const conflictsBefore = (await conflicts(page)).conflicts.length

    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-project').click()])
    const path = await dl.path()
    await page.getByTestId('clear-all').click()
    await page.getByTestId('clear-all').click()
    expect((await store(page)).profiles).toHaveLength(0)
    await page.locator('input[type=file]').setInputFiles(path!)
    await expect(page.getByTestId('toasts')).toContainText('已载入')
    const after = (await store(page)).profiles.map((p) => [p.position.map(r), p.quaternion.map((v: number) => Math.round(v * 1000))])
    expect(after).toEqual(before)
    expect((await conflicts(page)).conflicts).toHaveLength(conflictsBefore)
  })
})

test.describe('Floor and group rules after the rule change', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); await setView(page, [1900, 1500, 2300], [300, 400, 200]) })

  test('rotating a rail flat on the floor lifts it instead of burying it', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await toNavigate(page)
    await clickWorld(page, [300, 10, 0])
    await page.getByTestId('rot-z-plus').click()      // stands it up about the selection centre
    const p = (await store(page)).profiles[0]
    expect(Math.abs(dirOf(p)[1])).toBeCloseTo(1, 2)   // it really is upright now
    const lowest = Math.min(p.position[1], p.position[1] + p.length * dirOf(p)[1])
    expect(lowest).toBeGreaterThanOrEqual(-0.01)      // and it sits on the floor, not under it
    expect(lowest).toBeLessThan(1)
  })

  test('a group nudged into the floor keeps its shape and adds no empty undo steps', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawExact(page, [0, 0, 0], [0, 300, 0], 500)   // upright from the floor
    await drawMember(page, [0, 0, 300], [600, 10, 300])  // rail at y=10
    await toNavigate(page)
    await clickWorld(page, [0, 250, 0])
    await clickWorld(page, [300, 10, 300], { modifiers: ['Control'] })
    const before = (await store(page)).profiles.map((p) => p.position.map(r))
    const gap = before[1][1] - before[0][1]
    await page.keyboard.press('PageDown')               // the upright is already on the floor
    const after = (await store(page)).profiles.map((p) => p.position.map(r))
    expect(after).toEqual(before)                       // rigid: nothing moved, nothing deformed
    expect(after[1][1] - after[0][1]).toBe(gap)
    const past = (await store(page)).past
    await page.keyboard.press('PageDown')
    expect((await store(page)).past).toBe(past)         // and no history entry for a blocked move
  })

  test('Alt+drag of a group stops at the floor', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await drawMember(page, [0, 0, 300], [600, 10, 300])
    await toNavigate(page)
    await clickWorld(page, [300, 10, 0])
    await clickWorld(page, [300, 10, 300], { modifiers: ['Control'] })
    await dragWorld(page, [300, 10, 0], [300, -400, 0], ['Alt'])
    const ys = (await store(page)).profiles.map((p) => r(p.position[1]))
    expect(ys).toEqual([10, 10])
  })

  test('a connector does not ride along when the members it sits on move', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await page.getByRole('button', { name: 'L型角码', exact: true }).click()
    await clickWorld(page, [600, 10, 0])
    await toNavigate(page)
    await clickWorld(page, [300, 10, 0])
    await clickWorld(page, [600, 10, 0], { modifiers: ['Control'] })
    expect((await store(page)).selectedIds).toHaveLength(2)
    const beforeP = (await store(page)).profiles[0].position.map(r)
    const beforeC = (await store(page)).connectors[0].position.map(r)
    await page.keyboard.press('ArrowRight')
    // the member moves, the bracket stays on the joint it was fitted to
    expect((await store(page)).profiles[0].position.map(r)).toEqual([beforeP[0] + 5, beforeP[1], beforeP[2]])
    expect((await store(page)).connectors[0].position.map(r)).toEqual(beforeC)
  })

  test('a new conflict between already flagged members is still reported', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await drawMember(page, [100, 10, 0], [500, 10, 0])     // conflict pair 1
    await drawMember(page, [0, 0, 400], [600, 10, 400])
    await drawMember(page, [100, 10, 400], [500, 10, 400]) // conflict pair 2
    await toNavigate(page)
    expect((await conflicts(page)).conflicts).toHaveLength(2)
    const ids = (await conflicts(page)).ids
    expect(ids).toHaveLength(4)
    await clickWorld(page, [300, 10, 400])
    const dismiss = page.getByTestId('toasts')
    await expect(dismiss).toBeVisible()
    await page.waitForTimeout(3800)                        // let earlier toasts expire
    for (let i = 0; i < 8; i++) await page.keyboard.press('Shift+ArrowUp')   // drag pair 2 onto pair 1
    expect((await conflicts(page)).conflicts.length).toBeGreaterThan(2)
    await expect(page.getByTestId('toasts')).toContainText('干涉')
  })

  test('clearing the angle box disables the rotate buttons instead of rotating by zero', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await toNavigate(page)
    await clickWorld(page, [300, 10, 0])
    await page.getByTestId('rotate-angle').fill('')
    await expect(page.getByTestId('rot-y-plus')).toBeDisabled()
    await page.getByTestId('rotate-angle').fill('45')
    await expect(page.getByTestId('rot-y-plus')).toBeEnabled()
    await page.getByTestId('rot-y-plus').click()
    expect(dirOf((await store(page)).profiles[0]).map(round2)).toEqual([0.71, 0, -0.71])
  })
})

test.describe('The panel counts what the canvas paints', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); await setView(page, [1900, 1500, 2300], [300, 400, 200]) })

  // The canvas asked about boards and fittings and the panel did not, so a board through a
  // post was painted red while the count beside it said there was nothing wrong.
  test('a board through a post is counted, and pressing the count selects the board', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [300, 0, 0], [300, 600, 0])
    await drawMember(page, [900, 0, 0], [900, 600, 0])   // the count shows once there are two
    await toNavigate(page)
    await page.evaluate(() => (window as any).__aluframe.store.getState().addPanels([{
      id: 'b-through', width: 400, height: 300, thickness: 18,
      position: [300, 300, 0], quaternion: [0, 0, 0, 1], material: 'mdf',
    }]))
    const c = await conflicts(page)
    expect(c.ids).toContain('b-through')
    await expect(page.getByTestId('bom-penetrations')).toHaveText('1 处')
    await page.getByTestId('bom-penetrations').click()
    expect((await store(page)).selectedIds).toContain('b-through')
  })
})
