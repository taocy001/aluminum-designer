import { expect, test } from '@playwright/test'
import { openApp, setView, store, w2c } from './helpers'

for (const kind of ['panel', 'fitting'] as const) test(`${kind} mixed locked selection cannot partially edit properties`, async ({ page }) => {
  await openApp(page)
  await page.evaluate(kind => {
    const api = (window as any).__aluframe
    api.tool.getState().putDown()
    const common = { width: 400, height: 300, position: [0, 300, 0], quaternion: [0, 0, 0, 1] }
    const part = kind === 'panel' ? { ...common, thickness: 18, material: 'ply' }
      : { ...common, kind: 'drawer', depth: 400, frame: 0, material: 'ply', open: 0, overlay: 'inset' }
    const parts = [{ ...part, id: 'free' }, { ...part, id: 'locked', locked: true, position: [1000, 300, 0] }]
    api.store.getState().loadDocument({ profiles: [], connectors: [], fittings: kind === 'fitting' ? parts : [], panels: kind === 'panel' ? parts : [], equipment: [], throughRule: 'rails' })
    api.store.getState().selectItems(['free', 'locked'])
  }, kind)
  await page.getByTestId('sidebar-tab-properties').click()
  const props = page.getByTestId(`${kind}-props`)
  const width = props.getByRole('spinbutton', { name: '宽度（mm）', exact: true })
  await expect(width).toBeDisabled()
  await expect(page.getByTestId(`${kind}-locked-hint`)).toContainText('先解锁')
  const before = await store(page)
  // Unlock only the locked target; then the same batch edit must apply to both.
  await page.evaluate(() => {
    const s = (window as any).__aluframe.store.getState()
    s.selectItems(['locked']); s.toggleLockSelected(); s.selectItems(['free', 'locked'])
  })
  await expect(width).toBeEnabled()
  const unlocked = await store(page)
  await width.fill('420'); await width.press('Enter')
  const after = await store(page)
  expect((kind === 'panel' ? after.panels : after.fittings).map(p => p.width)).toEqual([420, 420])
  expect(after.past).toBe(unlocked.past + 1)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  const restored = await store(page)
  expect((kind === 'panel' ? restored.panels : restored.fittings).map(p => p.width)).toEqual([400, 400])
  expect(before.past).toBe(0)
})

test('existing shelving count is read-only while dimensions remain editable', async ({ page }) => {
  await openApp(page)
  await page.getByTestId('template-shelving').click()
  await page.getByTestId('template-place').click()
  await page.getByTestId('sidebar-tab-properties').click()
  await expect(page.getByTestId('instance-param-shelves')).toHaveAttribute('readonly', '')
  await expect(page.locator('#instance-shelves-help')).toContainText('新建置物架')
  const before = await store(page)
  await page.getByTestId('instance-param-w').fill('1000')
  await page.getByTestId('template-instance-apply').click()
  await expect.poll(async () => (await store(page)).past).toBe(before.past + 1)
  expect((await store(page)).profiles).toHaveLength(before.profiles.length)
})

test('dismissing overlap candidates does not select or drag the canvas and restores focus', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => {
    const api = (window as any).__aluframe
    api.tool.getState().putDown()
    const profile = { id: 'rail', position: [0, 100, 0], quaternion: [0, 0, 0, 1], length: 600, spec: '4040', miterCuts: [], holes: [] }
    api.store.getState().loadDocument({ profiles: [profile], panels: [], fittings: [], connectors: [], equipment: [], throughRule: 'rails' })
    api.store.getState().selectItems(['rail'])
  })
  await setView(page, [900, 800, 1100], [0, 100, 300])
  const hit = await w2c(page, [0, 100, 500])
  const canvas = page.locator('canvas').first()
  const box = (await canvas.boundingBox())!
  const open = async () => {
    await page.evaluate(({ x, y }) => window.dispatchEvent(new CustomEvent('aluframe:overlap', { detail: { x, y } })), { x: box.x + 20, y: box.y + 100 })
    await expect(page.getByTestId('overlap-picker')).toBeVisible()
  }
  await open()
  const before = await store(page)
  await page.mouse.move(hit.x, hit.y); await page.mouse.down()
  await page.mouse.move(hit.x + 80, hit.y + 20, { steps: 6 }); await page.mouse.up()
  await expect(page.getByTestId('overlap-picker')).toBeHidden()
  expect(await store(page)).toEqual(before)
  await expect(canvas).toBeFocused()
  await open()
  await page.keyboard.press('Escape')
  await expect(canvas).toBeFocused()
  expect(await store(page)).toEqual(before)
})

for (const popup of ['overlap-picker', 'quick-menu']) test(`outside Undo only dismisses ${popup}; next click and keyboard activation work`, async ({ page }) => {
  await openApp(page)
  await page.getByTestId('template-cabinet').click()
  await page.getByTestId('template-place').click()
  const canvas = page.locator('canvas').first()
  const box = (await canvas.boundingBox())!
  const open = async () => {
    await page.evaluate(({ x, y, popup }) => {
      if (popup === 'quick-menu') (window as any).__aluframe.tool.getState().openQuickMenu(x, y)
      else window.dispatchEvent(new CustomEvent('aluframe:overlap', { detail: { x, y } }))
    }, { x: box.x + 40, y: box.y + 180, popup })
    await expect(page.getByTestId(popup)).toBeVisible()
  }
  const before = await store(page)
  expect(before.profiles.length).toBeGreaterThan(0)
  const undo = page.getByRole('button', { name: '撤销', exact: true })
  await open()
  await undo.click()
  await expect(page.getByTestId(popup)).toBeHidden()
  expect(await store(page)).toEqual(before)
  if (popup === 'overlap-picker') await expect(canvas).toBeFocused()
  // A separate click must not be swallowed by a leftover capture listener.
  await undo.click()
  expect((await store(page)).profiles).toHaveLength(0)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  const restored = await store(page)
  await open()
  // A cancelled pointer has no click. Its guard must not swallow keyboard activation.
  const at = await undo.boundingBox()
  await page.mouse.move(at!.x + at!.width / 2, at!.y + at!.height / 2)
  await page.mouse.down()
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true })))
  await page.mouse.move(box.x + box.width - 20, box.y + box.height - 20)
  await page.mouse.up()
  expect(await store(page)).toEqual(restored)
  await undo.focus(); await page.keyboard.press('Enter')
  expect((await store(page)).profiles).toHaveLength(0)
})
