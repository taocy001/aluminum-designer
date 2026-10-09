import { expect, test } from '@playwright/test'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { openApp, useDownloadFallback } from './helpers'

const files = ['examples', 'examples/flat'].flatMap(dir => readdirSync(dir)
  .filter(name => name.endsWith('.json')).map(name => ({ name, path: resolve(dir, name) })))

for (const file of files) test(`${file.name}: public file open, save and reopen preserves the project`, async ({ page }) => {
  test.setTimeout(120_000)
  await useDownloadFallback(page)
  await openApp(page)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const snapshot = () => page.evaluate(() => {
    const s = (window as any).__aluframe.store.getState()
    return Object.fromEntries(['profiles', 'connectors', 'panels', 'fittings', 'equipment', 'throughRule', 'groups', 'templateInstances']
      .map(key => [key, s[key]]))
  })
  await page.locator('input[type=file]').setInputFiles(file.path)
  await expect(page.getByTestId('current-project-name')).toContainText(file.name)
  const original = await snapshot()
  expect(original.profiles.length).toBe(JSON.parse(readFileSync(file.path, 'utf8')).profiles.length)
  await page.keyboard.press('Control+s')
  await expect(page.getByTestId('project-save-dialog')).toBeVisible()
  const event = page.waitForEvent('download')
  await page.getByTestId('save-confirm').click()
  const download = await event
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(chunk)
  const buffer = Buffer.concat(chunks)
  const saved = JSON.parse(buffer.toString())
  for (const [key, value] of Object.entries(original)) expect(saved[key], key).toEqual(value)
  await expect(page.getByTestId('project-save-dialog')).toBeHidden()
  await page.getByTestId('viewport').focus()
  // Change the document through the UI so reopening cannot pass by retaining the old state.
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
  expect((await snapshot()).profiles).toHaveLength(0)
  await page.locator('input[type=file]').setInputFiles({ name: `reopened-${file.name}`, mimeType: 'application/json', buffer })
  await page.getByTestId('switch-keep-draft').click()
  await expect(page.getByTestId('current-project-name')).toContainText(`reopened-${file.name}`)
  expect(await snapshot()).toEqual(original)
  expect(await page.evaluate(() => (window as any).__aluframe.store.getState().past)).toHaveLength(0)
  expect(errors).toEqual([])
})
