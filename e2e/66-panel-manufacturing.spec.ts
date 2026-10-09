import { test, expect } from '@playwright/test'
import { openApp } from './helpers'

test('panel cutting previews grain rotation, oversized stock and downloadable CSV', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => {
    const panel = (id: string, width: number, height: number) => ({ id, width, height, thickness: 18, material: 'ply', position: [0, 0, 0], quaternion: [0, 0, 0, 1] })
    ;(window as any).__aluframe.store.getState().loadDocument({profiles:[], connectors:[], fittings:[], equipment:[], panels:[panel('tall',1100,2000),panel('small',200,200)]})
  })
  await page.getByTestId('sidebar-tab-inspect').click()
  const cutting = page.getByTestId('panel-cut-plan')
  await cutting.locator('summary').click()
  await expect(cutting.getByRole('alert')).toContainText('B-tall')
  await cutting.getByRole('checkbox').check()
  await expect(cutting.getByRole('alert')).toHaveCount(0)
  await expect(cutting.getByRole('img')).toBeVisible()
  await expect(cutting).toContainText('↻90°')
  const download = page.waitForEvent('download')
  await cutting.getByRole('button', {name:'导出板材排版 CSV'}).click()
  const file = await download
  expect(file.suggestedFilename()).toBe('panel-layout.csv')
  const stream = await file.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(chunk)
  const csv = Buffer.concat(chunks).toString('utf8')
  expect(csv).toContain('"B-tall"')
  expect(csv).toContain('"2000","1100","1"')
  await cutting.getByRole('spinbutton', {name:'边距'}).fill('800')
  await expect(cutting.getByRole('alert')).toContainText('有效尺寸')
  await expect(cutting.getByRole('button', {name:'导出板材排版 CSV'})).toHaveCount(0)
  await expect(cutting.getByRole('button', {name:'导出已有板孔 CSV'})).toBeDisabled()
})
