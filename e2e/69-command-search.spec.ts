import { expect, test } from '@playwright/test'
import { openApp, store } from './helpers'

test.beforeEach(async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => {
    const { store, tool } = (window as any).__aluframe
    store.getState().loadDocument({ profiles: [{ id: 'beam', spec: '2020', length: 500,
      position: [0, 100, 0], quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2], holes: [], miterCuts: [] }],
      connectors: [], panels: [], fittings: [], equipment: [] })
    store.getState().selectItems(['beam']); tool.getState().putDown()
  })
})

test('search executes one edit, shares undo shortcuts and restores focus', async ({ page }) => {
  const button = page.getByTestId('command-search-toggle')
  await button.click()
  const input = page.getByRole('combobox', { name: '搜索命令' })
  await expect(input).toBeFocused()
  await input.fill('创建副本')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('command-search')).not.toBeVisible()
  await expect(button).toBeFocused()
  expect((await store(page)).profiles).toHaveLength(2)
  await page.keyboard.press('Control+z')
  expect((await store(page)).profiles).toHaveLength(1)
  await page.keyboard.press('Control+Shift+z')
  expect((await store(page)).profiles).toHaveLength(2)
})

test('disabled commands explain view and lock restrictions; typing never edits the canvas', async ({ page }) => {
  await page.keyboard.press('l')
  await page.keyboard.press('Control+k')
  const input = page.getByRole('combobox', { name: '搜索命令' })
  await input.fill('删除')
  await expect(page.getByTestId('command-delete')).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByTestId('command-delete')).toContainText('锁定')
  await page.keyboard.press('Enter')
  expect((await store(page)).profiles).toHaveLength(1)
  await input.fill('不匹配的词')
  await expect(page.getByTestId('command-search')).toContainText('没有匹配')
  await page.keyboard.press('Escape')
  await page.locator('main').focus()
  await page.keyboard.press('v')
  await page.keyboard.press('Control+k')
  await input.fill('删除')
  await expect(page.getByTestId('command-delete')).toContainText('查看模式')
  await input.fill('尺寸')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('command-search')).not.toBeVisible()
  expect((await store(page)).profiles).toHaveLength(1)
})

test('search opens the same save dialog and remains inside a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 })
  await page.getByTestId('command-search-toggle').click()
  await page.getByRole('combobox', { name: '搜索命令' }).fill('另存为')
  const bounds = await page.getByTestId('command-search').boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('project-save-dialog')).toBeVisible()
  const before = await store(page)
  await page.keyboard.press('Control+k')
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('command-search')).not.toBeVisible()
  expect(await store(page)).toEqual(before)
})
