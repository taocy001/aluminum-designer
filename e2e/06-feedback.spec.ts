import { test, expect, type Page } from '@playwright/test'
import { openApp, setView, enterDraw, drawMember, drawExact, clickWorld, hoverWorld, dragWorld, dragHold, store, tool, conflicts, cursor, hoverId, w2c, r, type V3 } from './helpers'

async function toNavigate(page: Page) {
  await page.keyboard.press('Escape')
  if ((await tool(page)).viewMode !== 'navigate') await page.keyboard.press('Escape')
  expect((await tool(page)).viewMode).toBe('navigate')
}

test.describe('Drag plane follows the grab point', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); await setView(page, [1900, 1500, 2300], [300, 400, 200]) })

  test('dragging an upright by its middle moves it with the cursor, not across the floor', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawExact(page, [0, 0, 0], [0, 300, 0], 800)
    await toNavigate(page)
    const post = (await store(page)).profiles[0]
    expect(post.position.map(r)).toEqual([0, 0, 0])
    // grab at mid height and move 300 mm along +X at that same height
    await dragWorld(page, [0, 400, 0], [300, 400, 0])
    const moved = (await store(page)).profiles[0]
    expect(moved.position.map(r)).toEqual([300, 0, 0])   // before the fix this leapt hundreds of mm across the floor
    expect(moved.length).toBe(800)
  })

  test('Alt+drag of an upright stays on its own axis', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawExact(page, [0, 0, 0], [0, 300, 0], 600)
    await toNavigate(page)
    await dragWorld(page, [0, 300, 0], [0, 500, 0], ['Alt'])
    const p = (await store(page)).profiles[0]
    expect(r(p.position[0])).toBe(0); expect(r(p.position[2])).toBe(0)
    expect(p.position[1]).toBeGreaterThan(100)
  })
})

test.describe('Selection survives orbiting', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page); await setView(page, [1900, 1500, 2300], [300, 400, 200])
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await drawMember(page, [0, 0, 400], [600, 10, 400])
    await toNavigate(page)
  })

  test('dragging empty space orbits and keeps the selection; a plain click clears it', async ({ page }) => {
    await clickWorld(page, [300, 10, 0])
    const sel = (await store(page)).selectedIds
    expect(sel).toHaveLength(1)
    const before = await page.evaluate(() => (window as any).__aluframe.camera.position.toArray())
    const a = await w2c(page, [-600, 0, -600])
    await dragHold(page, a, { x: a.x + 160, y: a.y + 60 })
    await page.mouse.up()
    await page.waitForTimeout(50)
    const after = await page.evaluate(() => (window as any).__aluframe.camera.position.toArray())
    expect(after).not.toEqual(before)                       // the camera did orbit
    expect((await store(page)).selectedIds).toEqual(sel)    // and the selection is still there
    await clickWorld(page, [-600, 0, -600])
    expect((await store(page)).selectedIds).toEqual([])
  })
})

test.describe('Interfering drags are visible, not blocked', () => {
  test('a drag onto another member goes through, flags both and changes the cursor', async ({ page }) => {
    await openApp(page); await setView(page, [1900, 1500, 2300], [300, 400, 200])
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await drawMember(page, [0, 0, 300], [600, 10, 300])
    await toNavigate(page)
    const from = await w2c(page, [300, 10, 300])
    const to = await w2c(page, [300, 10, 0])
    await dragHold(page, from, to)
    expect(await cursor(page)).toBe('alias')          // the pointer marks the interference
    expect((await conflicts(page)).ids).toHaveLength(2)
    await page.mouse.up()
    await page.waitForTimeout(50)
    const zs = (await store(page)).profiles.map((p) => r(p.position[2])).sort((x, y) => x - y)
    expect(zs[1] - zs[0]).toBeLessThan(20)            // the member really did move there
    await expect(page.getByTestId('bom-penetrations')).toHaveText('1 处')
  })
})

test.describe('Exact length input never fails silently', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); await setView(page, [1900, 1500, 2300], [300, 400, 200]); await enterDraw(page, '2020') })

  test('typing a length immediately after the first click explains what is missing', async ({ page }) => {
    await clickWorld(page, [0, 0, 0])
    expect((await tool(page)).isDrawing).toBe(true)
    await expect(page.getByTestId('draw-hud')).toBeVisible()   // HUD is up before an axis exists
    await page.keyboard.type('600')
    await expect(page.getByTestId('precise-input')).toHaveValue('600')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('toasts')).toContainText('先移动鼠标')
    expect((await store(page)).profiles).toHaveLength(0)
    // now give it a direction and the same input works
    await hoverWorld(page, [300, 10, 0])
    await page.keyboard.press('Enter')
    const ps = (await store(page)).profiles
    expect(ps).toHaveLength(1)
    expect(ps[0].length).toBe(600)
  })

  test('a length below the minimum is refused with a toast and the value is kept', async ({ page }) => {
    await clickWorld(page, [0, 0, 0])
    await hoverWorld(page, [300, 10, 0])
    await page.keyboard.type('4')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('toasts')).toContainText('太短')
    await expect(page.getByTestId('precise-input')).toHaveValue('4')
    expect((await store(page)).profiles).toHaveLength(0)
  })
})

