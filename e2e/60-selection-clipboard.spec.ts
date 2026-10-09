import { expect, test, type Page } from '@playwright/test'
import { boundProject } from '../src/__tests__/fixtures/bindings'
import { clickWorld, dragHold, openApp, setView, settle, store, w2c } from './helpers'

async function selectionFixture(page: Page) {
  const lockResult = await page.evaluate(() => {
    const s = (window as any).__aluframe.store
    s.getState().loadDocument({ profiles: [0, 200, 400].map((x, i) => ({
      id: `post-${i}`, spec: '2020', position: [x, 0, 0], length: 400,
      quaternion: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], holes: [], miterCuts: [],
    })), connectors: [], fittings: [], equipment: [], panels: [{ id: 'panel', width: 160, height: 220,
      thickness: 18, material: 'ply', position: [650, 200, 0], quaternion: [0, 0, 0, 1] }], throughRule: 'rails' })
    // Lock through the editor contract, which preserves the finished cut faces.
    s.getState().selectItems(['post-2'])
    const result = s.getState().toggleLockSelected()
    s.setState({ selectedIds: [], past: [], future: [] })
    return { status: result.status, reference: s.getState().profiles[2] }
  })
  expect(lockResult.status).toBe('applied')
  expect(lockResult.reference).toMatchObject({ locked: true, fixedTrims: { start: 0, end: 0 } })
  await setView(page, [450, 650, 1500], [300, 180, 0])
}

test.beforeEach(async ({ page }) => openApp(page))

test('Shift click toggles members, boards and locked references without dragging or changing history', async ({ page }) => {
  await selectionFixture(page)
  await clickWorld(page, [0, 170, 10])
  expect((await store(page)).selectedIds).toEqual(['post-0'])
  await clickWorld(page, [200, 170, 10], { modifiers: ['Shift'] })
  expect((await store(page)).selectedIds.sort()).toEqual(['post-0', 'post-1'])
  await clickWorld(page, [650, 200, 9], { modifiers: ['Shift'] })
  await clickWorld(page, [400, 170, 10], { modifiers: ['Shift'] })
  expect((await store(page)).selectedIds.sort()).toEqual(['panel', 'post-0', 'post-1', 'post-2'])
  await clickWorld(page, [200, 170, 10], { modifiers: ['Shift'] })
  expect((await store(page)).selectedIds.sort()).toEqual(['panel', 'post-0', 'post-2'])
  await clickWorld(page, [650, 200, 9], { modifiers: ['Shift'] })
  await clickWorld(page, [400, 170, 10], { modifiers: ['Shift'] })
  expect((await store(page)).selectedIds).toEqual(['post-0'])
  // A Shift click on the selected endpoint toggles instead of starting a resize.
  await clickWorld(page, [0, 397, 10], { modifiers: ['Shift'] })
  const result = await store(page)
  expect(result.selectedIds).toEqual([])
  expect(result.profiles.map(p => p.length)).toEqual([400, 400, 400])
  expect(result.past).toBe(0)
  expect(await page.evaluate(() => (window as any).__aluframe.tool.getState().isDragging)).toBe(false)
})

test('Ctrl and Cmd clicks replace selection and empty clicks clear it', async ({ page }) => {
  await selectionFixture(page)
  for (const modifier of ['Control', 'Meta'] as const) {
    await clickWorld(page, [0, 170, 10])
    await clickWorld(page, [200, 170, 10], { modifiers: [modifier] })
    expect((await store(page)).selectedIds).toEqual(['post-1'])
    await clickWorld(page, [650, 200, 9], { modifiers: [modifier] })
    expect((await store(page)).selectedIds).toEqual(['panel'])
    await clickWorld(page, [850, 200, 9], { modifiers: [modifier] })
    expect((await store(page)).selectedIds).toEqual([])
  }
  expect((await store(page)).past).toBe(0)
})

