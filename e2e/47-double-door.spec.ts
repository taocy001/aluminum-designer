import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { clickWorld, openApp, setView, settle, store, useDownloadFallback } from './helpers'

test('split a wide door, undo, reopen and export the two actual leaf sizes', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await useDownloadFallback(page)
  await openApp(page)
  const original = {
    id: 'wide-door', kind: 'door', position: [0, 440, 0], quaternion: [0, 0, 0, 1],
    width: 930, height: 840, depth: 560, frame: 20, material: 'mdf',
    open: 0, hinge: 'left', hingeType: 'cup', overlay: 'full', swing: 110,
  }
  await page.locator('input[type=file][accept="application/json,.json"]').setInputFiles({
    name: 'wide-door.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ version: 6, profiles: [], fittings: [original] })),
  })
  await expect.poll(async () => (await store(page)).fittings.length).toBe(1)
  await setView(page, [0, 440, 2200], [0, 440, 300])
  await clickWorld(page, [0, 440, 318])
  const split = page.getByTestId('split-double-door')
  await expect(split).toBeVisible()
  const before = await store(page)
  await split.click()
  await expect.poll(async () => (await store(page)).fittings.length).toBe(2)
  const after = await store(page)
  expect(after.past).toBe(before.past + 1)
  expect(after.fittings.map((f) => f.hinge)).toEqual(['left', 'right'])
  expect(after.fittings.map((f) => f.meeting)).toEqual(['right', 'left'])
  await expect(split).toBeDisabled()
  await settle(page)
  const extents = await page.evaluate(() => {
    const w = (window as any).__aluframe, T = w.THREE
    const boxes: number[][] = []
    w.sceneRoot.traverse((o: any) => {
      if (o.userData.fittingBoard !== 'panel') return
      o.updateWorldMatrix(true, false)
      o.geometry.computeBoundingBox()
      const box = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld)
      boxes.push([box.min.x, box.max.x, box.getSize(new T.Vector3()).x])
    })
    return boxes.sort((a, b) => a[0] - b[0])
  })
  expect(extents).toHaveLength(2)
  expect(extents[0][0]).toBeCloseTo(-480, 3)
  expect(extents[1][1]).toBeCloseTo(480, 3)
  expect(extents[1][0] - extents[0][1]).toBeCloseTo(3, 3)
  for (const bounds of extents) expect(bounds[2]).toBeCloseTo(478.5, 3)

  await page.getByTitle('撤销 (Ctrl+Z)', { exact: true }).click()
  await expect.poll(async () => (await store(page)).fittings).toEqual([original])
  await page.getByTitle('重做 (Ctrl+Y)', { exact: true }).click()
  await expect.poll(async () => (await store(page)).fittings).toEqual(after.fittings)
  const [bom] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-bom').click()])
  expect(readFileSync((await bom.path())!, 'utf8')).toContain('870 × 478.5 mm')
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-project').click().then(() => page.getByTestId('save-confirm').click())])
  const path = (await download.path())!
  expect(JSON.parse(readFileSync(path, 'utf8')).fittings).toEqual(after.fittings)
  await page.locator('input[type=file][accept="application/json,.json"]').setInputFiles(path)
  await expect.poll(async () => (await store(page)).fittings).toEqual(after.fittings)
  expect(errors).toEqual([])
  await page.screenshot({ path: test.info().outputPath('double-door.png') })
})
