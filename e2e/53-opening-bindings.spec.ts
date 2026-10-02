import { expect, test, type Page } from '@playwright/test'
import { PROJECT_VERSION } from '../src/utils/document'
import { openApp, store, useDownloadFallback } from './helpers'

const faceChoices = {
  left: 'left:0:1', right: 'right:0:-1', bottom: 'bottom:1:1',
  top: 'top:1:-1', front: 'left:1:1',
}

async function loadFrame(page: Page, kind: 'door' | 'drawer' | 'panel') {
  await page.evaluate(({ kind, version }) => {
    const profile = (id: string, position: number[], length: number, quaternion: number[]) => ({
      id, spec: '2020', position, length, quaternion, holes: [], miterCuts: [], fixedTrims: { start: 0, end: 0 },
    })
    const vertical = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]
    const horizontal = [0, Math.SQRT1_2, 0, Math.SQRT1_2]
    const common = { id: kind, width: 300, height: 180, material: 'ply', position: [300, 120, 0], quaternion: [0, 0, 0, 1] }
    const s = (window as any).__aluframe.store
    s.getState().loadDocument({ version, throughRule: 'rails', profiles: [
      profile('left', [-10, 0, 260], 600, vertical), profile('right', [610, 0, 260], 600, vertical),
      profile('bottom', [-20, -10, 260], 640, horizontal), profile('top', [-20, 610, 260], 640, horizontal),
    ], connectors: [], panels: kind === 'panel' ? [{ ...common, thickness: 18 }] : [],
    fittings: kind === 'panel' ? [] : [{ ...common, kind, depth: 400, open: 0 }] })
    s.setState({ selectedIds: [kind, 'left', 'right', 'bottom', 'top'], past: [], future: [] })
  }, { kind, version: PROJECT_VERSION })
}

async function chooseOpening(page: Page, id: string) {
  const editor = page.getByTestId(`opening-binding-${id}`)
  await editor.getByTestId('binding-enabled').check()
  await expect(editor.getByTestId('binding-apply')).toBeDisabled()
  for (const [role, value] of Object.entries(faceChoices))
    await editor.getByTestId(`binding-face-${role}`).selectOption(value)
  await editor.getByTestId('binding-fixed-depth').check()
  await editor.getByRole('spinbutton', { name: '深度（mm）', exact: true }).fill('500')
  await expect(editor.getByTestId('binding-preview')).toHaveText('600 × 600 × 500 mm')
  return editor
}

async function select(page: Page, id: string) {
  await page.evaluate((id) => (window as any).__aluframe.store.getState().selectItems([id]), id)
}

async function resizeOpening(page: Page, width: number) {
  return page.evaluate((width) => (window as any).__aluframe.store.getState().commitTransform({ profiles: [
    { id: 'right', updates: { position: [width + 10, 0, 260] } },
    { id: 'bottom', updates: { length: width + 40 } }, { id: 'top', updates: { length: width + 40 } },
  ] }), width)
}

test('explicit door boundaries follow source edits, undo, save and reload', async ({ page }) => {
  await useDownloadFallback(page)
  await openApp(page)
  await loadFrame(page, 'door')
  const editor = await chooseOpening(page, 'door')
  await editor.getByTestId('binding-apply').click()
  await expect(editor.getByTestId('binding-status')).toHaveText('洞口边界已关联')
  const bound = await store(page)
  expect(bound.fittings[0]).toMatchObject({ width: 600, height: 600, depth: 500, frame: 20,
    position: [300, 300, 0], openingBinding: { mode: 'door', start: 0, end: 1 } })
  expect(bound.past).toBe(1)

  expect((await resizeOpening(page, 700)).status).toBe('applied')
  const resized = await store(page)
  expect(resized.fittings[0]).toMatchObject({ width: 700, position: [350, 300, 0] })
  expect(resized.past).toBe(2)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  expect((await store(page)).profiles).toEqual(bound.profiles)
  expect((await store(page)).fittings).toEqual(bound.fittings)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  expect((await store(page)).fittings).toEqual(resized.fittings)

  const downloadEvent = page.waitForEvent('download')
  await page.getByTestId('export-project').click()
  const download = await downloadEvent
  const stream = await download.createReadStream(), chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(chunk)
  const saved = JSON.parse(Buffer.concat(chunks).toString())
  expect(saved.version).toBe(PROJECT_VERSION)
  expect(saved.fittings[0].openingBinding).toEqual(resized.fittings[0].openingBinding)
  expect(saved.profiles.map((p: { id: string }) => p.id)).toEqual(['left', 'right', 'bottom', 'top'])
  await expect(page.getByTestId('autosave-status')).toHaveAttribute('data-state', 'saved')
  await page.reload()
  await page.waitForFunction(() => (window as any).__aluframe?.store.getState().fittings[0]?.openingBinding)
  expect((await store(page)).fittings).toEqual(resized.fittings)
  await select(page, 'door')
  await expect(page.getByTestId('binding-status')).toHaveText('洞口边界已关联')
  expect((await resizeOpening(page, 800)).status).toBe('applied')
  expect((await store(page)).fittings[0]).toMatchObject({ width: 800, position: [400, 300, 0] })
})

