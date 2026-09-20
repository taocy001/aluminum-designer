import { test, expect, type Page } from '@playwright/test'
import { openApp, setView, enterDraw, drawMember, drawExact, clickWorld, hoverWorld, dragHold, dragWorld, store, tool, w2c, r } from './helpers'

async function toNavigate(page: Page) {
  await page.keyboard.press('Escape')
  if ((await tool(page)).viewMode !== 'navigate') await page.keyboard.press('Escape')
  expect((await tool(page)).viewMode).toBe('navigate')
}
const cam = (page: Page) => page.evaluate(() => (window as any).__aluframe.camera.position.toArray().map(Math.round))
function dirOf(p: any): [number, number, number] {
  const [x, y, z, w] = p.quaternion
  return [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)]
}

test.describe('Orbiting while drawing', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); await setView(page, [1900, 1500, 2300], [300, 400, 200]); await enterDraw(page, '2020') })

  test('press and drag on empty canvas orbits instead of drawing', async ({ page }) => {
    const before = await cam(page)
    const a = await w2c(page, [-600, 0, -600])
    await dragHold(page, a, { x: a.x + 180, y: a.y + 60 })
    await page.mouse.up()
    await page.waitForTimeout(60)
    expect(await cam(page)).not.toEqual(before)
    expect((await tool(page)).isDrawing).toBe(false)     // the press did not start a member
    expect((await store(page)).profiles).toHaveLength(0)
  })

  test('a slow, stationary press still places a point', async ({ page }) => {
    const c = await w2c(page, [0, 0, 0])
    await page.mouse.move(c.x, c.y)
    await page.mouse.down()
    await page.waitForTimeout(500)      // a careful click can take a while
    await page.mouse.up()
    await page.waitForTimeout(60)
    expect((await tool(page)).isDrawing).toBe(true)
    expect((await tool(page)).start).toEqual([0, 0, 0])
  })

  test('a plain click still draws, and orbiting mid-draw keeps the start point', async ({ page }) => {
    await clickWorld(page, [0, 0, 0])
    expect((await tool(page)).isDrawing).toBe(true)
    const before = await cam(page)
    const a = await w2c(page, [-600, 0, -600])
    await dragHold(page, a, { x: a.x + 150, y: a.y + 40 })
    await page.mouse.up()
    await page.waitForTimeout(60)
    expect(await cam(page)).not.toEqual(before)
    expect((await tool(page)).isDrawing).toBe(true)      // still drawing from the same start
    await hoverWorld(page, [600, 10, 0])
    await clickWorld(page, [600, 10, 0])
    expect((await store(page)).profiles).toHaveLength(1)
  })
})

test.describe('Stretching by the end face', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); await setView(page, [1900, 1500, 2300], [300, 400, 200]) })

  test('dragging the far end handle changes the length, the other end stays put', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await toNavigate(page)
    await clickWorld(page, [300, 10, 0])
    const from = await w2c(page, [600, 10, 0])
    const to = await w2c(page, [900, 10, 0])
    await dragHold(page, from, to)
    await page.mouse.up()
    await page.waitForTimeout(60)
    const p = (await store(page)).profiles[0]
    expect(p.position.map(r)).toEqual([0, 10, 0])          // start unchanged
    expect(Math.abs(p.length - 900)).toBeLessThanOrEqual(10)
    await page.keyboard.press('Control+z')
    expect((await store(page)).profiles[0].length).toBe(600)
  })

  test('dragging the near end handle moves that end and keeps the far end fixed', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await toNavigate(page)
    await clickWorld(page, [300, 10, 0])
    const from = await w2c(page, [0, 10, 0])
    const to = await w2c(page, [200, 10, 0])
    await dragHold(page, from, to)
    await page.mouse.up()
    await page.waitForTimeout(60)
    const p = (await store(page)).profiles[0]
    expect(Math.abs(p.position[0] - 200)).toBeLessThanOrEqual(10)
    expect(Math.abs(p.length - 400)).toBeLessThanOrEqual(10)
    expect(r(p.position[0] + p.length)).toBe(600)          // far end held
  })

  test('grabbing the middle still moves the member instead of stretching it', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await toNavigate(page)
    await clickWorld(page, [300, 10, 0])
    const from = await w2c(page, [300, 10, 0])
    const to = await w2c(page, [300, 10, 200])
    await dragHold(page, from, to)
    await page.mouse.up()
    await page.waitForTimeout(60)
    const p = (await store(page)).profiles[0]
    expect(p.length).toBe(600)
    expect(r(p.position[2])).toBeGreaterThan(100)
  })

  test('a stretch cannot go below the minimum length', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await toNavigate(page)
    await clickWorld(page, [300, 10, 0])
    const from = await w2c(page, [600, 10, 0])
    const to = await w2c(page, [-400, 10, 0])
    await dragHold(page, from, to)
    await page.mouse.up()
    await page.waitForTimeout(60)
    expect((await store(page)).profiles[0].length).toBeGreaterThanOrEqual(10)
  })
})

