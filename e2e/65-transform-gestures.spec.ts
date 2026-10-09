import { test, expect, type Page } from '@playwright/test'
import { openApp, setView, store, w2c, dragHold, settle } from './helpers'

async function fixture(page: Page) {
  await page.evaluate(() => {
    const w = (window as any).__aluframe
    w.store.getState().loadDocument({ profiles: [{ id: 'beam', spec: '2020', length: 500,
      position: [0, 100, 0], quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2], holes: [], miterCuts: [] }], connectors: [], panels: [], fittings: [], equipment: [] })
    w.store.setState({ selectedIds: ['beam'], past: [], future: [] })
    w.tool.getState().putDown()
  })
  await setView(page, [900, 800, 1200], [250, 100, 0])
}

test.beforeEach(async ({ page }) => { await openApp(page); await fixture(page) })

test('Escape rolls a moved part back and keeps selection and redo available', async ({ page }) => {
  await page.evaluate(() => {
    const s = (window as any).__aluframe.store.getState()
    s.updateProfile('beam', { length: 550 }, { history: true }); s.undo()
  })
  const before = await store(page)
  const start = await w2c(page, [150, 110, 0]), end = await w2c(page, [220, 110, 90])
  await dragHold(page, start, end)
  expect((await store(page)).profiles).not.toEqual(before.profiles)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  expect(await store(page)).toEqual(before)
  await page.keyboard.press('Control+Shift+z')
  expect((await store(page)).profiles[0].length).toBe(550)
})

test('Escape cancels a stretched end without keeping an undo entry', async ({ page }) => {
  const before = await store(page)
  await dragHold(page, await w2c(page, [499, 100, 0]), await w2c(page, [640, 100, 0]))
  expect((await store(page)).profiles[0].length).not.toBe(500)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  expect(await store(page)).toEqual(before)
})

test('view and lock shortcuts wait until an active drag ends', async ({ page }) => {
  const before = await store(page)
  await dragHold(page, await w2c(page, [150, 110, 0]), await w2c(page, [220, 110, 90]))
  const moved = await store(page)
  expect(moved.profiles).not.toEqual(before.profiles)
  await page.keyboard.press('v')
  await page.keyboard.press('l')
  expect(await page.evaluate(() => (window as any).__aluframe.tool.getState().viewMode)).toBe(false)
  expect(await store(page)).toEqual(moved)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  expect(await store(page)).toEqual(before)
})

test('rotation drag shows snapped angles and Escape restores the full document', async ({ page }) => {
  const arc = await page.evaluate(() => (window as any).__aluframe.gizmoHandles().find((h: any) => h.kind === 'rotate' && h.axis === 'y').position)
  const start = await w2c(page, arc), before = await store(page)
  await dragHold(page, start, { x: start.x + 80, y: start.y - 40 })
  await expect(page.getByTestId('rotation-angle')).toBeVisible()
  const rotation = await page.evaluate(() => (window as any).__aluframe.tool.getState().rotationGesture)
  expect(rotation.degrees % 15).toBe(0)
  expect((await store(page)).profiles).not.toEqual(before.profiles)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  expect(await store(page)).toEqual(before)
  await expect(page.getByTestId('rotation-angle')).toHaveCount(0)
})

test('quick menu owns keyboard focus and outside press without editing through it', async ({ page }) => {
  await page.mouse.move(600, 300)
  await page.keyboard.press('Space')
  const menu = page.getByTestId('quick-menu')
  await expect(menu.getByRole('menuitem').first()).toBeFocused()
  const before = await store(page)
  await page.keyboard.press('ArrowDown')
  await expect(page.getByTestId('quick-rot-x')).toBeFocused()
  await page.keyboard.press('Delete')
  expect(await store(page)).toEqual(before)
  await page.mouse.click(1100, 800)
  await expect(menu).toHaveCount(0)
  expect(await store(page)).toEqual(before)
})

test('continuous free rotation commits one history entry and supports undo and redo', async ({ page }) => {
  const before = await store(page)
  const arc = await page.evaluate(() => (window as any).__aluframe.gizmoHandles().find((h: any) => h.kind === 'rotate' && h.axis === 'y').position)
  const start = await w2c(page, arc)
  await page.keyboard.down('Shift')
  await dragHold(page, start, { x: start.x + 73, y: start.y - 37 })
  const angle = await page.evaluate(() => (window as any).__aluframe.tool.getState().rotationGesture)
  expect(angle.snapped).toBe(false)
  expect(angle.degrees % 15).not.toBe(0)
  await page.mouse.up()
  await page.keyboard.up('Shift')
  const after = await store(page)
  expect(after.past).toBe(before.past + 1)
  expect(after.profiles).not.toEqual(before.profiles)
  await page.keyboard.press('Control+z')
  expect((await store(page)).profiles).toEqual(before.profiles)
  await page.keyboard.press('Control+Shift+z')
  expect((await store(page)).profiles).toEqual(after.profiles)
})

test('middle drag orbits over parts in box-selection mode without changing them', async ({ page }) => {
  await page.evaluate(() => (window as any).__aluframe.tool.getState().setSelectMode(true))
  await settle(page)
  const before = await store(page)
  const camera = await page.evaluate(() => (window as any).__aluframe.camera.position.toArray())
  const start = await w2c(page, [150, 110, 0])
  await page.mouse.move(start.x, start.y)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(start.x + 100, start.y + 30, { steps: 10 })
  await page.mouse.up({ button: 'middle' })
  await settle(page)
  expect(await page.evaluate(() => (window as any).__aluframe.camera.position.toArray())).not.toEqual(camera)
  expect(await store(page)).toEqual(before)
})
