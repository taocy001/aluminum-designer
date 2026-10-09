import { expect, test } from '@playwright/test'
import { openApp, store } from './helpers'

test('fabrication settings survive undo, grain-aware cutting', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => {
    const { store, tool } = (window as any).__aluframe
    store.getState().loadDocument({ profiles: [], connectors: [], fittings: [], equipment: [], panels: [
      { id: 'shelf', width: 400, height: 200, thickness: 18, material: 'ply', position: [0, 300, 0], quaternion: [0, 0, 0, 1] },
    ] })
    tool.getState().putDown()
  })
  await page.getByTestId('sidebar-tab-inspect').click()
  const plan = page.getByTestId('panel-cut-plan')
  await plan.locator(':scope > summary').click()
  await page.getByTestId('board-fabrication').locator('summary').click()
  await page.getByLabel('板件纹理', { exact: true }).selectOption('y')
  await page.getByRole('spinbutton', { name: '左封边', exact: true }).fill('1')
  await page.getByRole('spinbutton', { name: '右封边', exact: true }).fill('2')
  await page.getByRole('spinbutton', { name: '下封边', exact: true }).fill('3')
  await page.getByRole('spinbutton', { name: '上封边', exact: true }).fill('4')
  await page.getByRole('button', { name: '应用到板件', exact: true }).click()
  expect((await store(page)).panels[0].fabrication).toEqual({ grain: 'y', bands: [1, 2, 3, 4] })
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  expect((await store(page)).panels[0].fabrication).toBeUndefined()
  await page.getByRole('button', { name: '重做', exact: true }).click()
  expect((await store(page)).panels[0].fabrication.bands).toEqual([1, 2, 3, 4])
  await page.getByRole('spinbutton', { name: '原板宽', exact: true }).fill('500')
  await page.getByRole('spinbutton', { name: '原板高', exact: true }).fill('300')
  await expect(plan).toContainText('尺寸或纹理方向不符合原板')
  await page.getByLabel('原板纹理', { exact: true }).selectOption('y')
  await expect(plan).toContainText('397 × 193')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出板材排版 CSV', exact: true }).click()
  const stream = await (await download).createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(chunk)
  expect(Buffer.concat(chunks).toString('utf8')).toContain('"400","200","y","1","2","3","4"')
  // Apply a bad band thickness through the actual input: it must leave the document untouched.
  await page.getByRole('spinbutton', { name: '左封边', exact: true }).fill('11')
  await page.getByRole('button', { name: '应用到板件', exact: true }).click()
  await expect(page.getByTestId('board-fabrication').getByRole('alert')).toBeVisible()
  expect((await store(page)).panels[0].fabrication.bands[0]).toBe(1)
})
