import { test, expect } from '@playwright/test'
import { openApp, tool, useDownloadFallback } from './helpers'

test('document commands and history remain usable with the panel collapsed', async ({ page }) => {
  await useDownloadFallback(page)
  await openApp(page)
  await page.getByTestId('template-bench').click()
  await page.getByTestId('template-place').click()
  await page.getByTestId('sidebar-collapse').click()
  const header = page.getByTestId('editor-header')
  const undo = header.getByRole('button', { name: '撤销', exact: true })
  const redo = header.getByRole('button', { name: '重做', exact: true })
  await undo.click()
  await expect(redo).toBeEnabled()
  await redo.click()
  await expect(redo).toBeDisabled()
  const menu = page.getByTestId('file-menu')
  await menu.focus()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByTestId('import-project')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(page.getByTestId('save-as')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toBeFocused()
  await expect(menu).toHaveAttribute('aria-expanded', 'false')
  await menu.click()
  await page.getByTestId('current-project-name').click()
  await expect(menu).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('Control+Shift+s')
  await expect(page.getByTestId('project-save-dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('project-save-dialog')).not.toBeVisible()
  await menu.click()
  await page.keyboard.press('Control+s')
  await expect(page.getByTestId('project-save-dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toBeFocused()
  await page.getByTestId('export-project').click()
  await page.getByTestId('save-filename').fill('cabinet-v2')
  await page.getByTestId('save-filename').dispatchEvent('keydown', { key: 'Enter', isComposing: true })
  await expect(page.getByTestId('project-save-dialog')).toBeVisible()
  const download = page.waitForEvent('download')
  await page.getByTestId('save-confirm').click()
  expect((await download).suggestedFilename()).toBe('cabinet-v2.json')
  await expect(page.getByTestId('export-project')).toBeFocused()
})

test('long project names fit on narrow screens without hiding file commands', async ({ page }) => {
  await useDownloadFallback(page)
  await openApp(page)
  await page.evaluate(() => (window as any).__aluframe.store.setState({ projectName: 'very-long-cabinet-file-name-for-layout-review.json' }))
  for (const width of [320, 768, 1400]) {
    await page.setViewportSize({ width, height: 800 })
    const header = page.getByTestId('editor-header')
    for (const id of ['file-menu', 'current-project-name', 'export-project']) {
      await expect(header.getByTestId(id)).toBeInViewport()
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
    const name = await page.getByTestId('current-project-name').boundingBox()
    const save = await page.getByTestId('export-project').boundingBox()
    expect(name!.x + name!.width).toBeLessThanOrEqual(save!.x)
  }
})


test('drawing controls follow the canvas and both history inputs cancel an unfinished draw', async ({ page }) => {
  await openApp(page)
  await page.getByTestId('template-bench').click()
  await page.getByTestId('template-place').click()
  const start = async () => page.evaluate(() => {
    const w = (window as any).__aluframe
    w.tool.getState().setActiveSpec('2020')
    w.tool.getState().beginDraw(new w.THREE.Vector3(0, 0, 0))
    w.tool.setState({ currentPoint: new w.THREE.Vector3(300, 0, 0) })
  })
  for (const collapsed of [false, true]) {
    if (collapsed) await page.getByTestId('sidebar-collapse').click()
    await start()
    await expect(page.getByTestId('draw-hud')).toBeVisible()
    await expect.poll(async () => {
      const hud = await page.getByTestId('draw-hud').boundingBox()
      const canvas = await page.getByTestId('viewport').boundingBox()
      return Math.round(hud!.x - canvas!.x)
    }).toBe(8)
    if (collapsed) {
      await page.getByTestId('viewport').focus()
      await page.keyboard.press('Control+z')
    } else {
      await page.getByTestId('editor-header').getByRole('button', { name: '撤销', exact: true }).click()
    }
    await expect.poll(async () => (await tool(page)).isDrawing).toBe(false)
    await expect(page.getByTestId('draw-hud')).toHaveCount(0)
    await page.keyboard.press('Control+Shift+z')
  }
})
