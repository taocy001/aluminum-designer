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

test('catalog runner uses standard travel and rejects oversized choices without changing history', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => {
    const api = (window as any).__aluframe
    api.tool.getState().putDown()
    api.store.getState().loadDocument({ profiles: [], connectors: [], panels: [], equipment: [], throughRule: 'rails', fittings: [{
      id: 'drawer', kind: 'drawer', width: 600, height: 240, depth: 500,
      position: [0, 200, 0], quaternion: [0, 0, 0, 1], material: 'ply', open: 0,
      drawer: { runnerLength: 430, runnerTravel: 300, sideClearance: 14 },
    }] })
    api.store.getState().selectItems(['drawer'])
  })
  await page.getByTestId('sidebar-tab-properties').click()
  const model = page.getByTestId('drawer-runner-model')
  await expect(model).toHaveValue('custom')
  const before = await store(page)
  await model.selectOption('accuride-3832e')
  await expect(page.getByTestId('drawer-runner-length')).toHaveValue('450')
  await expect(page.getByTestId('drawer-runner-travel')).toContainText('457 mm')
  const after = await store(page)
  expect(after.past).toBe(before.past + 1)
  expect(after.fittings[0].drawer).toMatchObject({ runnerModel: 'accuride-3832e', runnerLength: 450, sideClearance: 13 })
  await page.getByTestId('drawer-runner-length').selectOption('500')
  await expect(page.getByTestId('drawer-runner-editor').getByRole('alert')).toBeVisible()
  expect(await store(page)).toEqual(after)
  await page.getByTestId('drawer-runner-length').selectOption('400')
  await expect(page.getByTestId('drawer-runner-travel')).toContainText('406 mm')
  await expect(page.getByTestId('drawer-runner-editor').getByRole('alert')).toHaveCount(0)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(page.getByTestId('drawer-runner-length')).toHaveValue('450')
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(model).toHaveValue('custom')
  expect((await store(page)).fittings).toEqual(before.fittings)
})

test('batch catalog choice finds a common standard length and rejects a too-shallow member atomically', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => {
    const api = (window as any).__aluframe
    api.tool.getState().putDown()
    const base = { kind: 'drawer', width: 600, height: 240, position: [0, 200, 0], quaternion: [0, 0, 0, 1], material: 'ply', open: 0 }
    api.store.getState().loadDocument({ profiles: [], connectors: [], panels: [], equipment: [], throughRule: 'rails', fittings: [
      { ...base, id: 'deep', depth: 500 }, { ...base, id: 'shallow', depth: 420, position: [1000, 200, 0] },
      { ...base, id: 'tiny', depth: 280, position: [2000, 200, 0] },
    ] })
    api.store.getState().selectItems(['deep', 'shallow'])
  })
  await page.getByTestId('sidebar-tab-properties').click()
  await page.getByTestId('drawer-runner-model').selectOption('accuride-3832e')
  expect((await store(page)).fittings.slice(0, 2).map(f => f.drawer.runnerLength)).toEqual([400, 400])
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await page.evaluate(() => (window as any).__aluframe.store.getState().selectItems(['deep', 'tiny']))
  const before = await store(page)
  await page.getByTestId('drawer-runner-model').selectOption('accuride-3832e')
  await expect(page.getByTestId('drawer-runner-editor').getByRole('alert')).toBeVisible()
  expect(await store(page)).toEqual(before)
})
