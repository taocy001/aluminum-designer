import { expect, test } from '@playwright/test'
import { openApp, store } from './helpers'

test('a locked drawer opens with the properties slider without design history', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => {
    const s = (window as any).__aluframe.store
    s.getState().loadDocument({ version: 6, profiles: [], connectors: [], panels: [], fittings: [{
      id: 'drawer', kind: 'drawer', width: 500, height: 200, depth: 400,
      material: 'ply', open: 0, locked: true,
      position: [0, 150, 0], quaternion: [0, 0, 0, 1],
    }] })
    s.setState({ selectedIds: ['drawer'], past: [], future: [] })
  })
  const slider = page.getByTestId('fitting-open')
  await slider.fill('100')
  await expect(slider).toHaveValue('100')
  const opened = await store(page)
  expect(opened.fittings[0]).toMatchObject({ open: 1, locked: true, width: 500 })
  expect(opened.past).toBe(0)
  expect(opened.future).toBe(0)
  await slider.fill('0')
  expect((await store(page)).fittings[0].open).toBe(0)
})