test('Shift dragging a selected group preserves free placement and commits a single undo step', async ({ page }) => {
  await selectionFixture(page)
  await clickWorld(page, [0, 150, 10])
  await clickWorld(page, [200, 150, 10], { modifiers: ['Shift'] })
  const before = await store(page)
  const from = await w2c(page, [0, 150, 10]), to = await w2c(page, [37, 150, 57])
  await page.keyboard.down('Shift')
  await dragHold(page, from, to)
  expect(await page.evaluate(() => {
    const t = (window as any).__aluframe.tool.getState()
    return { dragging: t.isDragging, free: t.dragFree, resize: !!t.resize }
  })).toEqual({ dragging: true, free: true, resize: false })
  await page.mouse.up()
  await page.keyboard.up('Shift')
  await settle(page)
  const after = await store(page)
  expect(after.past).toBe(before.past + 1)
  expect(after.selectedIds.sort()).toEqual(['post-0', 'post-1'])
  const delta = after.profiles[0].position.map((n: number, i: number) => n - before.profiles[0].position[i])
  expect(Math.hypot(...delta)).toBeGreaterThan(20)
  expect(Math.abs(delta[0] / 10 - Math.round(delta[0] / 10))).toBeGreaterThan(.05)
  for (const index of [0, 1]) {
    after.profiles[index].position.forEach((n: number, i: number) => expect(n - before.profiles[index].position[i]).toBeCloseTo(delta[i], 3))
    expect(after.profiles[index].length).toBe(400)
  }
  expect(after.profiles[2]).toEqual(before.profiles[2])
  expect(after.panels).toEqual(before.panels)
  await page.keyboard.press('Control+z')
  expect((await store(page)).profiles).toEqual(before.profiles)
})

test('Ctrl and Cmd copy/paste retain assembly relationships, use one undo per paste and respect input/view modes', async ({ page }) => {
  const setup = await page.evaluate(doc => {
    const s = (window as any).__aluframe.store
    const result = s.getState().commitDocument({ ...doc, equipment: [] })
    s.setState({ selectedIds: [], past: [], future: [] })
    return result.status
  }, boundProject())
  expect(setup).toBe('applied')
  await page.getByTestId('viewport').focus()
  await page.keyboard.press('Control+a')
  const original = await store(page)
  await page.keyboard.press('Control+c')
  expect((await store(page)).past).toBe(0)
  await page.keyboard.press('Control+Shift+a')
  expect((await store(page)).selectedIds).toEqual([])
  await page.keyboard.press('Control+v')
  const first = await store(page)
  expect(first.past).toBe(1)
  for (const kind of ['profiles', 'connectors', 'panels', 'fittings'] as const) {
    expect(first[kind]).toHaveLength(original[kind].length * 2)
    expect(first[kind].slice(original[kind].length).every(p => first.selectedIds.includes(p.id))).toBe(true)
  }
  const profileCopies = first.profiles.slice(original.profiles.length)
  const fittingCopies = first.fittings.slice(original.fittings.length)
  expect(profileCopies.at(-1).runnerBinding.fittingId).toBe(fittingCopies[0].id)
  expect(first.connectors.at(-1).supportBinding.profileId).toBe(profileCopies.at(-1).id)
  expect(fittingCopies[0].openingBinding.opening.left.profileId).toBe(profileCopies[0].id)
  expect(first.panels.at(-1).openingBinding.opening.right.profileId).toBe(profileCopies[1].id)
  await page.keyboard.press('Meta+v')
  const second = await store(page)
  expect(second.past).toBe(2)
  expect(second.selectedIds.every(id => !first.selectedIds.includes(id))).toBe(true)
  await page.keyboard.press('Control+z')
  for (const kind of ['profiles', 'connectors', 'panels', 'fittings'] as const) expect((await store(page))[kind]).toEqual(first[kind])
  await page.keyboard.press('Control+z')
  for (const kind of ['profiles', 'connectors', 'panels', 'fittings'] as const) expect((await store(page))[kind]).toEqual(original[kind])

  await page.getByTestId('sidebar-tab-add').click()
  const input = page.getByTestId('work-plane')
  await input.fill('735')
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+v')
  expect((await store(page)).profiles).toEqual(original.profiles)
  expect((await store(page)).past).toBe(0)
  await page.getByTestId('viewport').focus()
  await page.getByTestId('mode-toggle').click()
  await page.getByTestId('viewport').focus()
  await page.keyboard.press('Control+v')
  await expect(page.getByTestId('mode-toggle')).toHaveAttribute('aria-pressed', 'true')
  expect((await store(page)).profiles).toEqual(original.profiles)
  expect((await store(page)).past).toBe(0)
})
