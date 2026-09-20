import { test, expect } from '@playwright/test'
import { openApp, enterDraw, drawMember, drawExact, clickWorld, hoverWorld, store, tool, conflicts, endpoints, r } from './helpers'

test.describe('Drawing', () => {
  test.beforeEach(async ({ page }) => { await openApp(page) })

  test('draws a floor member along X, lifted to rest on the floor', async ({ page }) => {
    await enterDraw(page, '2020')
    expect(await drawMember(page, [0, 0, 0], [400, 10, 0])).toBe(1)
    const [p] = (await store(page)).profiles
    expect(p.length).toBe(400)
    expect(p.position.map(r)).toEqual([0, 10, 0])  // centerline lifted by half height
    expect(p.spec).toBe('2020')
    await expect(page.getByTestId('bom-count')).toHaveText('1')
  })

  test('draws along Z and Y from the floor; all three axes resolve correctly', async ({ page }) => {
    await enterDraw(page, '2020')
    expect(await drawMember(page, [0, 0, 300], [0, 10, 700])).toBe(1)
    expect(await drawMember(page, [500, 0, 0], [500, 400, 0])).toBe(1)
    const ps = (await store(page)).profiles
    const z = endpoints(ps[0]); const y = endpoints(ps[1])
    expect(z.start.map(r)).toEqual([0, 10, 300]); expect(z.end.map(r)).toEqual([0, 10, 700])
    expect(y.start.map(r)).toEqual([500, 0, 0]); expect(y.end.map(r)).toEqual([500, 400, 0])
  })

  test('snaps the start to an existing endpoint and shows the snap marker', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [400, 10, 0])
    await hoverWorld(page, [403, 10, 2]) // near the end (400,10,0)
    expect((await tool(page)).snap).toBe(true)
    await clickWorld(page, [403, 10, 2])
    expect((await tool(page)).start).toEqual([400, 10, 0])
    await hoverWorld(page, [400, 300, 0])
    expect((await tool(page)).drawAxis).toBe('y')
    await clickWorld(page, [400, 300, 0])
    const ps = (await store(page)).profiles
    expect(ps).toHaveLength(2)
    expect(ps[1].position.map(r)).toEqual([400, 10, 0])
    expect(ps[1].length).toBe(290)
  })

  test('exact length via keyboard beats the mouse position', async ({ page }) => {
    await enterDraw(page, '2020')
    expect(await drawExact(page, [0, 0, 0], [0, 300, 0], 800)).toBe(1)
    const [p] = (await store(page)).profiles
    expect(p.length).toBe(800)
    expect(endpoints(p).end.map(r)).toEqual([0, 800, 0])
    expect((await tool(page)).isDrawing).toBe(false)
  })

  test('snaps the end length to a remote endpoint (alignment guide)', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawExact(page, [0, 0, 0], [0, 300, 0], 803)
    await clickWorld(page, [600, 0, 0])
    await hoverWorld(page, [600, 800, 0])
    expect((await tool(page)).cur).toEqual([600, 803, 0])
    await clickWorld(page, [600, 800, 0])
    expect((await store(page)).profiles[1].length).toBe(803)
  })

  test('starts from a member centerline (T-joint) and trims the upright', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await hoverWorld(page, [300, 10, 0])
    expect((await tool(page)).snap).toBe(true)
    await clickWorld(page, [300, 10, 0])
    expect((await tool(page)).start).toEqual([300, 10, 0])
    await hoverWorld(page, [300, 400, 0])
    await clickWorld(page, [300, 400, 0])
    const ps = (await store(page)).profiles
    expect(ps).toHaveLength(2)
    // select it and read the cut length: 390 centerline − 10 (rail half height) = 380
    await page.keyboard.press('Escape')
    expect((await tool(page)).viewMode).toBe('navigate')
    await clickWorld(page, [300, 200, 0])
    expect((await store(page)).selectedIds).toHaveLength(1)
    await expect(page.getByTestId('cut-length')).toHaveText('380 mm')
  })

  test('an interfering member is still placed, flagged in red with a warning', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [400, 10, 0])
    expect(await drawMember(page, [100, 10, 0], [300, 10, 0])).toBe(1)
    await expect(page.getByTestId('toasts')).toContainText('干涉')
    expect((await tool(page)).isDrawing).toBe(false)
    expect((await store(page)).profiles).toHaveLength(2)
    const c = await conflicts(page)
    expect(c.conflicts).toHaveLength(1)
    expect(c.ids).toHaveLength(2)
    await expect(page.getByTestId('bom-penetrations')).toHaveText('1 处')
  })

  test('a shelf between rails is clean, a member crossing it mid-span is flagged', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await drawMember(page, [0, 0, 400], [600, 10, 400])
    expect(await drawMember(page, [300, 10, 0], [300, 10, 400])).toBe(1)     // shelf: ends on both rails
    expect((await conflicts(page)).conflicts).toEqual([])
    expect(await drawMember(page, [0, 10, 200], [600, 10, 200])).toBe(1)     // crosses the shelf mid-span
    await expect(page.getByTestId('toasts')).toContainText('干涉')
    expect((await conflicts(page)).conflicts).toHaveLength(1)
  })

  test('axis lock keys and right-click cancel', async ({ page }) => {
    await enterDraw(page, '2020')
    await clickWorld(page, [0, 0, 0])
    await hoverWorld(page, [400, 0, 0])
    expect((await tool(page)).drawAxis).toBe('x')
    await page.keyboard.press('z')
    await hoverWorld(page, [400, 0, 50])
    expect((await tool(page)).drawAxis).toBe('z')
    await page.keyboard.press('z') // unlock
    await hoverWorld(page, [400, 0, 0])
    expect((await tool(page)).drawAxis).toBe('x')
    await clickWorld(page, [400, 0, 0], { button: 'right' })
    expect((await tool(page)).isDrawing).toBe(false)
    expect((await store(page)).profiles).toHaveLength(0)
  })

  test('Escape cancels a draw, then leaves draw mode', async ({ page }) => {
    await enterDraw(page, '3030')
    await clickWorld(page, [0, 0, 0])
    expect((await tool(page)).isDrawing).toBe(true)
    await page.keyboard.press('Escape')
    expect((await tool(page)).isDrawing).toBe(false)
    expect((await tool(page)).viewMode).toBe('draw')
    await page.keyboard.press('Escape')
    expect((await tool(page)).viewMode).toBe('navigate')
  })

  test('every spec draws and lifts by its own half height', async ({ page }) => {
    const expectY: Record<string, number> = { '2020': 10, '2040': 20, '3030': 15, '3040': 20, '4040': 20 }
    let z = 0
    for (const spec of Object.keys(expectY)) {
      await enterDraw(page, spec)
      expect(await drawMember(page, [0, 0, z], [300, expectY[spec], z])).toBe(1)
      const ps = (await store(page)).profiles
      const p = ps[ps.length - 1]
      expect(p.spec).toBe(spec)
      expect(r(p.position[1])).toBe(expectY[spec])
      z += 100
    }
    await expect(page.getByTestId('bom-count')).toHaveText('5')
  })

  test('too-short click is ignored and a member under 10 mm is refused', async ({ page }) => {
    await enterDraw(page, '2020')
    await clickWorld(page, [0, 0, 0])
    await clickWorld(page, [0, 0, 0])   // same point → still drawing
    expect((await tool(page)).isDrawing).toBe(true)
    await hoverWorld(page, [300, 0, 0])
    await page.keyboard.type('5')
    await page.keyboard.press('Enter')
    expect((await store(page)).profiles).toHaveLength(0)
    await page.keyboard.press('Escape')
  })
})
