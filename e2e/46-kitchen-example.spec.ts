import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { openApp, store, conflicts, settle, useDownloadFallback } from './helpers'

// Use the saved kitchen through the same file picker and controls as a person.
// Inspect moving meshes, so incorrect saved orientation or disconnected boards cannot
// be hidden by correct-looking fitting metadata.
async function renderedFront(page: Page, id: string) {
  return page.evaluate((id) => {
    const w = (window as any).__aluframe, T = w.THREE
    let root: any, front: any
    w.sceneRoot.traverse((o: any) => { if (o.userData.fittingId === id) root = o })
    root.updateWorldMatrix(true, true)
    const sides: any[] = []
    root.traverse((o: any) => {
      if (['front', 'panel'].includes(o.userData.fittingBoard)) front = o
      if (o.userData.fittingBoard === 'side') sides.push(o)
    })
    const center = front.getWorldPosition(new T.Vector3())
    const normal = new T.Vector3(0, 0, 1).transformDirection(front.matrixWorld)
    front.geometry.computeBoundingBox()
    const contactGaps = sides.map((side) => {
      side.geometry.computeBoundingBox()
      const b = side.geometry.boundingBox
      let tip = -Infinity
      for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
        const p = front.worldToLocal(side.localToWorld(new T.Vector3(x, y, z)))
        tip = Math.max(tip, p.z)
      }
      return front.geometry.boundingBox.min.z - tip
    })
    return { center: center.toArray(), normal: normal.toArray(), contactGaps,
      screen: w.worldToClient(center.x, center.y, center.z) }
  }, id)
}

test('kitchen file opens all fronts toward the user with attached drawer boxes', async ({ page }) => {
  test.setTimeout(240_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await useDownloadFallback(page)
  await openApp(page)
  await page.locator('input[type=file][accept="application/json,.json"]').setInputFiles(resolve('examples/flat/01-kitchen-base.json'))
  await expect.poll(async () => (await store(page)).fittings.length).toBe(7)
  await page.getByTestId('fit-view').click()
  await settle(page)
  const saved = await store(page)
  expect((await conflicts(page)).conflicts).toEqual([])
  await page.screenshot({ path: test.info().outputPath('kitchen-initial-closed.png') })
  // Keep images for each mechanism; mesh and interaction checks cover every front.
  const capturedKinds = new Set<string>()
  for (const f of saved.fittings) {
    const capture = !capturedKinds.has(f.kind)
    // Return from the range input to a real view control before Escape. An input owns
    // its keyboard events; otherwise the previous door stays selected and its move
    // handle can cover the neighbouring front. Face the closed fronts for each click.
    await page.getByTestId('view-front').click()
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await store(page)).selectedIds).toEqual([])
    await settle(page)
    const shut = await renderedFront(page, f.id)
    expect(shut.normal[2]).toBeGreaterThan(0.999)
    if (f.kind === 'drawer') {
      expect(shut.contactGaps).toHaveLength(2)
      for (const gap of shut.contactGaps) expect(Math.abs(gap)).toBeLessThan(0.001)
    }
    await page.mouse.move(shut.screen.x, shut.screen.y)
    await settle(page)
    await page.mouse.click(shut.screen.x, shut.screen.y)
    await settle(page)
    await expect(page.getByTestId('fitting-open')).toBeVisible()
    expect((await store(page)).selectedIds).toEqual([f.id])
    const slider = page.getByTestId('fitting-open')
    await slider.press('Home')
    for (let i = 0; i < 5; i++) await slider.press('PageUp')
    await expect(slider).toHaveValue('50')
    await expect.poll(async () => (await renderedFront(page, f.id)).center[2] - shut.center[2]).toBeGreaterThan(100)
    expect((await conflicts(page)).conflicts).toEqual([])
    await page.getByTestId('view-iso').click()
    await settle(page)
    if (capture) await page.screenshot({ path: test.info().outputPath(`${f.kind}-${f.id}-half-open.png`) })
    await slider.press('End')
    await expect(slider).toHaveValue('100')
    if (f.kind === 'drawer') {
      await expect.poll(async () => (await renderedFront(page, f.id)).center[2] - shut.center[2]).toBeGreaterThan(f.depth * 0.8)
      for (const gap of (await renderedFront(page, f.id)).contactGaps) expect(Math.abs(gap)).toBeLessThan(0.001)
    } else {
      await expect.poll(async () => {
        const normal = (await renderedFront(page, f.id)).normal
        const dot = normal.reduce((sum, value, axis) => sum + value * shut.normal[axis], 0)
        const angle = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI
        return Math.abs(angle - f.swing)
      }).toBeLessThan(0.1)
    }
    expect((await conflicts(page)).conflicts).toEqual([])
    if (capture) await page.screenshot({ path: test.info().outputPath(`${f.kind}-${f.id}-open.png`) })
    await slider.press('Home')
    await expect.poll(async () => Math.abs((await renderedFront(page, f.id)).center[2] - shut.center[2])).toBeLessThan(0.1)
    capturedKinds.add(f.kind)
  }
  expect((await store(page)).fittings).toEqual(saved.fittings)
  expect((await store(page)).profiles).toEqual(saved.profiles)
  expect((await store(page)).past).toBe(saved.past)
  await page.getByTestId('sidebar-tab-inspect').click()
  const [bom] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-bom').click()])
  await bom.saveAs(test.info().outputPath('kitchen-bom.csv'))
  const csv = readFileSync((await bom.path())!, 'utf8')
  // The exported cut list must include the attached box's full-length side boards.
  expect(csv).toContain('630 × 284 mm')
  expect(csv).toContain('630 × 304 mm')
  expect(csv).toContain('942 × 314.5 mm')
  expect(csv).toContain('942 × 334.5 mm')
  expect(csv).toContain('875 × 600 mm')
  const [project] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-project').click().then(() => page.getByTestId('save-confirm').click())])
  await project.saveAs(test.info().outputPath('kitchen-roundtrip.json'))
  const path = (await project.path())!
  await page.getByTestId('sidebar-tab-inspect').click()
  await page.getByTestId('clear-all').click()
  await page.getByTestId('clear-all').click()
  expect((await store(page)).fittings).toHaveLength(0)
  await page.locator('input[type=file][accept="application/json,.json"]').setInputFiles(path)
  await page.getByTestId('switch-keep-draft').click()
  await expect.poll(async () => (await store(page)).fittings).toEqual(saved.fittings)
  expect((await store(page)).connectors).toEqual(saved.connectors)
  expect((await conflicts(page)).conflicts).toEqual([])
  expect(errors).toEqual([])
  await page.screenshot({ path: test.info().outputPath('kitchen-closed.png') })
})
