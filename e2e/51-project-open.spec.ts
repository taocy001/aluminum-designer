import { expect, test } from '@playwright/test'
import { openApp, store, useDownloadFallback } from './helpers'

const drawing = {
  version: 6,
  profiles: [{ id: 'opened-profile', spec: '2020', length: 500, position: [0, 0, 0],
    quaternion: [0, 0, 0, 1], miterCuts: [], holes: [] }],
  connectors: [], panels: [], fittings: [], throughRule: 'posts',
}

test('native cancellation and failures preserve the project and save target without a second picker', async ({ page }) => {
  await openApp(page)
  await page.getByTestId('template-bench').click()
  await page.getByTestId('template-place').click()
  await page.evaluate((document) => {
    const w = window as any
    w.__openMode = 'opened'
    w.__openCalls = 0
    w.__fallbackCalls = 0
    w.__savePickerCalls = 0
    w.__fileWrites = []
    w.showOpenFilePicker = async () => {
      w.__openCalls++
      if (w.__openMode === 'cancelled') throw new DOMException('Dismissed', 'AbortError')
      if (w.__openMode === 'picker-error') throw new DOMException('Denied', 'NotAllowedError')
      const name = w.__openMode === 'opened' ? 'original.json' : 'rejected.json'
      return [{
        name,
        getFile: async () => ({ text: async () => {
          if (w.__openMode === 'read-error') throw new DOMException('Read aborted', 'AbortError')
          return JSON.stringify(w.__openMode === 'bad-json' ? { unrelated: true } : document)
        } }),
        createWritable: async () => ({
          write: async (text: string) => { w.__fileWrites.push({ name, document: JSON.parse(text) }) },
          close: async () => {},
        }),
      }]
    }
    w.showSaveFilePicker = async () => { w.__savePickerCalls++; throw new Error('Unexpected save picker') }
    // Catch an unintended fallback without opening a second native dialog.
    const input = window.document.querySelector<HTMLInputElement>('input[type="file"]')!
    input.click = () => { w.__fallbackCalls++ }
  }, drawing)

  await page.getByTestId('import-project').click()
  await expect(page.getByTestId('current-project-name')).toContainText('original.json')
  await expect.poll(async () => (await store(page)).profiles).toEqual(drawing.profiles)
  const original = await store(page)
  let calls = 1
  for (const mode of ['cancelled', 'picker-error', 'read-error', 'bad-json']) {
    await page.evaluate((mode) => {
      ;(window as any).__openMode = mode
      ;(window as any).__aluframe.tool.setState({ toasts: [] })
    }, mode)
    await page.getByTestId('import-project').click()
    await expect.poll(() => page.evaluate(() => (window as any).__openCalls)).toBe(++calls)
    if (mode === 'cancelled') await expect(page.getByTestId('toasts')).toBeEmpty()
    else await expect(page.getByTestId('toasts')).toContainText('工程文件无法读取')
    expect(await page.evaluate(() => (window as any).__fallbackCalls)).toBe(0)
    expect(await store(page)).toEqual(original)
    await expect(page.getByTestId('current-project-name')).toContainText('original.json')
  }

  await page.getByTestId('export-project').click()
  await expect(page.getByTestId('project-save-dialog')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__fileWrites)).toHaveLength(0)
  await page.getByTestId('save-filename').fill('')
  await expect(page.getByTestId('save-confirm')).toBeDisabled()
  await page.getByTestId('save-overwrite').click()
  const writes = await page.evaluate(() => (window as any).__fileWrites)
  expect(writes).toHaveLength(1)
  expect(writes[0].name).toBe('original.json')
  expect(writes[0].document.profiles).toEqual(drawing.profiles)
  expect(await page.evaluate(() => (window as any).__savePickerCalls)).toBe(0)
  await page.keyboard.press('Control+s')
  await page.evaluate(() => {
    ;(window as any).showSaveFilePicker = async () => { throw new DOMException('Cancelled', 'AbortError') }
  })
  await page.getByTestId('save-confirm').click()
  await expect(page.getByTestId('project-save-dialog')).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.evaluate(() => {
    ;(window as any).showSaveFilePicker = async () => ({ name: 'failed.json', createWritable: async () => ({
      write: async () => {}, close: async () => { throw new DOMException('Write failed', 'AbortError') },
    }) })
  })
  await page.getByTestId('save-confirm').click()
  await expect(page.getByRole('alert')).toContainText('保存失败')
  await expect(page.getByTestId('current-project-name')).toContainText('original.json')
  await page.getByTestId('save-overwrite').click()
  await expect(page.getByTestId('project-save-dialog')).not.toBeVisible()
  expect((await page.evaluate(() => (window as any).__fileWrites)).map((w: any) => w.name))
    .toEqual(['original.json', 'original.json'])

})

test('a browser without the native open API imports through the ordinary file input', async ({ page }) => {
  await useDownloadFallback(page)
  await openApp(page)
  await page.getByTestId('template-bench').click()
  await page.getByTestId('template-place').click()
  const event = page.waitForEvent('filechooser')
  await page.getByTestId('import-project').click()
  const chooser = await event
  await chooser.setFiles({ name: 'fallback.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(drawing)) })
  await expect(page.getByTestId('toasts')).toContainText('工程已载入')
  await expect.poll(async () => (await store(page)).profiles).toEqual(drawing.profiles)
  await expect(page.getByTestId('through-posts')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('current-project-name')).toContainText('fallback.json')
  await page.keyboard.press('Control+s')
  await expect(page.getByTestId('project-save-dialog')).toBeVisible()
  await expect(page.getByTestId('save-overwrite')).toHaveCount(0)
  await expect(page.getByTestId('save-download-help')).toBeVisible()
  await page.getByTestId('save-filename').fill('my-cabinet.json')
  const downloaded = page.waitForEvent('download')
  await page.getByTestId('save-confirm').click()
  expect((await downloaded).suggestedFilename()).toBe('my-cabinet.json')
  await page.reload()
  await expect(page.getByTestId('current-project-name')).toContainText('fallback.json')
})
