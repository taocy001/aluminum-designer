import { expect, test } from '@playwright/test'
import { openApp } from './helpers'

test('failed auto-save stays visible, downloads current edits, and retries before reload', async ({ page }) => {
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem
    ;(window as any).__blockAutoSave = true
    Storage.prototype.setItem = function (key, value) {
      if (key === 'aluminum-designer-store' && (window as any).__blockAutoSave) {
        throw new DOMException('Storage is full', 'QuotaExceededError')
      }
      return setItem.call(this, key, value)
    }
  })
  await openApp(page)
  await page.getByTestId('template-bench').click()
  await page.getByTestId('template-place').click()
  const status = page.getByTestId('autosave-status')
  await expect(status).toHaveAttribute('data-state', 'error')
  await expect(status).toContainText('最新更改尚未保存')
  await expect(page.getByTestId('recovery-notice')).toHaveCount(0)
  const latest = await page.evaluate(() => {
    const s = (window as any).__aluframe.store.getState()
    const p = s.profiles[0]
    s.commitProfileEdit(p.id, { length: p.length + 50 })
    return { id: p.id, length: p.length + 50 }
  })
  await expect(status).toHaveAttribute('data-state', 'error')
  const event = page.waitForEvent('download')
  await page.getByTestId('autosave-download').click()
  const download = await event
  expect(download.suggestedFilename()).toMatch(/^aluframe-current-.*\.json$/)
  const chunks: Buffer[] = []
  for await (const chunk of (await download.createReadStream())!) chunks.push(chunk)
  const doc = JSON.parse(Buffer.concat(chunks).toString())
  expect(doc.profiles.find((p: any) => p.id === latest.id).length).toBe(latest.length)
  await expect(status).toHaveAttribute('data-state', 'error')
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await expect(status).toContainText('Auto-save failed')
  await expect(page.getByTestId('autosave-download')).toHaveText('Download current project')
  await page.getByTestId('autosave-retry').click()
  await expect(status).toHaveAttribute('data-state', 'error')
  await page.evaluate(() => { (window as any).__blockAutoSave = false })
  await page.getByTestId('autosave-retry').click()
  await expect(status).toHaveAttribute('data-state', 'saved')
  await expect(status).toHaveAttribute('aria-label', 'The latest changes are saved in this browser.')
  await expect(page.getByTestId('autosave-retry')).toHaveCount(0)
  await page.reload()
  await page.waitForFunction(() => (window as any).__aluframe?.setView)
  await expect(status).toHaveAttribute('data-state', 'saved')
  expect(await page.evaluate((id) => (window as any).__aluframe.store.getState().profiles.find((p: any) => p.id === id).length, latest.id)).toBe(latest.length)
})

test('unavailable storage is reported on startup and retry can save before any edit', async ({ page }) => {
  await page.addInitScript(() => {
    const storage = window.localStorage
    let blocked = true
    ;(window as any).__restoreStorage = () => { blocked = false }
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => {
      if (blocked) throw new DOMException('Storage blocked', 'SecurityError')
      return storage
    } })
  })
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__aluframe?.setView)
  const status = page.getByTestId('autosave-status')
  await expect(status).toHaveAttribute('data-state', 'unavailable')
  await expect(status).toContainText('本地存储不可用')
  await expect(page.getByTestId('recovery-notice')).toHaveCount(0)
  await page.getByTestId('autosave-retry').click()
  await expect(status).toHaveAttribute('data-state', 'unavailable')
  await page.evaluate(() => (window as any).__restoreStorage())
  await page.getByTestId('autosave-retry').click()
  await expect(status).toHaveAttribute('data-state', 'saved')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('aluminum-designer-store')!).state)).toEqual({
    profiles: [], connectors: [], panels: [], fittings: [], throughRule: 'rails',
  })
})
