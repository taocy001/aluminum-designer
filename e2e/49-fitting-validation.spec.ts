import { expect, test } from '@playwright/test'
import { openApp, store } from './helpers'

test('drawer dimensions validate the rounded box before changing geometry or history', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => {
    const s = (window as any).__aluframe.store
    s.getState().loadDocument({ version: 6, profiles: [], connectors: [], panels: [], fittings: [{
      id: 'drawer', kind: 'drawer', width: 500, height: 200, depth: 400,
      frame: 20, overlay: 'full', material: 'ply', open: 0,
      position: [0, 150, 0], quaternion: [0, 0, 0, 1],
    }] })
    s.setState({ selectedIds: ['drawer'], past: [], future: [] })
  })
  const width = page.getByTestId('fitting-props').getByRole('spinbutton').first()
  await width.fill('65.04')
  await width.press('Enter')
  await expect(width).toHaveValue('500')
  expect((await store(page)).fittings[0].width).toBe(500)
  expect((await store(page)).past).toBe(0)

  await width.fill('65.1')
  await width.press('Enter')
  await expect(width).toHaveValue('65.1')
  expect((await store(page)).fittings[0].width).toBe(65.1)
  expect((await store(page)).past).toBe(1)
  await page.evaluate(() => (window as any).__aluframe.store.getState().undo())
  await expect(width).toHaveValue('500')

  const before = await store(page)
  await page.locator('input[type="file"]').setInputFiles({
    name: 'invalid-drawer.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ version: 6, profiles: [], connectors: [], panels: [],
      fittings: [{ ...before.fittings[0], width: 60 }] })),
  })
  await expect(page.getByText(/工程文件无法读取|Could not read project file/)).toBeVisible()
  expect(await store(page)).toEqual(before)
})
