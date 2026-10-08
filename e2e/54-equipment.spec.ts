import { expect, test, type Page } from '@playwright/test'
import { openApp, setView, clickWorld, dragHold, settle, store, useDownloadFallback, w2c } from './helpers'

async function equipment(page: Page) {
  return page.evaluate(() => (window as any).__aluframe.store.getState().equipment)
}

async function addEquipment(page: Page) {
  await page.getByTestId('equipment-toggle').click()
  await page.getByTestId('equipment-new-name').fill('洗碗机')
  for (const [key, value] of Object.entries({ width: 600, height: 820, depth: 550, left: 5, right: 10, top: 20, front: 100 }))
    await page.getByTestId(`equipment-new-${key}`).fill(String(value))
  await page.getByTestId('equipment-add').click()
  await expect(page.getByTestId('equipment-properties')).toBeVisible()
}

test('equipment creation, editing, lock, rotation and persistence use the displayed dimensions', async ({ page }) => {
  await useDownloadFallback(page)
  await openApp(page)
  await addEquipment(page)
  expect(await equipment(page)).toHaveLength(1)
  const original = (await equipment(page))[0]
  expect(original).toMatchObject({ name: '洗碗机', width: 600, height: 820, depth: 550,
    position: [0, 410, 0], clearance: { left: 5, right: 10, top: 20, bottom: 0, back: 0, front: 100 } })
  await page.getByTestId('equipment-edit-width').fill('610')
  await page.getByTestId('equipment-edit-x').fill('120')
  await page.getByTestId('equipment-apply').click()
  expect((await equipment(page))[0]).toMatchObject({ width: 610, position: [120, 410, 0] })
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  expect((await equipment(page))[0]).toEqual(original)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await page.getByTestId('lock-toggle').click()
  await expect(page.getByTestId('equipment-edit-width')).toBeDisabled()
  await expect(page.getByTestId('rot-y-plus')).toBeDisabled()
  await page.getByTestId('lock-toggle').click()
  await page.getByTestId('rot-y-plus').click()
  const final = (await equipment(page))[0]
  expect(final.quaternion[1]).toBeCloseTo(Math.SQRT1_2)
  expect(final.quaternion[3]).toBeCloseTo(Math.SQRT1_2)

  const downloadEvent = page.waitForEvent('download')
  await page.getByTestId('export-project').click().then(() => page.getByTestId('save-confirm').click())
  const download = await downloadEvent
  const stream = await download.createReadStream(), chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(chunk)
  const saved = JSON.parse(Buffer.concat(chunks).toString())
  expect(saved.equipment).toEqual([final])
  await expect(page.getByTestId('autosave-status')).toHaveAttribute('data-state', 'saved')
  await page.reload()
  await page.waitForFunction(() => (window as any).__aluframe?.store.getState().equipment.length === 1)
  expect(await equipment(page)).toEqual([final])
})

test('equipment body is pickable while clearance alone does not cover other parts', async ({ page }) => {
  await openApp(page)
  await addEquipment(page)
  const id = (await equipment(page))[0].id
  await page.evaluate(() => {
    const app = (window as any).__aluframe
    app.store.getState().addPanels([{ id: 'front-panel', width: 150, height: 150, thickness: 18, material: 'ply',
      position: [0, 410, 340], quaternion: [0, 0, 0, 1] }])
    app.store.getState().selectItems([])
    app.tool.setState({ showGizmo: false })
  })
  await setView(page, [0, 410, 1500], [0, 410, 0])
  await clickWorld(page, [0, 410, 349])
  expect((await store(page)).selectedIds).toEqual(['front-panel'])
  await clickWorld(page, [220, 410, 275])
  expect((await store(page)).selectedIds).toEqual([id])
  await expect(page.getByTestId('equipment-clearance-warning')).toContainText('设备安装预留不足')
  await expect(page.getByTestId('equipment-body-warning')).toHaveCount(0)
  await page.evaluate(() => (window as any).__aluframe.store.getState().updatePanel('front-panel', { position: [0, 410, 200] }))
  await expect(page.getByTestId('equipment-body-warning')).toContainText('设备实体干涉')
  await expect(page.getByTestId('equipment-clearance-warning')).toHaveCount(0)
})

test('vertical gizmo dragging keeps rotated equipment above the floor', async ({ page }) => {
  await openApp(page)
  await addEquipment(page)
  await page.getByTestId('rot-x-plus').click()
  await setView(page, [900, 700, 1700], [0, 300, 0])
  const original = (await equipment(page))[0]
  const before = await store(page)
  const at: [number, number, number] = await page.evaluate(() =>
    (window as any).__aluframe.gizmoHandles().find((h: any) => h.kind === 'move' && h.axis === 'y').position)
  // The visible arrow overlaps the equipment body. A click still toggles that body;
  // crossing the drag threshold must preserve the arrow's vertical constraint.
  const from = await w2c(page, at), to = await w2c(page, [at[0], at[1] - 500, at[2]])
  await page.keyboard.down('Shift')
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  expect(await page.evaluate(() => (window as any).__aluframe.tool.getState().isDragging)).toBe(false)
  await page.mouse.up()
  await page.keyboard.up('Shift')
  await settle(page)
  expect((await store(page)).selectedIds).toEqual([])
  expect((await store(page)).past).toBe(before.past)
  expect(await equipment(page)).toEqual([original])
  await page.evaluate(id => (window as any).__aluframe.store.getState().selectItems([id]), original.id)
  await settle(page)
  await page.keyboard.down('Shift')
  await dragHold(page, from, to)
  expect(await page.evaluate(() => {
    const t = (window as any).__aluframe.tool.getState()
    return { dragging: t.isDragging, axis: t.dragAxis, vertical: t.dragVertical, free: t.dragFree }
  })).toEqual({ dragging: true, axis: 'y', vertical: true, free: true })
  await page.mouse.up()
  await page.keyboard.up('Shift')
  await settle(page)
  const moved = (await equipment(page))[0]
  expect(moved.position[1]).toBeCloseTo(275, 1)
  expect([moved.position[0], moved.position[2]]).toEqual([original.position[0], original.position[2]])
  expect(moved.quaternion).toEqual(original.quaternion)
  expect((await store(page)).past).toBe(before.past + 1)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  expect((await equipment(page))[0].position[1]).toBeCloseTo(410)
  expect(await equipment(page)).toEqual([original])
})
