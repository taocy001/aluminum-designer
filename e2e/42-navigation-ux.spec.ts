import { test, expect, type Page } from '@playwright/test'
import { openApp, settle, store, tool, setView, w2c, enterDraw, drawExact, clickWorld, hoverWorld } from './helpers'

const camera = (page: Page) => page.evaluate(() => {
  const w = (window as any).__aluframe
  return { position: w.camera.position.toArray(), target: w.controls.target.toArray(), enabled: w.controls.enabled }
})

async function singleMember(page: Page) {
  await enterDraw(page)
  await drawExact(page, [0, 0, 0], [600, 10, 0], 600)
  await page.keyboard.press('Escape')
  await clickWorld(page, [300, 10, 0])
  expect((await store(page)).selectedIds).toHaveLength(1)
}

test.beforeEach(async ({ page }) => openApp(page))

test('view controls and help preserve a typed drawing draft', async ({ page }) => {
  await enterDraw(page)
  await clickWorld(page, [0, 0, 0])
  await hoverWorld(page, [600, 10, 0])
  await page.keyboard.type('350')
  const draft = await tool(page)
  for (const name of ['zoom-in', 'zoom-out', 'fit-view', 'view-top', 'view-front', 'view-right', 'view-iso', 'labels-toggle', 'help-toggle']) {
    await page.getByTestId(name).click()
    await settle(page)
    expect(await tool(page)).toMatchObject({ isDrawing: true, start: draft.start, cur: draft.cur })
    await expect(page.getByTestId('precise-input')).toHaveValue('350')
    expect((await store(page)).profiles).toHaveLength(0)
  }
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('help-panel')).toHaveCount(0)
  expect((await tool(page)).isDrawing).toBe(true)
  await page.getByTestId('precise-input').press('Enter')
  expect((await store(page)).profiles[0].length).toBe(350)
})

test('standard views preserve the target and fit respects the narrow canvas and chosen direction', async ({ page }) => {
  await page.getByTestId('template-bench').click()
  await page.getByTestId('template-place').click()
  await page.getByTestId('fit-view').click()
  const before = await camera(page)
  for (const [view, axis] of [['top', 1], ['front', 2], ['right', 0]] as const) {
    await page.getByTestId(`view-${view}`).click()
    await settle(page)
    const after = await camera(page)
    expect(after.target).toEqual(before.target)
    const delta = after.position.map((v: number, i: number) => v - after.target[i])
    expect(delta[axis]).toBeGreaterThan(100)
    expect(delta.filter((_: number, i: number) => i !== axis).every((v: number) => Math.abs(v) < 0.01)).toBe(true)
  }
  await page.setViewportSize({ width: 390, height: 844 })
  // The sidebar can be collapsed through its ordinary UI after resizing a desktop page.
  const collapse = page.getByTestId('sidebar-collapse')
  if (await collapse.isVisible()) await collapse.click()
  await page.getByTestId('view-front').click()
  await page.getByTestId('fit-view').click()
  await settle(page)
  const fit = await camera(page)
  expect(Math.abs(fit.position[0] - fit.target[0])).toBeLessThan(0.01)
  const bounds = await page.locator('canvas').boundingBox()
  expect(bounds).not.toBeNull()
  for (const point of [[-20, 0, -20], [1520, 920, 720]]) {
    const projected = await w2c(page, point as [number, number, number])
    expect(projected.x).toBeGreaterThan(bounds!.x)
    expect(projected.x).toBeLessThan(bounds!.x + bounds!.width)
    expect(projected.y).toBeGreaterThan(bounds!.y)
    expect(projected.y).toBeLessThan(bounds!.y + bounds!.height)
  }
})

