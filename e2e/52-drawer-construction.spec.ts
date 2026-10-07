import { expect, test } from '@playwright/test'
import { openApp, store } from './helpers'

test('drawer construction edits persist and invalid travel leaves the design unchanged', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => {
    const s = (window as any).__aluframe.store
    s.getState().loadDocument({ version: 6, profiles: [], connectors: [], panels: [], fittings: [{
      id: 'drawer', kind: 'drawer', width: 600, height: 240, depth: 500,
      material: 'ply', open: 0, position: [0, 200, 0], quaternion: [0, 0, 0, 1],
    }] })
    s.setState({ selectedIds: ['drawer'], past: [], future: [] })
  })
  const field = (name: string) => page.getByTestId('drawer-config').getByRole('spinbutton', { name, exact: true })
  await field('单侧间隙 (mm)').fill('15')
  await field('单侧间隙 (mm)').press('Enter')
  await field('底板厚度 (mm)').fill('12')
  await field('底板厚度 (mm)').press('Enter')
  await field('滑轨长度 (mm)').fill('450')
  await field('滑轨长度 (mm)').press('Enter')
  await page.getByTestId('drawer-reinforcement').selectOption('2')
  await expect(page.getByTestId('drawer-box-size')).toContainText('570 × 214 × 480')
  const before = await store(page)
  expect(before.fittings[0].drawer).toMatchObject({ sideClearance: 15, bottomThickness: 12, runnerLength: 450, reinforcement: { count: 2 } })
  await field('滑轨行程 (mm)').fill('700')
  await field('滑轨行程 (mm)').press('Enter')
  const rejected = await store(page)
  expect(rejected.fittings).toEqual(before.fittings)
  expect(rejected.past).toBe(before.past)
  await expect(page.getByTestId('autosave-status')).toHaveAttribute('data-state', 'saved')
  await page.reload()
  await page.waitForFunction(() => (window as any).__aluframe?.store.getState().fittings.length === 1)
  expect((await store(page)).fittings).toEqual(before.fittings)
})

test('runner supports are added once and undo removes the rails and brackets together', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => {
    const s = (window as any).__aluframe.store
    s.getState().loadDocument({ version: 6,
      profiles: [-310, 310].flatMap((x) => [-260, 260].map((z) => ({
        id: `post-${x}-${z}`, spec: '2020', length: 600, position: [x, 0, z],
        quaternion: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], miterCuts: [], holes: [],
      }))), connectors: [], panels: [], fittings: [{
        id: 'drawer', kind: 'drawer', width: 600, height: 240, depth: 500,
        // The overlay front clears the 20 mm posts before adding runner supports.
        frame: 20, material: 'ply', open: 0, position: [0, 200, 0], quaternion: [0, 0, 0, 1],
      }] })
    s.setState({ selectedIds: ['drawer'], past: [], future: [] })
  })
  await page.getByTestId('add-drawer-supports').click()
  let s = await store(page)
  expect(s.profiles).toHaveLength(6)
  expect(s.connectors).toHaveLength(4)
  expect(s.past).toBe(1)
  await page.getByTestId('add-drawer-supports').click()
  expect((await store(page)).past).toBe(1)
  await page.keyboard.press('Control+z')
  s = await store(page)
  expect(s.profiles).toHaveLength(4)
  expect(s.connectors).toHaveLength(0)
})
