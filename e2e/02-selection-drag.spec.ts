import { test, expect } from '@playwright/test'
import { openApp, enterDraw, drawMember, drawExact, clickWorld, dragWorld, store, tool, conflicts, endpoints, r, w2c } from './helpers'

async function toNavigate(page: any) {
  await page.keyboard.press('Escape')
  if ((await tool(page)).held !== null) await page.keyboard.press('Escape')
  expect((await tool(page)).held).toBe(null)
}

/** two parallel X rails and one upright */
async function scene(page: any) {
  await enterDraw(page, '2020')
  await drawMember(page, [0, 0, 0], [400, 10, 0])       // rail A (0..400, z=0)
  await drawMember(page, [0, 0, 300], [400, 10, 300])   // rail B (z=300)
  await drawExact(page, [700, 0, 0], [700, 300, 0], 500) // upright C at x=700
  await toNavigate(page)
  const ps = (await store(page)).profiles
  return { A: ps[0], B: ps[1], C: ps[2] }
}

test.describe('Selection', () => {
  test.beforeEach(async ({ page }) => { await openApp(page) })

  test('click selects, Ctrl+click toggles, empty click clears, Esc clears', async ({ page }) => {
    const { A, B } = await scene(page)
    await clickWorld(page, [200, 10, 0])
    expect((await store(page)).selectedIds).toEqual([A.id])
    await expect(page.getByTestId('properties')).toBeVisible()
    await clickWorld(page, [200, 10, 300], { modifiers: ['Control'] })
    expect((await store(page)).selectedIds.sort()).toEqual([A.id, B.id].sort())
    await clickWorld(page, [200, 10, 300], { modifiers: ['Control'] })
    expect((await store(page)).selectedIds).toEqual([A.id])
    await clickWorld(page, [-400, 0, -400]) // empty floor
    expect((await store(page)).selectedIds).toEqual([])
    await clickWorld(page, [200, 10, 0])
    await page.keyboard.press('Escape')
    expect((await store(page)).selectedIds).toEqual([])
  })

  test('toolbar clicks do not clear the selection', async ({ page }) => {
    const { A } = await scene(page)
    await clickWorld(page, [200, 10, 0])
    await page.getByText('标注').click()
    expect((await store(page)).selectedIds).toEqual([A.id])
  })

  test('box select picks members inside the rectangle only', async ({ page }) => {
    const { A, B, C } = await scene(page)
    await page.getByTestId('select-toggle').click()
    expect((await tool(page)).selectMode).toBe(true)
    // rectangle = screen bbox of rails A and B plus a margin; upright C must project outside it
    const pts = await Promise.all(([[0, 10, 0], [400, 10, 0], [0, 10, 300], [400, 10, 300]] as [number, number, number][]).map((p) => w2c(page, p)))
    const cPt = await w2c(page, [700, 250, 0])
    const x1 = Math.min(...pts.map((p) => p.x)) - 25, x2 = Math.max(...pts.map((p) => p.x)) + 25
    const y1 = Math.min(...pts.map((p) => p.y)) - 25, y2 = Math.max(...pts.map((p) => p.y)) + 25
    expect(cPt.x < x1 || cPt.x > x2 || cPt.y < y1 || cPt.y > y2).toBe(true)
    await page.mouse.move(x1, y1); await page.mouse.down()
    await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2)
    await page.mouse.move(x2, y2); await page.mouse.up()
    await page.waitForTimeout(50)
    const sel = (await store(page)).selectedIds
    expect(sel).toContain(A.id); expect(sel).toContain(B.id); expect(sel).not.toContain(C.id)
    await expect(page.getByTestId('properties')).toContainText('已选中 2')
    await page.keyboard.press('Escape')
    expect((await tool(page)).selectMode).toBe(false)
  })

  test('Delete removes the selection as one undoable step', async ({ page }) => {
    const { A, B } = await scene(page)
    await clickWorld(page, [200, 10, 0])
    await clickWorld(page, [200, 10, 300], { modifiers: ['Control'] })
    await page.keyboard.press('Delete')
    let s = await store(page)
    expect(s.profiles.map((p) => p.id)).not.toContain(A.id)
    expect(s.profiles).toHaveLength(1)
    await page.keyboard.press('Control+z')
    s = await store(page)
    expect(s.profiles).toHaveLength(3)
    expect(s.profiles.map((p) => p.id)).toContain(B.id)
  })
})