test('rotation arcs own their press, preserve the camera and release it after cancellation', async ({ page }) => {
  await singleMember(page)
  const arc = await page.evaluate(() => (window as any).__aluframe.gizmoHandles().find((h: any) => h.kind === 'rotate' && h.axis === 'y').position)
  const c = await w2c(page, arc)
  await page.mouse.move(c.x, c.y)
  await settle(page)
  expect(await page.evaluate(() => (window as any).__aluframe.tool.getState().gizmoHover)).toEqual({ kind: 'rotate', axis: 'y' })
  const before = await store(page)
  const view = await camera(page)
  await page.mouse.down()
  expect((await camera(page)).enabled).toBe(false)
  await page.mouse.move(c.x + 65, c.y - 30, { steps: 8 })
  await page.mouse.up()
  expect((await camera(page)).position).toEqual(view.position)
  expect((await store(page)).profiles).toEqual(before.profiles)
  expect((await camera(page)).enabled).toBe(true)
  await page.mouse.click(c.x, c.y)
  await settle(page)
  expect((await store(page)).profiles[0].quaternion).not.toEqual(before.profiles[0].quaternion)
  expect((await store(page)).past).toBe(before.past + 1)
  expect((await camera(page)).position).toEqual(view.position)
  await page.keyboard.press('Control+z')
  await settle(page)
  await page.mouse.move(c.x, c.y)
  await page.mouse.down()
  await page.keyboard.press('Escape')
  await page.mouse.up()
  expect((await camera(page)).enabled).toBe(true)
  expect((await store(page)).profiles).toEqual(before.profiles)
})

test('returning the pointer from the toolbar gives Tab to overlapping parts', async ({ page }) => {
  await page.evaluate(() => {
    const w = (window as any).__aluframe
    w.store.getState().loadDocument({ profiles: [0, 100, 200].map((z) => ({ id: `p-${z}`, spec: '2020', length: 600,
      position: [0, 300, z], quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2], holes: [], miterCuts: [] })), connectors: [], panels: [], fittings: [] })
  })
  await page.getByTestId('fit-view').click()
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('view-top')).toBeFocused()
  await page.getByTestId('view-front').click()
  await setView(page, [300, 300, 1600], [300, 300, 0])
  await hoverWorld(page, [300, 300, 200])
  await expect(page.getByTestId('viewport')).toBeFocused()
  const before = await page.evaluate(() => (window as any).__aluframe.tool.getState().hoverCandidates)
  expect(before.count).toBe(3)
  await page.keyboard.press('Tab')
  expect(await page.evaluate(() => (window as any).__aluframe.tool.getState().hoverCandidates.index)).toBe(1)
})

test('clicking a rotation arc with a profile in hand rotates once without starting a drawing', async ({ page }) => {
  await singleMember(page)
  await enterDraw(page)
  const before = await store(page)
  const arc = await page.evaluate(() => (window as any).__aluframe.gizmoHandles().find((h: any) => h.kind === 'rotate' && h.axis === 'y').position)
  const c = await w2c(page, arc)
  await page.mouse.move(c.x, c.y)
  await settle(page)
  await page.mouse.click(c.x, c.y)
  await settle(page)
  expect((await store(page)).profiles[0].quaternion).not.toEqual(before.profiles[0].quaternion)
  expect((await store(page)).past).toBe(before.past + 1)
  expect((await store(page)).profiles).toHaveLength(1)
  expect(await tool(page)).toMatchObject({ held: 'profile', isDrawing: false })
  await expect(page.getByTestId('draw-hud')).toHaveCount(0)
})

test('pivot state stays visible and Escape closes narrow tools before clearing selection', async ({ page }) => {
  await singleMember(page)
  await page.keyboard.press('p')
  await expect(page.getByTestId('pivot-toggle')).toContainText('起点')
  await expect(page.getByTestId('pivot-toggle')).toHaveAccessibleName('支点: 起点 (P)')
  await page.keyboard.press('p')
  await expect(page.getByTestId('pivot-toggle')).toContainText('终点')
  const selected = (await store(page)).selectedIds
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByTestId('mobile-tools-toggle').click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('mobile-tools-toggle')).toHaveAttribute('aria-expanded', 'false')
  expect((await store(page)).selectedIds).toEqual(selected)
})

