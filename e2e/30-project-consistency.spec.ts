import { expect, test } from '@playwright/test'
import { openApp, useDownloadFallback } from './helpers'

test('坏操作日志缓存不会导致白屏或阻止后续设计', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('aluframe-oplog-v1', 'null'))
  await openApp(page)
  await page.getByTestId('template-bench').click()
  await page.getByTestId('template-place').click()
  await expect.poll(() => page.evaluate(() => (window as any).__aluframe.store.getState().profiles.length)).toBeGreaterThan(0)
  await page.getByTestId('section-log').click()
  await expect(page.getByTestId('op-log')).toContainText('member')
})

test('贯通规则、显示、导出、保存恢复与撤销使用同一个工程', async ({ page }) => {
  await useDownloadFallback(page)
  await openApp(page)
  const profiles = [
    { id: 'p0', spec: '2020', length: 800, position: [0, 0, 0], quaternion: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], miterCuts: [], holes: [] },
    { id: 'p1', spec: '2020', length: 800, position: [600, 0, 0], quaternion: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], miterCuts: [], holes: [] },
    { id: 'p2', spec: '2020', length: 600, position: [0, 800, 0], quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2], miterCuts: [], holes: [] },
  ]
  await page.evaluate((profiles) => (window as any).__aluframe.store.getState().loadDocument({ profiles, connectors: [] }), profiles)
  await page.getByTestId('through-posts').click()
  await expect(page.getByTestId('section-bom-body')).toContainText('580')
  const downloadEvent = page.waitForEvent('download')
  await page.getByTestId('export-project').click()
  const download = await downloadEvent
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(chunk)
  const saved = JSON.parse(Buffer.concat(chunks).toString())
  expect(saved.version).toBe(6)
  expect(saved.throughRule).toBe('posts')
  await page.reload()
  await page.waitForFunction(() => (window as any).__aluframe?.setView)
  await expect(page.getByTestId('through-posts')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('section-bom-body')).toContainText('580')
  await page.getByTestId('through-rails').click()
  await expect(page.getByTestId('section-bom-body')).toContainText('620')
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('through-posts')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('section-bom-body')).toContainText('580')
})

test('坏文件不会改变工程，坏自动保存可下载恢复且不白屏', async ({ page }) => {
  await useDownloadFallback(page)
  await openApp(page)
  await page.getByTestId('template-bench').click()
  await page.getByTestId('template-place').click()
  const count = await page.evaluate(() => (window as any).__aluframe.store.getState().profiles.length)
  const bad = JSON.stringify({ profiles: [], connectors: [{ id: 'c1', type: 'inside-corner', position: [0, 0, 0] }] })
  await page.locator('input[type=file]').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(bad) })
  await expect(page.getByTestId('toasts')).toContainText('工程文件无法读取')
  await expect.poll(() => page.evaluate(() => (window as any).__aluframe.store.getState().profiles.length)).toBe(count)
  await page.reload()
  await page.waitForFunction(() => (window as any).__aluframe?.setView)
  await expect.poll(() => page.evaluate(() => (window as any).__aluframe.store.getState().profiles.length)).toBe(count)
  await page.evaluate((bad) => localStorage.setItem('aluminum-designer-store', JSON.stringify({ state: JSON.parse(bad), version: 0 })), bad)
  await page.reload()
  await expect(page.getByTestId('recovery-notice')).toBeVisible()
  await expect(page.getByTestId('spec-2020')).toBeVisible()
  const event = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载原始数据' }).click()
  expect((await event).suggestedFilename()).toBe('aluframe-recovery.json')
  await page.getByTestId('template-bench').click()
  await page.getByTestId('template-place').click()
  await page.reload()
  await expect(page.getByTestId('recovery-notice')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).__aluframe.store.getState().profiles.length)).toBe(count)
  await page.getByRole('button', { name: '开始新工程' }).click()
  await expect(page.getByTestId('recovery-notice')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => (window as any).__aluframe.store.getState().profiles.length)).toBe(0)
  await page.reload()
  await expect(page.getByTestId('spec-2020')).toBeVisible()
  await expect(page.getByTestId('recovery-notice')).toHaveCount(0)
})