test.describe('Rotation handles on the canvas', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); await setView(page, [1900, 1500, 2300], [300, 400, 200]) })

  test('dragging a handle arc rotates the selection as one undo step', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawExact(page, [300, 0, 0], [300, 300, 0], 600)
    await toNavigate(page)
    await clickWorld(page, [300, 300, 0])
    const before = dirOf((await store(page)).profiles[0])
    const past = (await store(page)).past

    // find a point on a handle arc by hovering only — a probe drag would orbit the camera
    let hit: { x: number; y: number } | null = null
    for (let angle = 0; angle < 360 && !hit; angle += 10) {
      for (const radius of [30, 45, 60, 75, 90, 110, 130]) {
        const pivot = await w2c(page, [300, 300, 0])   // re-projected: the camera may have moved
        const x = pivot.x + Math.cos(angle * Math.PI / 180) * radius
        const y = pivot.y + Math.sin(angle * Math.PI / 180) * radius
        await page.mouse.move(x, y)
        await page.waitForTimeout(25)
        const onHandle = await page.evaluate(() => {
          const t = (window as any).__aluframe.tool.getState()
          return !t.hoverProfileId && !t.gizmoSuppressed && !!(window as any).__aluframe.gizmoAxis?.()
        })
        if (onHandle) { hit = { x, y }; break }
      }
    }
    if (hit) {
      await page.mouse.move(hit.x, hit.y)
      await page.mouse.down()
      await page.mouse.move(hit.x + 45, hit.y + 35); await page.waitForTimeout(30)
      await page.mouse.move(hit.x + 90, hit.y + 70); await page.waitForTimeout(30)
      await page.mouse.up()
      await page.waitForTimeout(50)
    }
    expect(hit, 'a rotation handle was found and dragged').not.toBeNull()
    expect(dirOf((await store(page)).profiles[0])).not.toEqual(before)
    expect((await store(page)).past).toBe(past + 1)       // exactly one undo entry
    await page.keyboard.press('Control+z')
    expect(dirOf((await store(page)).profiles[0]).map((v) => Math.round(v * 100) / 100))
      .toEqual(before.map((v) => Math.round(v * 100) / 100))
  })

  test('the handles can be switched off from the toolbar', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await toNavigate(page)
    await clickWorld(page, [300, 10, 0])
    expect(await page.evaluate(() => (window as any).__aluframe.tool.getState().showGizmo)).toBe(true)
    await page.getByTestId('gizmo-toggle').click()
    expect(await page.evaluate(() => (window as any).__aluframe.tool.getState().showGizmo)).toBe(false)
    // with the handles gone, a press anywhere near the member still moves it
    const from = await w2c(page, [300, 10, 0])
    await dragHold(page, from, { x: from.x + 40, y: from.y + 20 })
    expect((await tool(page)).isDragging).toBe(true)
    await page.mouse.up()
  })
})

test.describe('Sidebar panels', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); await setView(page, [1900, 1500, 2300], [300, 400, 200]) })

  test('sections collapse and the choice is remembered across a reload', async ({ page }) => {
    await expect(page.getByTestId('section-components-body')).toBeVisible()
    await page.getByTestId('section-components').click()
    await expect(page.getByTestId('section-components-body')).toBeHidden()
    await page.reload()
    await page.waitForFunction(() => (window as any).__aluframe?.setView)
    await expect(page.getByTestId('section-components-body')).toBeHidden()
    await page.getByTestId('section-components').click()
    await expect(page.getByTestId('section-components-body')).toBeVisible()
  })

  test('the whole panel collapses to a rail and comes back', async ({ page }) => {
    await expect(page.getByTestId('sidebar')).toBeVisible()
    await page.getByTestId('sidebar-collapse').click()
    await expect(page.getByTestId('sidebar')).toBeHidden()
    await expect(page.getByTestId('sidebar-rail')).toBeVisible()
    await page.getByTestId('sidebar-expand').click()
    await expect(page.getByTestId('sidebar')).toBeVisible()
  })

  test('selecting a member reveals the properties section even when it was collapsed', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await toNavigate(page)
    await page.getByTestId('section-properties').click()
    await expect(page.getByTestId('section-properties-body')).toBeHidden()
    await clickWorld(page, [300, 10, 0])
    await expect(page.getByTestId('section-properties-body')).toBeVisible()
    await expect(page.getByTestId('rotate-block')).toBeVisible()
    await expect(page.getByTestId('cut-length')).toBeVisible()
  })

  test('the properties section stays usable with the BOM open on a short window', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await toNavigate(page)
    await clickWorld(page, [300, 10, 0])
    await page.getByTestId('rotate-block').scrollIntoViewIfNeeded()
    const box = await page.getByTestId('rotate-block').boundingBox()
    expect(box).not.toBeNull()
    expect(box!.height).toBeGreaterThan(20)                       // not squeezed to nothing
    expect(box!.y + box!.height).toBeLessThanOrEqual(720)         // reachable inside the window
    // collapsing the parts library frees enough space to see it without scrolling at all
    await page.getByTestId('section-components').click()
    await page.getByTestId('sidebar-scroll').evaluate((el) => { el.scrollTop = 0 })
    const box2 = await page.getByTestId('rotate-block').boundingBox()
    expect(box2!.y + box2!.height).toBeLessThanOrEqual(720)
  })
})

