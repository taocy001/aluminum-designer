import { test, expect, type Page } from '@playwright/test'
import { openApp, setView, enterDraw, clickWorld, hoverWorld, store, settle } from './helpers'

async function selectedRail(page: Page) {
  await openApp(page)
  await setView(page, [1400, 1050, 1700], [350, 200, 100])
  await enterDraw(page, '4040')
  await clickWorld(page, [0, 0, 0])
  await hoverWorld(page, [600, 20, 0])
  await page.getByTestId('precise-input').fill('600')
  await page.getByTestId('precise-input').press('Enter')
  await page.keyboard.press('Escape')
  await clickWorld(page, [300, 20, 0])
  await expect(page.getByTestId('properties')).toBeVisible()
}

test.describe('Editing preserves context and makes field behavior predictable', () => {
  test.beforeEach(async ({ page }) => selectedRail(page))

  test('selecting a member brings its actual editable fields into the sidebar viewport', async ({ page }) => {
    await expect.poll(() => page.evaluate(() => {
      const scroll = document.querySelector('[data-testid="sidebar-scroll"]')!.getBoundingClientRect()
      const input = document.querySelector('[data-testid="properties"] input[type="number"]')!.getBoundingClientRect()
      return input.top >= scroll.top && input.bottom <= scroll.bottom
    })).toBe(true)
    await page.screenshot({ path: test.info().outputPath('selected-properties-visible.png') })
  })

  test('Escape discards a length draft before a later click can commit it', async ({ page }) => {
    const before = await store(page)
    const field = page.getByTestId('properties').getByRole('spinbutton', { name: '中心线长度 (mm)', exact: true })
    await field.fill('725')
    await field.press('Escape')
    await expect(field).toHaveValue('600')
    await expect(field).not.toBeFocused()
    await page.getByTestId('fit-view').click()
    expect((await store(page)).profiles).toEqual(before.profiles)
    expect((await store(page)).past).toBe(before.past)
    expect((await store(page)).selectedIds).toEqual(before.selectedIds)
  })

  test('Escape also discards a pending end-coordinate edit', async ({ page }) => {
    const before = await store(page)
    const field = page.getByTestId('end-position').getByRole('spinbutton').first()
    await field.fill('725')
    await field.press('Escape')
    await page.getByTestId('fit-view').click()
    expect((await store(page)).profiles).toEqual(before.profiles)
    expect((await store(page)).past).toBe(before.past)
  })

  test('undo and redo keep the existing member selected so its properties stay available', async ({ page }) => {
    const before = await store(page)
    const field = page.getByTestId('properties').getByRole('spinbutton', { name: '中心线长度 (mm)', exact: true })
    await field.fill('725'); await field.press('Enter')
    await page.keyboard.press('Control+z')
    await expect(field).toHaveValue('600')
    expect((await store(page)).selectedIds).toEqual(before.selectedIds)
    await page.keyboard.press('Control+y')
    await expect(field).toHaveValue('725')
    expect((await store(page)).selectedIds).toEqual(before.selectedIds)
    await page.getByTestId('end-position').getByRole('spinbutton').first().fill('800')
    await page.getByTestId('end-position').getByRole('spinbutton').first().press('Enter')
    expect((await store(page)).profiles[0].length).toBe(800)
  })

  test('locking disables geometry fields while unlocking and copying remain available', async ({ page }) => {
    await page.getByTestId('lock-toggle').click()
    const properties = page.getByTestId('properties')
    await expect(properties.getByRole('combobox').first()).toBeDisabled()
    await expect(properties.getByRole('spinbutton', { name: '中心线长度 (mm)', exact: true })).toBeDisabled()
    for (const field of await page.getByTestId('end-position').getByRole('spinbutton').all()) await expect(field).toBeDisabled()
    await expect(properties.getByRole('button', { name: '反向', exact: true })).toBeDisabled()
    await expect(properties.getByRole('button', { name: /复制/ })).toBeEnabled()
    await page.screenshot({ path: test.info().outputPath('locked-geometry-fields.png') })
    await page.getByTestId('lock-toggle').click()
    await expect(properties.getByRole('spinbutton', { name: '中心线长度 (mm)', exact: true })).toBeEnabled()
  })

  test('the selection work plane uses the real upper surface before and after section rotation', async ({ page }) => {
    await page.getByTestId('work-plane-from-selection').click()
    await expect(page.getByTestId('work-plane')).toHaveValue('40')
    await page.getByTestId('rotate-angle').fill('45')
    await page.getByTestId('rot-x-plus').click()
    await settle(page)
    const part = (await store(page)).profiles[0]
    const expected = Math.round((part.position[1] + 20 * Math.sqrt(2)) * 1000) / 1000
    await page.getByTestId('work-plane-from-selection').click()
    await expect(page.getByTestId('work-plane')).toHaveValue(String(expected))
    expect(await page.evaluate(() => (window as any).__aluframe.tool.getState().workPlaneY)).toBe(expected)
  })
})

test('Escape exits a live board-size field without adding history, and Undo reverts its accepted live edit', async ({ page }) => {
  await openApp(page)
  // A board fixture isolates the live multi-part field semantics; all edits below use UI.
  await page.evaluate(() => {
    const w = (window as any).__aluframe
    w.store.getState().loadDocument({ profiles: [], connectors: [], fittings: [], panels: [{ id: 'board', width: 400,
      height: 300, thickness: 18, material: 'mdf', position: [300, 300, 0], quaternion: [0, 0, 0, 1] }], throughRule: 'rails' })
  })
  await setView(page, [1300, 1000, 1600], [300, 300, 0])
  await clickWorld(page, [300, 300, 9])
  const before = await store(page)
  const width = page.getByTestId('panel-props').getByRole('spinbutton').first()
  await width.fill('725')
  await expect.poll(async () => (await store(page)).panels[0].width).toBe(725)
  await width.press('Escape')
  await expect(width).not.toBeFocused()
  expect((await store(page)).past).toBe(before.past + 1)
  await page.keyboard.press('Control+z')
  await expect(width).toHaveValue('400')
  expect((await store(page)).selectedIds).toEqual(before.selectedIds)
})