test.describe('Picking thin members', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); await setView(page, [2600, 2000, 3000], [300, 400, 200]) })

  test('a click a few pixels beside a thin beam still selects it, and hovering highlights it', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await toNavigate(page)
    const c = await w2c(page, [300, 10, 0])
    await page.mouse.move(c.x, c.y + 6)
    await page.waitForTimeout(60)
    const id = (await store(page)).profiles[0].id
    expect(await hoverId(page)).toBe(id)
    expect(await cursor(page)).toBe('grab')
    await page.mouse.click(c.x, c.y + 6)
    expect((await store(page)).selectedIds).toEqual([id])
  })

  test('where two members cover each other on screen, the nearer one is picked', async ({ page }) => {
    // both posts stand in the vertical plane through the camera, so they project onto the same screen line
    await enterDraw(page, '2020')
    await drawExact(page, [600, 0, 0], [600, 300, 0], 800)          // far post
    await drawExact(page, [1100, 0, 750], [1100, 300, 750], 800)    // near post, between camera and the far one
    await toNavigate(page)
    const { profiles } = await store(page)
    const far = profiles[0], near = profiles[1]
    const best = await page.evaluate(() => {
      const W = (window as any).__aluframe.worldToClient
      let best: any = null
      for (let yf = 40; yf <= 780; yf += 10) {
        const a = W(600, yf, 0)
        for (let yn = 40; yn <= 780; yn += 10) {
          const b = W(1100, yn, 750)
          const d = Math.hypot(a.x - b.x, a.y - b.y)
          if (!best || d < best.d) best = { d, x: b.x, y: b.y }
        }
      }
      return best
    })
    expect(best.d).toBeLessThan(6)     // they really do cover each other on screen
    await page.mouse.click(best.x, best.y)
    const sel = (await store(page)).selectedIds
    expect(sel).toEqual([near.id])
    expect(sel).not.toContain(far.id)
  })

  test('Ctrl+click only toggles the selection, it never starts a drag', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await drawMember(page, [0, 0, 300], [600, 10, 300])
    await toNavigate(page)
    const { profiles } = await store(page)
    await clickWorld(page, [300, 10, 0])
    const a = await w2c(page, [300, 10, 300])
    await page.keyboard.down('Control')
    await dragHold(page, a, { x: a.x + 60, y: a.y + 20 })
    expect((await tool(page)).isDragging).toBe(false)   // Ctrl+press adds to the selection, it does not grab
    await page.mouse.up()
    await page.keyboard.up('Control')
    expect((await store(page)).selectedIds.sort()).toEqual(profiles.map((p) => p.id).sort())
    expect((await store(page)).profiles.map((p) => p.position.map(r))).toEqual([[0, 10, 0], [0, 10, 300]])
  })
})

test.describe('Drawing cannot get stuck', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); await setView(page, [1900, 1500, 2300], [300, 400, 200]); await enterDraw(page, '2020') })

  test('pressing outside the canvas cancels the draw and says so', async ({ page }) => {
    await clickWorld(page, [0, 0, 0])
    await hoverWorld(page, [300, 10, 0])
    expect((await tool(page)).isDrawing).toBe(true)
    await page.getByTestId('fit-view').click()
    expect((await tool(page)).isDrawing).toBe(false)
    await expect(page.getByTestId('toasts')).toContainText('已取消绘制')
    expect((await store(page)).profiles).toHaveLength(0)
  })

  test('right-drag orbits without cancelling; right-click cancels', async ({ page }) => {
    await clickWorld(page, [0, 0, 0])
    await hoverWorld(page, [300, 10, 0])
    const c = await w2c(page, [300, 10, 0])
    const before = await page.evaluate(() => (window as any).__aluframe.camera.position.toArray())
    await page.mouse.move(c.x, c.y)
    await page.mouse.down({ button: 'right' })
    for (let i = 1; i <= 6; i++) { await page.mouse.move(c.x + i * 20, c.y + i * 6); await page.waitForTimeout(15) }
    await page.mouse.up({ button: 'right' })
    await page.waitForTimeout(60)
    expect(await page.evaluate(() => (window as any).__aluframe.camera.position.toArray())).not.toEqual(before)
    expect((await tool(page)).isDrawing).toBe(true)     // the draw survived the orbit
    await clickWorld(page, [300, 10, 0], { button: 'right' })
    expect((await tool(page)).isDrawing).toBe(false)
    await expect(page.getByTestId('toasts')).toContainText('已取消绘制')
  })

  test('the cursor reports the mode: crosshair while drawing, grabbing while dragging', async ({ page }) => {
    expect(await cursor(page)).toBe('crosshair')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await toNavigate(page)
    expect(await cursor(page)).toBe('default')
    const c = await w2c(page, [300, 10, 0])
    await dragHold(page, c, { x: c.x + 40, y: c.y + 10 })
    expect(await cursor(page)).toBe('grabbing')
    await page.mouse.up()
  })
})

