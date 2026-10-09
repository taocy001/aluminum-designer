import { expect, test } from '@playwright/test'
import { openApp } from './helpers'
import { openingFaceOptions, resolveOpening, deriveOpeningPanel, type OpeningRef } from '../src/utils/openingBindings'
import { attachPanels } from '../src/utils/attachPanels'
import { panelMountSupports } from '../src/utils/panelMounts'
import type { ProjectDocument } from '../src/utils/document'

for (const mode of ['top', 'front'] as const) test(`template dimensions update a fastened ${mode} board and undo together`, async ({ page }) => {
  await openApp(page)
  await page.getByTestId('template-cabinet').click()
  await page.getByTestId('template-place').click()
  const doc: ProjectDocument = await page.evaluate(() => {
    const s = (window as any).__aluframe.store.getState()
    return { profiles: s.profiles, panels: s.panels, connectors: s.connectors, fittings: s.fittings, equipment: s.equipment,
      throughRule: s.throughRule, templateInstances: s.templateInstances }
  })
  const options = openingFaceOptions(doc.profiles, doc.profiles.map(p => p.id), [0, 0, 0, 1], doc.throughRule)
  const ref = Object.fromEntries(Object.entries({ left: 10, right: 590, bottom: 10, top: 790, front: 590, back: 10 })
    .map(([role, coordinate]) => [role, options[role as keyof typeof options].find(o => Math.abs(o.coordinate - coordinate) < .001)!.ref])) as unknown as OpeningRef
  const opening = resolveOpening(ref, doc.profiles, doc.throughRule)
  if (opening.status !== 'resolved') throw new Error('fixture opening')
  const margin = mode === 'top' ? 0 : -20
  doc.panels = [deriveOpeningPanel({ id: 'board', width: 1, height: 1, thickness: 18, material: 'ply', position: [0, 0, 0], quaternion: [0, 0, 0, 1],
    openingBinding: { opening: ref, mode, normalOffset: mode === 'top' ? 11 : 29, margins: { left: margin, right: margin, top: margin, bottom: margin } } }, opening.opening)!]
  let sequence = 0
  doc.connectors = attachPanels(doc, ['board'], () => `mount-${sequence++}`).made
  expect(doc.connectors.length).toBeGreaterThanOrEqual(4)
  await page.evaluate(doc => {
    const s = (window as any).__aluframe.store.getState()
    s.loadDocument(doc); s.selectItems([doc.profiles[0].id])
  }, doc)
  await page.getByTestId('sidebar-tab-properties').click()
  await page.getByTestId('instance-param-w').fill('850')
  await page.getByTestId('instance-param-d').fill('750')
  await page.getByTestId('instance-param-h').fill('1100')
  await page.getByTestId('template-instance-apply').click()
  const read = () => page.evaluate(() => {
    const s = (window as any).__aluframe.store.getState()
    return { profiles: s.profiles, panels: s.panels, connectors: s.connectors, past: s.past.length }
  })
  await expect.poll(async () => (await read()).panels[0].width).toBe(doc.panels[0].width + 250)
  const updated = await read()
  expect(updated.past).toBe(1)
  expect(updated.connectors.map((c: { id: string }) => c.id)).toEqual(doc.connectors.map(c => c.id))
  for (const c of updated.connectors) expect(panelMountSupports(c, updated.profiles, updated.panels)).toEqual([c.panelMount.profileId])
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  expect((await read()).connectors).toEqual(doc.connectors)
  expect((await read()).panels).toEqual(doc.panels)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  expect((await read()).connectors).toEqual(updated.connectors)
})

test('template parameters remain editable with one undo and explain unsafe regeneration', async ({ page }) => {
  await openApp(page)
  await page.getByTestId('template-cabinet').click()
  await page.getByTestId('template-place').click()
  await page.getByTestId('sidebar-tab-properties').click()
  await expect(page.getByTestId('template-instance-editor')).toBeVisible()
  const snapshot = () => page.evaluate(() => {
    const s = (window as any).__aluframe.store.getState()
    return { profiles: s.profiles, instances: s.templateInstances, past: s.past.length }
  })
  const before = await snapshot()
  await page.getByTestId('instance-param-w').fill('700')
  await page.getByTestId('template-instance-apply').click()
  await expect.poll(async () => (await snapshot()).instances[0].parameters.w).toBe(700)
  const after = await snapshot()
  expect(after.profiles.map((p: any) => p.id)).toEqual(before.profiles.map((p: any) => p.id))
  expect(after.past).toBe(before.past + 1)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  expect((await snapshot()).profiles).toEqual(before.profiles)
  await expect(page.getByTestId('instance-param-w')).toHaveValue(String(before.instances[0].parameters.w))
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect(page.getByTestId('instance-param-w')).toHaveValue('700')
  await page.evaluate(() => {
    const s = (window as any).__aluframe.store.getState()
    s.commitProfileEdit(s.profiles[0].id, { length: s.profiles[0].length + 10 })
  })
  const edited = await snapshot()
  await page.getByTestId('instance-param-w').fill('750')
  await page.getByTestId('template-instance-apply').click()
  await expect(page.getByTestId('template-instance-editor').getByRole('alert')).toContainText('手动修改')
  expect(await snapshot()).toEqual(edited)
})