test('phone tools and view controls remain reachable above an open bottom panel', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByTestId('sidebar')).toBeVisible()
  const toolbar = page.getByTestId('viewport-toolbar')
  const views = page.getByTestId('standard-views')
  for (const language of ['zh', 'en']) {
    if (language === 'en') await page.getByRole('button', { name: 'English', exact: true }).click()
    for (const expanded of [false, true]) {
      if (expanded) await page.getByTestId('mobile-tools-toggle').click()
      await expect(page.getByTestId('mobile-tools-toggle')).toHaveAttribute('aria-expanded', String(expanded))
      const toolbarRect = await toolbar.boundingBox()
      const viewsRect = await views.boundingBox()
      expect(toolbarRect!.y + toolbarRect!.height).toBeLessThan(viewsRect!.y)
      const helpRect = await page.getByTestId('help-toggle').boundingBox()
      expect(helpRect!.x + helpRect!.width).toBeLessThan(viewsRect!.x)
      for (const view of ['top', 'front', 'right', 'iso']) {
        const button = page.getByTestId(`view-${view}`)
        const rect = await button.boundingBox()
        expect(rect!.width).toBeGreaterThanOrEqual(44)
        expect(rect!.height).toBeGreaterThanOrEqual(44)
        await button.click()
      }
      if (expanded) {
        const lastTool = page.getByTestId('zoom-in')
        await lastTool.scrollIntoViewIfNeeded()
        expect(await lastTool.evaluate(el => {
          const r = el.getBoundingClientRect()
          return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
        })).toBe(true)
        await lastTool.click()
        await page.keyboard.press('Escape')
      }
      await page.getByTestId('help-toggle').click()
      await expect(page.getByTestId('help-panel')).toBeVisible()
      const helpPanel = page.getByTestId('help-panel')
      const panelRect = await helpPanel.boundingBox()
      const viewport = await page.getByTestId('viewport').boundingBox()
      expect(panelRect!.y).toBeGreaterThanOrEqual(viewport!.y)
      expect(panelRect!.y + panelRect!.height).toBeLessThan(viewsRect!.y)
      expect(panelRect!.x + panelRect!.width).toBeLessThanOrEqual(viewport!.x + viewport!.width)
      await helpPanel.getByRole('button').click()
      await expect(helpPanel).toHaveCount(0)
    }
  }
})

test('fast exact input keeps every digit and Escape gives control back to the canvas', async ({ page }) => {
  await singleMember(page)
  const from = await w2c(page, [300, 10, 0]), to = await w2c(page, [300, 10, 70])
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await settle(page)
  await page.keyboard.type('900')
  await expect(page.getByTestId('exact-input')).toHaveValue('900')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('exact-input')).not.toBeFocused()
  await page.keyboard.press('Escape')
  expect((await tool(page)).isDragging).toBe(false)
  const stopped = (await store(page)).profiles
  await page.mouse.move(to.x + 90, to.y, { steps: 6 })
  await page.mouse.up()
  expect((await store(page)).profiles).toEqual(stopped)
})


test('tablet toolbars keep every visible action inside the canvas with or without a held profile', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1180 })
  const toolbar = page.getByTestId('viewport-toolbar')
  for (const holding of [false, true]) {
    if (holding) await page.getByTestId('spec-2040').click()
    await settle(page)
    const viewport = await page.getByTestId('viewport').boundingBox()
    expect(viewport).not.toBeNull()
    const buttons = toolbar.locator('button:visible')
    expect(await buttons.count()).toBeGreaterThan(10)
    for (const button of await buttons.all()) {
      const rect = await button.boundingBox()
      expect(rect).not.toBeNull()
      expect(rect!.x).toBeGreaterThanOrEqual(viewport!.x)
      expect(rect!.x + rect!.width).toBeLessThanOrEqual(viewport!.x + viewport!.width)
      expect(rect!.y).toBeGreaterThanOrEqual(viewport!.y)
      expect(rect!.y + rect!.height).toBeLessThanOrEqual(viewport!.y + viewport!.height)
    }
    await expect(page.getByTestId('pivot-toggle')).toContainText('中心')
    await expect(page.getByTestId('fit-view')).toBeVisible()
    await page.getByTestId('fit-view').click()
    if (holding) await expect(page.getByTestId('held-chip')).toContainText('2040')
    else await expect(page.getByTestId('held-chip')).toBeDisabled()
  }
})
