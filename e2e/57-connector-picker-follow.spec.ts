import { expect, test, type Page } from '@playwright/test'
import { openApp, setView, settle, store, w2c } from './helpers'

async function preview(page: Page) {
  return page.evaluate(() => {
    let result: { position: number[]; seated: boolean; allowed: boolean; pinned: boolean; reason?: string } | null = null
    ;(window as any).__aluframe.sceneRoot.traverse((object: any) => {
      if (!object.userData.connectorPreview) return
      const mesh = object.children.find((child: any) => Object.hasOwn(child.userData, 'connectorId'))
      if (mesh) result = { position: mesh.position.toArray(), seated: object.userData.seated,
        allowed: object.userData.allowed, pinned: object.userData.pinned, reason: object.userData.reason }
    })
    return result
  })
}

async function joint(page: Page) {
  await page.evaluate(() => {
    ;(window as any).__aluframe.store.getState().loadDocument({
      profiles: [
        { id: 'rail', spec: '2040', length: 300, position: [0, 100, 0], quaternion: [.5, .5, .5, .5], miterCuts: [], holes: [] },
        { id: 'post', spec: '2040', length: 300, position: [0, 100, 0], quaternion: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], miterCuts: [], holes: [] },
      ], connectors: [], panels: [], fittings: [], equipment: [], throughRule: 'rails',
    })
  })
  await setView(page, [230, 290, 310], [35, 135, 35])
  await page.getByTestId('connector-inside-corner').click()
  const point = await w2c(page, [0, 100, 0])
  await page.mouse.move(point.x, point.y)
  await expect(page.getByTestId('connector-seat-hud')).toHaveAttribute('data-seat-count', '4')
  return point
}

test.beforeEach(async ({ page }) => openApp(page))

test('the picker shows model silhouettes and explains each type on hover and keyboard focus', async ({ page }) => {
  const buttons = page.locator('button:has(img[data-connector-model])')
  const count = await buttons.count()
  expect(count).toBeGreaterThanOrEqual(10)
  const shapes = new Set<string>()
  for (const button of await buttons.all()) {
    const name = await button.getAttribute('aria-label')
    expect(name?.length).toBeGreaterThan(0)
    expect(await button.textContent()).toBe('')
    const model = button.locator('img')
    const source = (await model.getAttribute('src'))!
    expect(source).toMatch(/\/connector-thumbnails\/[\w-]+-20-[\da-f]{12}\.png$/)
    await expect.poll(() => model.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])).toEqual([168, 168])
    shapes.add(source)
  }
  expect(shapes.size).toBe(count)
  const inner = page.getByTestId('connector-inside-corner')
  const name = (await inner.getAttribute('aria-label'))!
  await inner.hover()
  await expect(page.getByTestId('tooltip')).toContainText(name)
  await expect(page.getByTestId('tooltip')).toContainText('接头')
  await page.mouse.move(900, 350)
  await inner.focus()
  await expect(page.getByTestId('tooltip')).toContainText(name)
  await expect(inner).toHaveAttribute('aria-describedby', 'control-tooltip')
  const tip = (await page.getByTestId('tooltip').boundingBox())!
  expect(tip.x).toBeGreaterThanOrEqual(0)
  expect(tip.y).toBeGreaterThanOrEqual(0)
  expect(tip.x + tip.width).toBeLessThanOrEqual(1400)
  expect(tip.y + tip.height).toBeLessThanOrEqual(900)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('tooltip')).toHaveCount(0)
  await expect(inner).not.toHaveAttribute('aria-describedby')
  await page.screenshot({ path: test.info().outputPath('connector-model-picker.png') })
})

test('a free ghost follows the cursor and can return to a retained joint through the HUD', async ({ page }) => {
  const point = await joint(page)
  const snapped = (await preview(page))!
  expect(snapped).toMatchObject({ seated: true, allowed: true, pinned: false })
  await page.mouse.move(1100, 250, { steps: 8 })
  await settle(page)
  const a = (await preview(page))!
  expect(a).toMatchObject({ seated: false, allowed: false, pinned: false })
  expect(a.position).not.toEqual(snapped.position)
  await page.mouse.move(1150, 300)
  await settle(page)
  const b = (await preview(page))!
  expect(b.position).not.toEqual(a.position)
  const projected = await w2c(page, b.position as [number, number, number])
  expect(Math.hypot(projected.x - 1150, projected.y - 300)).toBeLessThan(2)
  const before = await store(page)
  await page.mouse.click(1150, 300)
  await settle(page)
  expect((await store(page)).connectors).toEqual(before.connectors)
  expect((await store(page)).past).toEqual(before.past)
  await expect(page.getByTestId('connector-seat-hud')).toHaveAttribute('data-seat-count', '4')
  await page.getByTestId('connector-seat-option').first().click()
  expect(await preview(page)).toMatchObject({ seated: true, allowed: true, pinned: true })
  await page.getByTestId('connector-joint-lock').click()
  await page.mouse.move(point.x, point.y)
  await settle(page)
  expect(await preview(page)).toMatchObject({ seated: true, allowed: true, pinned: false })
})

test('magnet placement uses the visible vacant seat and continues following after a click', async ({ page }) => {
  const point = await joint(page)
  const first = (await preview(page))!
  await page.mouse.click(point.x, point.y)
  await settle(page)
  expect((await store(page)).connectors).toHaveLength(1)
  expect((await store(page)).connectors[0].position).toEqual(first.position)
  const second = (await preview(page))!
  expect(second).toMatchObject({ seated: true, allowed: true, pinned: false })
  expect(second.position).not.toEqual(first.position)
  await page.mouse.click(point.x, point.y)
  await settle(page)
  expect((await store(page)).connectors).toHaveLength(2)
  expect((await store(page)).connectors[1].position).toEqual(second.position)
  expect((await store(page)).connectors.map((part: any) => part.mountSeries)).toEqual([[20, 20], [20, 20]])
  const before = await store(page)
  await page.mouse.click(point.x, point.y)
  await settle(page)
  expect((await store(page)).connectors).toEqual(before.connectors)
  expect((await store(page)).past).toBe(before.past)
  await page.mouse.move(1100, 250)
  await settle(page)
  expect(await preview(page)).toMatchObject({ seated: false, allowed: false, pinned: false })
  await page.keyboard.press('Control+z')
  expect((await store(page)).connectors).toHaveLength(1)
  await page.keyboard.press('Control+z')
  expect((await store(page)).connectors).toHaveLength(0)
  await page.evaluate((connectors) => {
    const app = (window as any).__aluframe
    app.store.setState({ connectors })
  }, before.connectors)
  await page.keyboard.press('Escape')
  await setView(page, [85, 175, 100], [15, 120, 0])
  await settle(page)
  await page.screenshot({ path: test.info().outputPath('inside-corner-2040-closeup.png') })
})