test.describe('Drag', () => {
  test.beforeEach(async ({ page }) => { await openApp(page) })

  test('drags a member on its own height plane, snapped to the 5 mm grid, as one undo step', async ({ page }) => {
    const { A } = await scene(page)
    await dragWorld(page, [200, 10, 0], [200, 10, 150])
    const a = (await store(page)).profiles.find((p) => p.id === A.id)!
    expect(r(a.position[0])).toBe(0); expect(r(a.position[1])).toBe(10)
    expect(Math.abs(a.position[2] - 150)).toBeLessThanOrEqual(5)
    expect(a.position[2] % 5).toBe(0)
    expect((await tool(page)).isDragging).toBe(false)
    const past = (await store(page)).past
    await page.keyboard.press('Control+z')
    expect((await store(page)).profiles.find((p) => p.id === A.id)!.position.map(r)).toEqual([0, 10, 0])
    expect((await store(page)).past).toBe(past - 1)
  })

  test('a plain click on a member does not add an undo entry', async ({ page }) => {
    await scene(page)
    const before = (await store(page)).past
    await clickWorld(page, [200, 10, 0])
    expect((await store(page)).past).toBe(before)
  })

  test('drag snaps an end onto another member endpoint', async ({ page }) => {
    const { A, B } = await scene(page)
    // move rail B so that its start lands ~7mm from A's end (400,10,0) → snaps exactly
    await dragWorld(page, [200, 10, 300], [605, 10, 3])
    const b = (await store(page)).profiles.find((p) => p.id === B.id)!
    expect(b.position.map(r)).toEqual([400, 10, 0])
    expect(A.position.map(r)).toEqual([0, 10, 0])
  })

  test('Alt+drag moves vertically and uprights cannot sink below the floor', async ({ page }) => {
    const { C } = await scene(page)
    await dragWorld(page, [700, 250, 0], [700, 400, 0], ['Alt'])
    let c = (await store(page)).profiles.find((p) => p.id === C.id)!
    expect(r(c.position[1])).toBeGreaterThanOrEqual(140)
    expect(r(c.position[0])).toBe(700); expect(r(c.position[2])).toBe(0)
    await dragWorld(page, [700, c.position[1] + 200, 0], [700, -500, 0], ['Alt'])
    c = (await store(page)).profiles.find((p) => p.id === C.id)!
    expect(r(c.position[1])).toBe(0)
  })

  test('horizontal members cannot be dragged below the floor', async ({ page }) => {
    const { A } = await scene(page)
    await dragWorld(page, [200, 10, 0], [200, -300, 0], ['Alt'])
    const a = (await store(page)).profiles.find((p) => p.id === A.id)!
    expect(r(a.position[1])).toBe(10)
  })

  test('a drag onto another member is allowed and both are flagged', async ({ page }) => {
    const { A, B } = await scene(page)
    await dragWorld(page, [200, 10, 0], [200, 10, 300])
    const a = (await store(page)).profiles.find((p) => p.id === A.id)!
    const b = (await store(page)).profiles.find((p) => p.id === B.id)!
    expect(Math.abs(a.position[2] - b.position[2])).toBeLessThan(20)   // it really moved on top of B
    const c = await conflicts(page)
    expect(c.ids.sort()).toEqual([A.id, B.id].sort())
  })

  test('group drag moves every selected member by the same offset', async ({ page }) => {
    const { A, B } = await scene(page)
    await clickWorld(page, [200, 10, 0])
    await clickWorld(page, [200, 10, 300], { modifiers: ['Control'] })
    await dragWorld(page, [200, 10, 0], [200, 10, -200])
    const s = await store(page)
    const a = s.profiles.find((p) => p.id === A.id)!
    const b = s.profiles.find((p) => p.id === B.id)!
    expect(Math.abs(a.position[2] + 200)).toBeLessThanOrEqual(5)
    expect(r(a.position[0])).toBe(0); expect(r(a.position[1])).toBe(10)
    expect(r(b.position[2] - a.position[2])).toBe(300)   // same offset for the whole group
    expect(s.selectedIds.sort()).toEqual([A.id, B.id].sort()) // selection survives the drag
  })
})

test.describe('Keyboard editing', () => {
  test.beforeEach(async ({ page }) => { await openApp(page) })

  test('arrow keys nudge 5 mm, Shift 50 mm, PageUp/PageDown vertical; interference only warns', async ({ page }) => {
    const { A, B } = await scene(page)
    await clickWorld(page, [200, 10, 0])
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Shift+ArrowDown')
    await page.keyboard.press('PageUp')
    let a = (await store(page)).profiles.find((p) => p.id === A.id)!
    expect(a.position.map(r)).toEqual([5, 15, 50])
    await page.keyboard.press('PageDown'); await page.keyboard.press('PageDown')
    a = (await store(page)).profiles.find((p) => p.id === A.id)!
    expect(r(a.position[1])).toBe(10) // floor clamp
    // push into rail B (z=300): the move goes through and the pair is flagged instead
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowDown')
    a = (await store(page)).profiles.find((p) => p.id === A.id)!
    expect(r(a.position[2])).toBe(300)
    await expect(page.getByTestId('toasts')).toContainText('干涉')
    expect((await conflicts(page)).ids.sort()).toEqual([A.id, B.id].sort())
  })

  test('Ctrl+D duplicates and selects the copies; R rotates 90°; Ctrl+Z / Ctrl+Y round-trip', async ({ page }) => {
    const { A } = await scene(page)
    await clickWorld(page, [200, 10, 0])
    await page.keyboard.press('Control+d')
    let s = await store(page)
    expect(s.profiles).toHaveLength(4)
    expect(s.selectedIds).toHaveLength(1)
    expect(s.selectedIds[0]).not.toBe(A.id)
    const copy = s.profiles.find((p) => p.id === s.selectedIds[0])!
    expect(copy.length).toBe(400)
    await page.keyboard.press('r')
    s = await store(page)
    const rotated = s.profiles.find((p) => p.id === copy.id)!
    const e = endpoints(rotated)
    expect(r(e.end[0] - e.start[0])).toBe(0)   // now along Z
    expect(Math.abs(r(e.end[2] - e.start[2]))).toBe(400)
    await page.keyboard.press('Control+z')
    expect(endpoints((await store(page)).profiles.find((p) => p.id === copy.id)!).end[0]).toBeCloseTo(copy.position[0] + 400, 3)
    await page.keyboard.press('Control+z')
    expect((await store(page)).profiles).toHaveLength(3)
    await page.keyboard.press('Control+y')
    expect((await store(page)).profiles).toHaveLength(4)
  })

  test('F fits the view to the frame', async ({ page }) => {
    await scene(page)
    const before = await page.evaluate(() => (window as any).__aluframe.camera.position.toArray())
    await page.keyboard.press('f')
    await page.waitForTimeout(100)
    const after = await page.evaluate(() => (window as any).__aluframe.camera.position.toArray())
    expect(after).not.toEqual(before)
  })
})
