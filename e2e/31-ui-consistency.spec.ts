import { test, expect, type Page } from '@playwright/test'
import { configureFitting, openApp, store, tool, setView, w2c, dragHold } from './helpers'

async function beam(page: Page) {
  await page.evaluate(() => {
    const s = (window as any).__aluframe.store.getState()
    s.loadDocument({ profiles: [{ id: 'beam', spec: '2020', length: 600, position: [0, 10, 0],
      quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2], miterCuts: [], holes: [] }], connectors: [], panels: [], fittings: [] })
    s.selectItems(['beam'])
    ;(window as any).__aluframe.tool.getState().putDown()
  })
  await setView(page, [1200, 900, 1500], [300, 200, 0])
}

async function boards(page: Page, locked = false) {
  await page.evaluate((locked) => {
    const s = (window as any).__aluframe.store.getState()
    const panels = ['a', 'b'].map((id, i) => ({ id, width: 500, height: 300, thickness: 18,
      material: 'mdf', position: [700 * i, 300, 0], quaternion: [0, 0, 0, 1], locked }))
    s.loadDocument({ profiles: [], connectors: [], panels, fittings: [] })
    s.selectItems(['a', 'b'])
  }, locked)
}

test.describe('Editing and focused controls', () => {
  test.beforeEach(async ({ page }) => { await openApp(page) })

  test('typing changes every selected board as one undoable edit', async ({ page }) => {
    await boards(page)
    const before = (await store(page)).past
    const width = page.getByTestId('panel-props').locator('input').first()
    await width.fill('750')
    await width.press('Enter')
    expect((await store(page)).panels.map((p) => p.width)).toEqual([750, 750])
    expect((await store(page)).past).toBe(before + 1)
    await page.getByTestId('viewport').focus()
    await page.keyboard.press('Control+z')
    expect((await store(page)).panels.map((p) => p.width)).toEqual([500, 500])
  })

  test('invalid board drafts are restored without writing geometry or history', async ({ page }) => {
    await boards(page)
    const before = (await store(page)).past
    const width = page.getByTestId('panel-props').locator('input').first()
    await width.fill('1')
    await width.press('Enter')
    await expect(width).toHaveValue('500')
    expect((await store(page)).panels.map((p) => p.width)).toEqual([500, 500])
    expect((await store(page)).past).toBe(before)
  })

  test('locked boards disable sizing; unlocked boards retain their delete action', async ({ page }) => {
    await boards(page, true)
    await expect(page.getByTestId('panel-props').locator('input').first()).toBeDisabled()
    await expect(page.getByTestId('delete-selected')).toBeDisabled()
    await boards(page, false)
    await expect(page.getByTestId('delete-selected')).toBeEnabled()
    await page.getByTestId('delete-selected').click()
    expect((await store(page)).panels).toHaveLength(0)
  })

  test('mixed board locks disable edits until only the unlocked board is selected', async ({ page }) => {
    await boards(page)
    await page.evaluate(() => {
      const s = (window as any).__aluframe.store.getState()
      s.commitDocument({ panels: s.panels.map((b: any, i: number) => i ? { ...b, width: 600 } : { ...b, locked: true }) })
    })
    const width = page.getByTestId('panel-props').locator('input').first()
    const material = page.getByTestId('panel-material')
    const mixed = await store(page)
    await expect(width).toBeDisabled()
    await expect(material).toBeDisabled()
    await expect(page.getByTestId('panel-locked-hint')).toContainText('先解锁')
    expect(await store(page)).toEqual(mixed)
    await page.evaluate(() => (window as any).__aluframe.store.getState().selectItems(['b']))
    await expect(width).toBeEnabled()
    await expect(material).toBeEnabled()
    await expect(width).toHaveValue('600')
    const before = (await store(page)).past
    expect(before).toBe(mixed.past)
    await width.fill('760')
    await width.press('Enter')
    await page.getByTestId('panel-material').selectOption('ply')
    expect((await store(page)).panels.map((b) => [b.width, b.material])).toEqual([[500, 'mdf'], [760, 'ply']])
    expect((await store(page)).past).toBe(before + 2)
    await page.getByTestId('viewport').focus()
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+z')
    expect((await store(page)).panels.map((b) => [b.width, b.material])).toEqual([[500, 'mdf'], [600, 'mdf']])
  })

  test('fittings lock on their own and their size edits apply to the selected set', async ({ page }) => {
    await page.evaluate(() => {
      const s = (window as any).__aluframe.store.getState()
      const fittings = ['a', 'b'].map((id, i) => ({ id, kind: 'door', width: 500, height: 700,
        depth: 600, position: [700 * i, 400, 0], quaternion: [0, 0, 0, 1], material: 'mdf',
        hinge: 'left', hingeType: 'cup', overlay: 'full', swing: 110, open: 0 }))
      s.loadDocument({ profiles: [], connectors: [], panels: [], fittings })
      s.selectItems(['a', 'b'])
    })
    const width = page.getByTestId('fitting-props').locator('input[type=number]').first()
    await width.fill('760')
    await width.press('Enter')
    expect((await store(page)).fittings.map((p) => p.width)).toEqual([760, 760])
    await page.evaluate(() => (window as any).__aluframe.store.getState().selectItems(['a']))
    await page.getByTestId('lock-toggle').click()
    expect((await store(page)).fittings[0].locked).toBe(true)
    await expect(page.getByTestId('lock-toggle')).toHaveAttribute('aria-pressed', 'true')
  })

  test('mixed fitting locks disable edits until only the unlocked door is selected', async ({ page }) => {
    await page.evaluate(() => {
      const s = (window as any).__aluframe.store.getState()
      s.loadDocument({ profiles: [], connectors: [], panels: [], fittings: ['a', 'b'].map((id, i) => ({
        id, kind: 'door', width: i ? 600 : 500, height: 700, depth: 600, frame: 20,
        position: [800 * i, 400, 0], quaternion: [0, 0, 0, 1], material: 'mdf',
        hinge: 'left', hingeType: 'cup', overlay: 'full', swing: 110, open: 0, locked: !i,
      })) })
      s.selectItems(['a', 'b'])
    })
    const width = page.getByTestId('fitting-props').locator('input[type=number]').first()
    const angle = page.getByTestId('fitting-angle-165')
    const mixed = await store(page)
    await expect(width).toBeDisabled()
    await expect(angle).toBeDisabled()
    await expect(page.getByTestId('fitting-locked-hint')).toContainText('先解锁')
    expect(await store(page)).toEqual(mixed)
    await page.evaluate(() => (window as any).__aluframe.store.getState().selectItems(['b']))
    await expect(width).toBeEnabled()
    await expect(angle).toBeEnabled()
    await expect(width).toHaveValue('600')
    expect((await store(page)).past).toBe(mixed.past)
    await width.fill('760')
    await width.press('Enter')
    await angle.click()
    expect((await store(page)).fittings.map((f) => [f.width, f.swing])).toEqual([[500, 110], [760, 165]])
    expect((await store(page)).past).toBe(mixed.past + 2)
    await page.getByTestId('viewport').focus()
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+z')
    expect((await store(page)).fittings.map((f) => [f.width, f.swing])).toEqual([[500, 110], [600, 110]])
    expect((await store(page)).past).toBe(mixed.past)
  })

  test('Space activates a focused specification button', async ({ page }) => {
    await page.getByTestId('spec-2020').focus()
    await page.keyboard.press('Space')
    expect((await tool(page)).held).toBe('profile')
    await expect(page.getByTestId('quick-menu')).toHaveCount(0)
  })

  test('input select-all and undo stay with the input; viewing cannot undo the design', async ({ page }) => {
    await page.evaluate(() => {
      const s = (window as any).__aluframe.store.getState()
      const beam = { id: 'a', spec: '2020', length: 600, position: [0, 10, 0],
        quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2], miterCuts: [], holes: [] }
      s.loadDocument({ profiles: [beam], connectors: [], panels: [], fittings: [] })
      s.addItems([{ ...beam, id: 'b', position: [0, 500, 0] }], [], false)
      s.selectItems(['a'])
    })
    const before = await store(page)
    await page.getByTestId('sidebar-tab-inspect').click()
    await page.getByTestId('stock-length').focus()
    await page.keyboard.press('Control+a')
    expect((await store(page)).selectedIds).toEqual(['a'])
    await page.keyboard.press('Control+z')
    expect((await store(page)).past).toBe(before.past)
    await page.getByTestId('mode-toggle').click()
    await page.getByTestId('viewport').focus()
    await page.keyboard.press('Control+z')
    expect((await store(page)).profiles).toHaveLength(2)
    expect((await store(page)).past).toBe(before.past)
  })

  test('clipboard rejection produces a failure instead of copied feedback', async ({ page }) => {
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: () => Promise.reject(new Error('denied')) } }))
    await page.getByTestId('file-menu').click()
    await page.getByTestId('share-link').click()
    await expect(page.getByTestId('toasts')).toContainText('复制失败')
    await expect(page.getByTestId('toasts')).not.toContainText('已复制')
  })

  test('entering view mode finishes an active drag and prevents later pointer movement from changing the design', async ({ page }) => {
    await beam(page)
    const from = await w2c(page, [300, 10, 0])
    await dragHold(page, from, { x: from.x + 90, y: from.y })
    expect((await tool(page)).isDragging).toBe(true)
    // A UI mode change cancels the gesture; keyboard mode shortcuts wait until it ends.
    await page.evaluate(() => (window as any).__aluframe.tool.getState().setViewMode(true))
    expect((await tool(page)).isDragging).toBe(false)
    const stopped = await store(page)
    await page.mouse.move(from.x + 160, from.y + 30)
    await page.mouse.up()
    expect((await store(page)).profiles).toEqual(stopped.profiles)
    expect((await store(page)).past).toBe(stopped.past)
  })

  test('locking a part during a drag protects it for the rest of that gesture', async ({ page }) => {
    await beam(page)
    const from = await w2c(page, [300, 10, 0])
    await dragHold(page, from, { x: from.x + 90, y: from.y })
    await page.evaluate(() => (window as any).__aluframe.store.getState().toggleLockSelected())
    const locked = await store(page)
    expect(locked.profiles[0].locked).toBe(true)
    await page.mouse.move(from.x + 180, from.y + 30)
    await page.mouse.up()
    expect((await store(page)).profiles).toEqual(locked.profiles)
  })

  test('a consumed resize still allows a later resize of the same part to create its own undo entry', async ({ page }) => {
    await beam(page)
    const from = await w2c(page, [598, 10, 0])
    await dragHold(page, from, { x: from.x + 60, y: from.y })
    await page.evaluate(() => document.querySelector('canvas')!.dispatchEvent(new Event('aluframe:consume-pointer')))
    await page.mouse.up()
    const before = await store(page)
    const next = await w2c(page, [before.profiles[0].length - 2, 10, 0])
    await dragHold(page, next, { x: next.x + 60, y: next.y })
    await page.mouse.up()
    expect((await store(page)).past).toBe(before.past + 1)
    await page.keyboard.press('Control+z')
    expect((await store(page)).profiles[0].length).toBe(before.profiles[0].length)
  })

  test('a rotation handle pressed before entering view mode cannot rotate on release', async ({ page }) => {
    await beam(page)
    const handle = await page.evaluate(() => (window as any).__aluframe.gizmoHandles().find((h: any) => h.kind === 'rotate' && h.axis === 'y'))
    const from = await w2c(page, handle.position)
    const before = await store(page)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.evaluate(() => (window as any).__aluframe.tool.getState().setViewMode(true))
    await page.mouse.up()
    expect((await store(page)).profiles).toEqual(before.profiles)
    expect((await store(page)).past).toBe(before.past)
  })

  test('empty and invalid drawer drafts never create corrupt fittings', async ({ page }) => {
    await page.getByTestId('template-cabinet').click()
    await page.getByTestId('template-place').click()
    await page.evaluate(() => {
      const s = (window as any).__aluframe.store.getState()
      s.selectItems(s.profiles.map((p: any) => p.id))
    })
    const before = await store(page)
    await configureFitting(page, 'drawer')
    await page.getByTestId('drawer-height').fill('')
    await expect(page.getByTestId('add-drawer')).toBeDisabled()
    await configureFitting(page, 'drawer')
    await page.getByTestId('drawer-height').fill('200')
    await page.getByTestId('drawer-count').fill('1.5')
    await expect(page.getByTestId('add-drawer')).toBeDisabled()
    expect((await store(page)).fittings).toEqual(before.fittings)
    expect((await store(page)).past).toBe(before.past)
    await configureFitting(page, 'drawer')
    await page.getByTestId('drawer-count').fill('1')
    await expect(page.getByTestId('add-drawer')).toBeEnabled()
    await configureFitting(page, 'drawer')
    await page.getByTestId('add-drawer').click()
    expect((await store(page)).fittings).toHaveLength(1)
  })
})

