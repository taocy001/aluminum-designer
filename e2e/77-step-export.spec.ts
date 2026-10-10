import { expect, test } from '@playwright/test'
import { readFile, stat } from 'node:fs/promises'
import { openApp } from './helpers'

async function load(page: import('@playwright/test').Page, caster = false) {
  await page.evaluate(caster => {
    const api = (window as any).__aluframe
    api.tool.getState().putDown()
    api.store.getState().loadDocument({ profiles: [], fittings: [], equipment: [], throughRule: 'rails',
      panels: [{ id: 'board', width: 400, height: 300, thickness: 18, material: 'ply', position: [0, 300, 0], quaternion: [0, 0, 0, 1] }],
      connectors: caster ? [{ id: 'wheel', type: 'caster-mount', position: [0, 0, 0], quaternion: [0, 0, 0, 1], series: 40 }] : [],
    })
  }, caster)
}
async function exportStep(page: import('@playwright/test').Page) {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('aluframe:export', { detail: 'step' })))
}

test('worker exports the starting document while editing continues', async ({ page }) => {
  await openApp(page)
  await load(page)
  const downloaded = page.waitForEvent('download')
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('aluframe:export', { detail: 'step' }))
    // This runs before the worker can finish. The file must still contain the original board.
    ;(window as any).__aluframe.store.getState().loadDocument({ profiles: [], panels: [], fittings: [], connectors: [], equipment: [], throughRule: 'rails' })
  })
  const download = await downloaded
  expect(download.suggestedFilename()).toMatch(/\.step$/)
  const content = await readFile((await download.path())!, 'utf8')
  expect(content).toContain('ISO-10303-21;')
  expect(content).toContain('MANIFOLD_SOLID_BREP')
  expect(content).toContain('END-ISO-10303-21;')
  await expect(page.getByTestId('step-export-status')).toHaveCount(0)
})

test('dense export stays responsive, rejects duplicate requests and can be cancelled then retried', async ({ page }) => {
  await openApp(page)
  await load(page, true)
  let workers = 0
  let downloads = 0
  page.on('worker', () => workers++)
  page.on('download', () => downloads++)
  await exportStep(page)
  await expect(page.getByTestId('step-export-status')).toBeVisible()
  await exportStep(page)
  await expect.poll(() => workers).toBe(1)
  await page.getByTestId('file-menu').click()
  await expect(page.getByRole('menuitem', { name: '导出 STEP…', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  // UI actions must complete while the dense mesh is still being exported.
  await page.getByTestId('sidebar-collapse').click({ timeout: 2000 })
  await expect(page.getByTestId('sidebar-rail')).toBeVisible()
  await expect(page.getByTestId('step-export-status')).toBeVisible()
  await page.getByTestId('step-export-cancel').click({ timeout: 2000 })
  await expect(page.getByTestId('step-export-status')).toHaveCount(0)
  expect(downloads).toBe(0)
  await page.getByTestId('file-menu').click()
  await expect(page.getByRole('menuitem', { name: '导出 STEP…', exact: true })).toBeEnabled()
  await page.keyboard.press('Escape')
  await load(page)
  const downloaded = page.waitForEvent('download')
  await exportStep(page)
  await downloaded
  expect(workers).toBe(2)
  expect(downloads).toBe(1)
})

test('worker loading failure is reported and export can be retried', async ({ page }) => {
  await openApp(page)
  await load(page)
  await page.route('**/*step.worker*', route => route.abort())
  await exportStep(page)
  await expect(page.getByText('STEP 导出失败，请重试或减少零件数量。', { exact: true })).toBeVisible()
  await expect(page.getByTestId('step-export-status')).toHaveCount(0)
  await page.unroute('**/*step.worker*')
  const downloaded = page.waitForEvent('download')
  await exportStep(page)
  await downloaded
})

test('a complete manufacturer caster exports while the canvas can zoom', async ({ page }) => {
  await openApp(page)
  await load(page, true)
  const downloaded = page.waitForEvent('download')
  await exportStep(page)
  await expect(page.getByTestId('step-export-status')).toBeVisible()
  const distance = () => page.evaluate(() => {
    const api = (window as any).__aluframe
    return api.camera.position.distanceTo(api.controls.target)
  })
  const before = await distance()
  const canvas = page.locator('canvas').first()
  await canvas.hover()
  await page.mouse.wheel(0, -200)
  await expect.poll(distance, { timeout: 2000 }).not.toBe(before)
  const download = await downloaded
  expect((await stat((await download.path())!)).size).toBeGreaterThan(50_000_000)
  await expect(page.getByTestId('step-export-status')).toHaveCount(0)
})