test.describe('Regressions caught in review', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); await setView(page, [1900, 1500, 2300], [300, 400, 200]) })

  test('a connector sitting on a member endpoint can still be selected and deleted', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await page.getByRole('button', { name: 'L型角码', exact: true }).click()
    await clickWorld(page, [600, 10, 0])
    const { connectors, profiles } = await store(page)
    expect(connectors).toHaveLength(1)
    await toNavigate(page)
    await clickWorld(page, [600, 10, 0])
    expect((await store(page)).selectedIds).toEqual([connectors[0].id])   // the member underneath must not win
    await page.keyboard.press('Delete')
    const after = await store(page)
    expect(after.connectors).toHaveLength(0)
    expect(after.profiles.map((p) => p.id)).toEqual(profiles.map((p) => p.id))
  })

  test('in box-select mode a plain click still picks a member', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await drawMember(page, [0, 0, 300], [600, 10, 300])
    await toNavigate(page)
    const { profiles } = await store(page)
    await page.getByTestId('select-toggle').click()
    expect((await tool(page)).selectMode).toBe(true)
    await clickWorld(page, [300, 10, 0])
    expect((await store(page)).selectedIds).toEqual([profiles[0].id])
    await clickWorld(page, [300, 10, 300], { modifiers: ['Control'] })
    expect((await store(page)).selectedIds.sort()).toEqual(profiles.map((p) => p.id).sort())
  })

  test('Ctrl+click on empty space keeps the batch selection', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await drawMember(page, [0, 0, 300], [600, 10, 300])
    await toNavigate(page)
    await clickWorld(page, [300, 10, 0])
    await clickWorld(page, [300, 10, 300], { modifiers: ['Control'] })
    expect((await store(page)).selectedIds).toHaveLength(2)
    await clickWorld(page, [-600, 0, -600], { modifiers: ['Control'] })
    expect((await store(page)).selectedIds).toHaveLength(2)   // a stray Ctrl+miss must not wipe it
    await clickWorld(page, [-600, 0, -600])
    expect((await store(page)).selectedIds).toHaveLength(0)
  })

  test('the camera does not move while a member is being dragged', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await toNavigate(page)
    const before = await page.evaluate(() => (window as any).__aluframe.camera.position.toArray())
    const c = await w2c(page, [300, 10, 0])
    await dragHold(page, c, { x: c.x + 120, y: c.y + 40 })
    expect(await page.evaluate(() => (window as any).__aluframe.camera.position.toArray())).toEqual(before)
    await page.mouse.up()
    expect(await page.evaluate(() => (window as any).__aluframe.camera.position.toArray())).toEqual(before)
    // orbiting still works afterwards
    const a = await w2c(page, [-600, 0, -600])
    await dragWorld(page, [-600, 0, -600], [-600, 0, -600])
    await dragHold(page, a, { x: a.x + 150, y: a.y + 50 })
    await page.mouse.up()
    expect(await page.evaluate(() => (window as any).__aluframe.camera.position.toArray())).not.toEqual(before)
  })

  test('hover highlight clears when the pointer leaves the canvas or box-select starts', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await toNavigate(page)
    const c = await w2c(page, [300, 10, 0])
    await page.mouse.move(c.x, c.y)
    await page.waitForTimeout(50)
    expect(await hoverId(page)).not.toBeNull()
    await page.getByTestId('select-toggle').click()
    await page.mouse.move(c.x, c.y)
    await page.waitForTimeout(50)
    expect(await hoverId(page)).toBeNull()
  })

  test('Enter with an empty box asks for a length, not "too short"', async ({ page }) => {
    await enterDraw(page, '2020')
    await clickWorld(page, [0, 0, 0])
    await hoverWorld(page, [300, 10, 0])
    await page.getByTestId('precise-input').click()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('toasts')).toContainText('请先输入长度')
    await expect(page.getByTestId('toasts')).not.toContainText('太短')
  })

  test('a left-click release does not swallow a pending right-click cancel', async ({ page }) => {
    await enterDraw(page, '2020')
    await clickWorld(page, [0, 0, 0])
    await hoverWorld(page, [300, 10, 0])
    const c = await w2c(page, [300, 10, 0])
    await page.mouse.move(c.x, c.y)
    await page.mouse.down({ button: 'right' })
    await page.mouse.down({ button: 'left' })
    await page.mouse.up({ button: 'left' })
    await page.mouse.up({ button: 'right' })
    await page.waitForTimeout(60)
    expect((await tool(page)).isDrawing).toBe(false)
    await expect(page.getByTestId('toasts')).toContainText('已取消绘制')
  })
})