test.describe('Responsive layout and real touch', () => {
  test.use({ hasTouch: true })
  for (const width of [719, 720, 744, 767, 768]) {
    test(`the canvas is visible at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await openApp(page)
      const viewport = await page.getByTestId('viewport').boundingBox()
      expect(viewport!.y).toBeLessThan(100)
      expect(viewport!.height).toBeGreaterThan(500)
      if (width < 768) await expect(page.getByTestId('sidebar-rail')).toBeVisible()
    })
  }

  test('phone tools have text and a 44px target; a hold does not start drawing on release', async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openApp(page)
    await expect(page.getByTestId('measure-toggle')).toHaveText('测量')
    expect((await page.getByTestId('measure-toggle').boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await page.getByTestId('mobile-tools-toggle').click()
    await expect(page.getByTestId('labels-toggle')).toBeVisible()
    await page.getByTestId('mobile-tools-toggle').click()
    await page.getByTestId('sidebar-expand').click()
    await page.getByTestId('spec-2020').click()
    await page.getByTestId('sidebar-collapse').click()
    await expect(page.getByTestId('sidebar')).toHaveCount(0)
    const viewport = await page.locator('canvas').boundingBox()
    const cdp = await context.newCDPSession(page)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: viewport!.x + viewport!.width / 2, y: viewport!.y + viewport!.height / 2 }] })
    await expect(page.getByTestId('quick-menu')).toBeVisible()
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    expect((await tool(page)).isDrawing).toBe(false)
    expect((await store(page)).profiles).toHaveLength(0)
  })

  test('English drawing controls follow the toolbar and keep More tools reachable', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openApp(page)
    await page.getByRole('button', { name: 'English', exact: true }).click()
    await page.getByTestId('sidebar-expand').click()
    await page.getByTestId('spec-2020').click()
    await page.getByTestId('sidebar-collapse').click()
    const point = await w2c(page, [300, 0, 200])
    await page.mouse.click(point.x, point.y)
    await expect(page.getByTestId('draw-hud')).toBeVisible()
    const toolbar = await page.getByTestId('viewport-toolbar').boundingBox()
    const hud = await page.getByTestId('draw-hud').boundingBox()
    expect(hud!.y).toBeGreaterThanOrEqual(toolbar!.y + toolbar!.height)
    await page.getByTestId('mobile-tools-toggle').click()
    await expect(page.getByTestId('labels-toggle')).toBeVisible()
    const expanded = await page.getByTestId('viewport-toolbar').boundingBox()
    await expect.poll(async () => (await page.getByTestId('draw-hud').boundingBox())!.y).toBeGreaterThanOrEqual(expanded!.y + expanded!.height)
    await page.getByTestId('mobile-tools-toggle').click()
  })

  test('a moved two-finger gesture never undoes, while a sequential clean tap does', async ({ page }) => {
    await openApp(page)
    await page.evaluate(() => {
      const s = (window as any).__aluframe.store.getState()
      const p = { id: 'a', spec: '2020', length: 600, position: [0, 0, 0],
        quaternion: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], miterCuts: [], holes: [] }
      s.loadDocument({ profiles: [p], connectors: [], panels: [], fittings: [] })
      s.addItems([{ ...p, id: 'b', position: [500, 0, 0] }], [], false)
      const canvas = document.querySelector('canvas')!
      const touches = (x: number) => [new Touch({ identifier: 1, target: canvas, clientX: x, clientY: 450 }),
        new Touch({ identifier: 2, target: canvas, clientX: 760, clientY: 450 })]
      canvas.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: touches(700) }))
      canvas.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: touches(650) }))
      canvas.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] }))
    })
    expect((await store(page)).profiles).toHaveLength(2)
    await page.evaluate(() => {
      const canvas = document.querySelector('canvas')!
      const touches = [new Touch({ identifier: 1, target: canvas, clientX: 700, clientY: 450 }),
        new Touch({ identifier: 2, target: canvas, clientX: 760, clientY: 450 })]
      canvas.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches }))
      canvas.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [touches[1]] }))
      canvas.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] }))
    })
    expect((await store(page)).profiles).toHaveLength(1)
  })
})