test('a locked linked drawer rejects source edits and a deleted source retains its geometry', async ({ page }) => {
  await openApp(page)
  await loadFrame(page, 'drawer')
  const editor = await chooseOpening(page, 'drawer')
  await editor.getByRole('spinbutton', { name: '底部偏移 (mm)', exact: true }).fill('30')
  await editor.getByTestId('binding-apply').click()
  expect((await store(page)).fittings[0]).toMatchObject({ width: 600, height: 180, depth: 500,
    position: [300, 120, 0], openingBinding: { mode: 'drawer', bottomOffset: 30 } })
  await select(page, 'drawer')
  await page.getByTestId('lock-toggle').click()
  const locked = await store(page)
  expect(locked.fittings[0].locked).toBe(true)
  expect(await resizeOpening(page, 700)).toMatchObject({ status: 'rejected', reason: 'locked-dependent', partIds: ['drawer'] })
  const rejected = await store(page)
  expect(rejected.profiles).toEqual(locked.profiles)
  expect(rejected.fittings).toEqual(locked.fittings)
  expect(rejected.past).toBe(locked.past)
  expect(rejected.future).toBe(locked.future)

  await page.getByTestId('lock-toggle').click()
  const beforeDeletion = await store(page)
  await select(page, 'right')
  await page.getByTestId('delete-selected').click()
  const orphaned = await store(page)
  expect(orphaned.profiles.some((p) => p.id === 'right')).toBe(false)
  expect(orphaned.fittings).toEqual(beforeDeletion.fittings)
  expect(orphaned.past).toBe(beforeDeletion.past + 1)
  await select(page, 'drawer')
  await expect(page.getByTestId('binding-status')).toContainText('来源已缺失，保留上次几何')
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(page.getByTestId('binding-status')).toHaveText('洞口边界已关联')
  expect((await store(page)).fittings).toEqual(beforeDeletion.fittings)
})

test('a panel follows its chosen opening face, edge margins and outward offset', async ({ page }) => {
  await openApp(page)
  await loadFrame(page, 'panel')
  const editor = await chooseOpening(page, 'panel')
  await expect(editor.getByRole('combobox', { name: '板件所在面', exact: true })).toHaveValue('front')
  for (const [name, value] of [['左侧边距 (mm)', '5'], ['右侧边距 (mm)', '15'],
    ['底部边距 (mm)', '10'], ['顶部边距 (mm)', '20'], ['向外偏移 (mm)', '9']])
    await editor.getByRole('spinbutton', { name, exact: true }).fill(value)
  await editor.getByTestId('binding-apply').click()
  await expect(editor.getByTestId('binding-status')).toHaveText('洞口边界已关联')
  const bound = await store(page)
  expect(bound.panels[0]).toMatchObject({ width: 580, height: 570, position: [295, 295, 259],
    openingBinding: { mode: 'front', margins: { left: 5, right: 15, bottom: 10, top: 20 }, normalOffset: 9 } })
  expect((await resizeOpening(page, 700)).status).toBe('applied')
  expect((await store(page)).panels[0]).toMatchObject({ width: 680, height: 570, position: [345, 295, 259] })
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  expect((await store(page)).panels).toEqual(bound.panels)
})