test.describe('Snapping while dragging', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); await setView(page, [1900, 1500, 2300], [300, 400, 200]) })

  test('a member dropped near another one lands flush against it', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await drawMember(page, [0, 0, 300], [600, 10, 300])
    await toNavigate(page)
    const ids = (await store(page)).profiles.map((p) => p.id)
    // aim 8 mm short of touching: the snap should close the gap
    await dragWorld(page, [300, 10, 300], [300, 10, 28])
    const moved = (await store(page)).profiles.find((p) => p.id === ids[1])!
    expect(r(moved.position[2])).toBe(20)          // 20 mm apart = the two faces touching
    expect((await page.evaluate(() => (window as any).__aluframe.conflicts())).conflicts).toHaveLength(0)
  })

  test('the snap highlights the member it is aligning to', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await drawMember(page, [0, 0, 300], [600, 10, 300])
    await toNavigate(page)
    const ids = (await store(page)).profiles.map((p) => p.id)
    const from = await w2c(page, [300, 10, 300])
    const to = await w2c(page, [300, 10, 30])
    await dragHold(page, from, to)
    const refs = await page.evaluate(() => (window as any).__aluframe.tool.getState().snapRefIds)
    expect(refs).toContain(ids[0])
    await page.mouse.up()
    expect(await page.evaluate(() => (window as any).__aluframe.tool.getState().snapRefIds)).toEqual([])
  })

  test('Shift places a member exactly where it is dropped', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await drawMember(page, [0, 0, 300], [600, 10, 300])
    await toNavigate(page)
    const ids = (await store(page)).profiles.map((p) => p.id)
    await dragWorld(page, [300, 10, 300], [300, 10, 28], ['Shift'])
    const moved = (await store(page)).profiles.find((p) => p.id === ids[1])!
    expect(r(moved.position[2])).toBe(30)          // grid only, no pull towards the neighbour
  })

  test('far from anything a member keeps the position it was dropped at', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await drawMember(page, [0, 0, 300], [600, 10, 300])
    await toNavigate(page)
    const ids = (await store(page)).profiles.map((p) => p.id)
    await dragWorld(page, [300, 10, 300], [300, 10, 500])
    const moved = (await store(page)).profiles.find((p) => p.id === ids[1])!
    expect(Math.abs(moved.position[2] - 500)).toBeLessThanOrEqual(5)
  })

  test('endpoint snapping joins members that meet at an angle, from further away', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [400, 10, 0])        // rail along X
    await drawMember(page, [0, 0, 300], [0, 10, 600])      // rail along Z, elsewhere
    await toNavigate(page)
    const ids = (await store(page)).profiles.map((p) => p.id)
    // grab the Z rail by its start and drop it ~18 mm from the X rail's far end
    await dragWorld(page, [0, 10, 300], [415, 10, 12])
    const moved = (await store(page)).profiles.find((p) => p.id === ids[1])!
    expect(moved.position.map(r)).toEqual([400, 10, 0])
  })
})

test.describe('Stretch refinements from review', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); await setView(page, [1900, 1500, 2300], [300, 400, 200]) })

  test('a click near an end face does not resize anything', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await toNavigate(page)
    await clickWorld(page, [300, 10, 0])
    const past = (await store(page)).past
    await clickWorld(page, [578, 10, 0])            // 22 mm from the end: inside the grab zone
    expect((await store(page)).profiles[0].length).toBe(600)
    expect((await store(page)).past).toBe(past)     // and no undo entry either
  })

  test('a stretch keeps the offset between the press point and the end', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await toNavigate(page)
    await clickWorld(page, [300, 10, 0])
    // press 20 mm short of the end, drag 100 mm: the length should grow by ~100, not jump to the cursor
    const from = await w2c(page, [580, 10, 0])
    const to = await w2c(page, [680, 10, 0])
    await dragHold(page, from, to)
    await page.mouse.up()
    await page.waitForTimeout(60)
    expect(Math.abs((await store(page)).profiles[0].length - 700)).toBeLessThanOrEqual(10)
  })

  test('stretching an upright down to the floor shortens it and leaves the top alone', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawExact(page, [0, 0, 0], [0, 300, 0], 500)
    await toNavigate(page)
    await clickWorld(page, [0, 250, 0])
    const top = (await store(page)).profiles[0].length      // upright spans y 0..500
    const from = await w2c(page, [0, 0, 0])
    const to = await w2c(page, [0, -300, 0])
    await dragHold(page, from, to)
    await page.mouse.up()
    await page.waitForTimeout(60)
    const p = (await store(page)).profiles[0]
    expect(r(p.position[1])).toBe(0)                        // still on the floor
    expect(Math.abs(p.length - top)).toBeLessThanOrEqual(5) // the far end did not run away
  })
})
