import { expect, test } from '@playwright/test'
import { openApp, store } from './helpers'

test('measured pull dimensions create holes and participate in undo', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => {
    const { store, tool } = (window as any).__aluframe
    store.getState().loadDocument({ profiles: [], connectors: [], panels: [], equipment: [], fittings: [
      { id: 'door', kind: 'door', width: 600, height: 700, thickness: 18, depth: 400, material: 'ply',
        position: [0, 500, 0], quaternion: [0, 0, 0, 1], hinge: 'left', open: 0, overlay: 'inset' },
    ] })
    tool.getState().putDown()
    store.getState().selectItems(['door'])
  })
  await page.getByTestId('sidebar-tab-properties').click()
  const editor = page.getByTestId('handle-editor')
  await editor.locator('summary').click()
  await page.getByTestId('handle-pitch').fill('128')
  await page.getByTestId('handle-projection').fill('32')
  await page.getByTestId('handle-thickness').fill('12')
  await page.getByTestId('handle-holeDiameter').fill('4.5')
  await page.getByTestId('handle-x').fill('245')
  await page.getByTestId('handle-y').fill('0')
  await page.getByTestId('handle-apply').click()
  expect((await store(page)).fittings[0].handle).toEqual({ pitch: 128, projection: 32, thickness: 12, holeDiameter: 4.5, x: 245, y: 0 })
  await expect(editor).toContainText('已生成两个通孔')
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  expect((await store(page)).fittings[0].handle).toBeUndefined()
  await page.getByRole('button', { name: '重做', exact: true }).click()
  expect((await store(page)).fittings[0].handle.pitch).toBe(128)
  await page.getByTestId('handle-x').fill('400')
  await page.getByTestId('handle-apply').click()
  await expect(editor.getByRole('alert')).toBeVisible()
  expect((await store(page)).fittings[0].handle.x).toBe(245)
  await page.getByTestId('handle-clear').click()
  expect((await store(page)).fittings[0].handle).toBeUndefined()
})
