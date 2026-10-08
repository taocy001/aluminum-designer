import { test, expect, type Page } from '@playwright/test'
import { openApp, store, setView, w2c } from './helpers'

async function seedNut(page: Page) {
  await openApp(page)
  await page.evaluate(async () => {
    const api = (window as any).__aluframe
    const { resolveConnectorPlacement } = await import('/src/utils/connectorPlacement.ts' as string)
    const p = { id: 'host', position: [0, 100, 0], quaternion: [0, 0, 0, 1], length: 400, spec: '2020', miterCuts: [], holes: [] }
    const seat = resolveConnectorPlacement('t-nut', new api.THREE.Vector3(0, 110, 200), [p], [], new api.THREE.Vector3(0, 1, 0))
    if (!seat.allowed) throw Error('Invalid test fixture')
    api.tool.getState().putDown()
    api.store.getState().loadDocument({ profiles: [p], connectors: [{ id: 'nut', type: 't-nut', ...seat.seat }], panels: [], fittings: [], equipment: [], throughRule: 'rails' })
    api.store.getState().selectItems(['nut'])
  })
  await setView(page, [300, 400, 600], [0, 100, 200])
}

test('slot distance survives empty input, applies a fractional move, cancels and undoes', async ({ page }) => {
  await seedNut(page)
  const before = await store(page)
  const input = page.getByRole('spinbutton', { name: '沿槽距离', exact: true })
  await input.fill('')
  await expect(input).toBeVisible()
  await expect(page.getByTestId('connector-slide-apply')).toBeDisabled()
  await input.fill('0.1')
  await page.getByTestId('connector-slide-apply').click()
  await expect.poll(async () => (await store(page)).connectors[0].position[2]).toBeCloseTo(before.connectors[0].position[2] + .1)
  expect((await store(page)).past).toBe(before.past + 1)
  await input.fill('500')
  await expect(page.getByTestId('connector-slide-apply')).toBeDisabled()
  await input.press('Escape')
  await expect(input).toHaveValue('0')
  await input.blur()
  await page.keyboard.press('Control+z')
  expect((await store(page)).connectors[0].position).toEqual(before.connectors[0].position)
})

test('overlap menu lists shapes and hosts, filters by keyboard, selects and closes on visibility changes', async ({ page }) => {
  await seedNut(page)
  const at = await w2c(page, [0, 110, 200])
  const open = async () => {
    await page.mouse.move(at.x, at.y)
    await page.keyboard.press('Space')
    await page.getByTestId('quick-overlap').click()
    await expect(page.getByTestId('overlap-picker')).toBeVisible()
  }
  await open()
  const menu = page.getByTestId('overlap-picker')
  await expect(menu.locator('[data-overlap-id="nut"]')).toBeVisible()
  await expect(menu.locator('[data-overlap-id="host"]')).toBeVisible()
  const last = await menu.locator('[data-overlap-id]').last().getAttribute('data-overlap-id')
  await menu.press('ArrowUp')
  await expect(menu.locator(`[data-overlap-id="${last}"]`)).toBeFocused()
  const filter = menu.getByRole('combobox')
  await filter.focus()
  await filter.press('ArrowDown')
  await expect(filter).toBeFocused()
  await filter.selectOption('connector')
  await expect(menu.locator('[data-overlap-id]')).toHaveCount(1)
  await menu.locator('[data-overlap-id="nut"]').focus()
  await page.keyboard.press('Enter')
  await expect(menu).toBeHidden()
  expect((await store(page)).selectedIds).toEqual(['nut'])
  await open()
  await page.evaluate(() => (window as any).__aluframe.tool.getState().setBuildStep(0))
  await expect(menu).toBeHidden()
  await open()
  await expect(menu.locator('[data-overlap-id="nut"]')).toHaveCount(0)
})

test('auto-connect failure focuses the location and reseats an existing end cap in one undoable edit', async ({ page }) => {
  await openApp(page)
  await page.evaluate(async () => {
    const api = (window as any).__aluframe
    const { nearbyConnectorSeats } = await import('/src/utils/connectorRecovery.ts' as string)
    const { autoConnect } = await import('/src/utils/autoConnect.ts' as string)
    const host = { id: 'host', position: [0, 100, 0], quaternion: [0, 0, 0, 1], length: 400, spec: '2040', miterCuts: [], holes: [] }
    const seat = nearbyConnectorSeats('end-cap', new api.THREE.Vector3(), [host], [], {})[0].seat
    api.tool.getState().putDown()
    // Rotation prevents automatic recovery; the result lets the user choose explicitly.
    api.store.getState().loadDocument({ profiles: [host], connectors: [{ id: 'bad', type: 'end-cap', ...seat, quaternion: [0, 0, 0, 1], position: seat.position.map((n: number, i: number) => n + (i === 2 ? 5 : 0)) }], panels: [], fittings: [], equipment: [], throughRule: 'rails' })
    autoConnect('end-cap')
  })
  const report = page.getByTestId('auto-connect-report')
  await expect(report).toBeVisible()
  await report.getByTestId('connection-issue').last().click()
  expect((await store(page)).selectedIds).toContain('bad')
  const target = await page.evaluate(() => (window as any).__aluframe.controls.target.toArray())
  const before = await store(page)
  const bad = before.connectors.find(c => c.id === 'bad')
  expect(target).toEqual(bad.position)
  await report.getByTestId('report-seat').filter({ hasText: '可安装' }).first().click()
  await expect(report.getByTestId('report-seat-apply')).toBeEnabled()
  await report.getByTestId('report-seat-apply').click()
  expect((await store(page)).past).toBe(before.past + 1)
  expect((await store(page)).connectors.find(c => c.id === 'bad').position).not.toEqual(bad.position)
  await expect(report).toBeHidden()
  await page.keyboard.press('Control+z')
  expect((await store(page)).connectors.find(c => c.id === 'bad')).toEqual(bad)
})
