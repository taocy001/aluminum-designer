/** Record a five-tier shelving build through the public UI.
 * Start Vite on 5174, then run node scripts/record-demo.mjs.
 * Output is staged in test-results/demo-recording; see docs/MEDIA.md for encoding.
 * Development hooks are read only: they project click targets and verify results.
 */
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import assert from 'node:assert/strict'

const out = 'test-results/demo-recording'
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, recordVideo: { dir: out, size: { width: 1400, height: 900 } } })
const page = await context.newPage()
page.setDefaultTimeout(60_000)
await page.addInitScript(() => { delete window.showOpenFilePicker; delete window.showSaveFilePicker })
await page.routeWebSocket('**/*', socket => socket.close())
const pause = (ms = 450) => page.waitForTimeout(ms)
const state = () => page.evaluate(() => {
  const s = window.__aluframe.store.getState()
  return { profiles: s.profiles, panels: s.panels, connectors: s.connectors, selectedIds: s.selectedIds }
})
let cursor = { x: 800, y: 650 }
async function move(x, y) {
  for (let step = 1; step <= 12; step++) {
    await page.mouse.move(cursor.x + (x - cursor.x) * step / 12, cursor.y + (y - cursor.y) * step / 12)
    await pause(18)
  }
  cursor = { x, y }
  await pause(180)
}
async function click(locator) {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  assert(box)
  await move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down(); await pause(80); await page.mouse.up(); await pause()
}
const button = id => click(page.getByTestId(id))
async function key(value) {
  await page.getByTestId('viewport').focus()
  await page.keyboard.press(value)
  await pause()
}
async function number(label, value) {
  const field = page.getByTestId('template-block').getByRole('spinbutton', { name: label, exact: true })
  await click(field)
  await page.keyboard.press('Control+a')
  await page.keyboard.type(String(value), { delay: 100 })
  await page.keyboard.press('Enter')
  await pause()
}
async function world(point, shift = false) {
  const p = await page.evaluate(p => window.__aluframe.worldToClient(...p), point)
  assert(p.x > 330 && p.x < 1330 && p.y > 70 && p.y < 850, 'Target outside drawing area')
  await move(p.x, p.y)
  if (shift) await page.keyboard.down('Shift')
  await page.mouse.down(); await pause(80); await page.mouse.up()
  if (shift) await page.keyboard.up('Shift')
  await pause()
}
try {
  await page.goto(process.env.EXAMPLES_BASE_URL ?? 'http://127.0.0.1:5174')
  await page.waitForFunction(() => window.__aluframe?.worldToClient)
  assert.equal((await state()).profiles.length, 0, 'Use a fresh browser context')
  await page.evaluate(() => {
    const cursor = document.createElement('div')
    cursor.style.cssText = 'position:fixed;pointer-events:none;z-index:99999;width:12px;height:12px;border:2px solid white;border-radius:50%;background:#3b82f6;transform:translate(-50%,-50%);left:-30px;top:-30px'
    document.body.append(cursor)
    document.addEventListener('pointermove', e => { cursor.style.left = `${e.clientX}px`; cursor.style.top = `${e.clientY}px` })
    document.addEventListener('pointerdown', () => { cursor.style.background = '#f59e0b' })
    document.addEventListener('pointerup', () => { cursor.style.background = '#3b82f6' })
  })
  // Render only when the view changes; this also keeps software-rendered recordings responsive.
  await page.evaluate(async () => {
    const source = await (await fetch('/src/components/Viewport.tsx')).text()
    const url = source.match(/from "([^"]*react-three_fiber[^"]*)"/)?.[1]
    if (!url) throw new Error('Canvas module missing')
    const { _roots } = await import(url)
    for (const root of _roots.values()) root.store.getState().setFrameloop('demand')
  })
  await pause(800)
  await button('template-shelving')
  await number('宽', 1200)
  await number('深', 500)
  await number('层数', 5)
  await number('层高', 350)
  await button('template-place')
  assert.equal((await state()).profiles.length, 24)
  await button('fit-view')
  await button('labels-toggle')
  await pause(900)
  console.log('Built 24-member frame through template controls')

  // Two parallel rails define each opening; connected side rails close its bounds.
  for (let tier = 0; tier < 5; tier++) {
    await key('Control+Shift+a')
    const y = 40 + tier * 350
    await world([0, y, 250])
    await world([1200, y, 250], true)
    assert.equal((await state()).selectedIds.length, 2, `Tier ${tier + 1}: Shift selection`)
    await button('add-panel-inset')
    const added = await state()
    assert.equal(added.panels.length, tier + 1)
    const panel = added.panels.at(-1)
    assert(Math.abs(panel.position[1] - y - 19) < .01, 'Shelf must be at the selected level')
    const [qx, qy, qz, qw] = panel.quaternion
    assert(Math.abs(2 * (qy * qz - qw * qx)) > .999999, 'Shelf normal must be vertical')
    await click(page.getByRole('button', { name: '固定所选板材', exact: true }))
    assert.equal((await state()).connectors.filter(c => c.panelMount?.panelId === panel.id).length, 8, 'Each shelf needs eight mounts')
    console.log(`Added and fastened shelf ${tier + 1}`)
  }
  // Copy and undo are real commands with count assertions, not fabricated edits.
  const before = await state()
  await key('Control+c'); await key('Control+v')
  assert.equal((await state()).panels.length, before.panels.length + 1)
  await pause(700)
  await click(page.getByRole('button', { name: '撤销', exact: true }))
  assert.equal((await state()).panels.length, before.panels.length)
  await key('Control+Shift+a')
  await button('connector-picker-toggle')
  await button('connector-inside-corner')
  await pause(700)
  await button('auto-connect')
  await key('Escape')
  const built = await state()
  assert(built.connectors.length > before.connectors.length)
  console.log('Auto-connect result:', built.profiles.length, 'profiles,', built.panels.length, 'panels,', built.connectors.length, 'connectors')
  const audit = await page.evaluate(async () => {
    const { computeAllTrims } = await import('/src/utils/jointUtils.ts')
    const { auditBrackets } = await import('/src/utils/bracketSeat.ts')
    const { findConflicts } = await import('/src/utils/analysis.ts')
    const { unfastenedPanels } = await import('/src/utils/panelFastening.ts')
    const d = window.__aluframe.store.getState()
    const trims = computeAllTrims(d.profiles)
    return {
      invalid: auditBrackets(d.profiles, d.connectors, trims, undefined, d.panels).length,
      conflicts: findConflicts(d.profiles, trims, d.connectors, d.panels, d.fittings).length,
      unfastened: unfastenedPanels(d).length,
    }
  })
  assert.deepEqual(audit, { invalid: 0, conflicts: 0, unfastened: 0 }, 'Finished model must pass installation checks')
  await key('Control+Shift+a')
  await button('view-front'); await pause(900)
  await button('view-iso'); await button('fit-view'); await pause(900)
  // Orbit from empty sky, as a user does when checking the finished frame.
  await move(820, 160); await page.mouse.down()
  await page.mouse.move(900, 180, { steps: 30 }); await page.mouse.up(); await pause(900)
  await button('fit-view')
  await button('export-project')
  const filename = page.getByTestId('save-filename')
  await click(filename); await page.keyboard.press('Control+a')
  await page.keyboard.type('five-tier-shelving.json', { delay: 65 })
  await pause(900)
  await page.screenshot({ path: `${out}/save-dialog.png` })
  const download = page.waitForEvent('download')
  await button('save-confirm')
  await (await download).saveAs(`${out}/five-tier-shelving.json`)
  // A download does not bind the file. Reopen the saved JSON through the file menu.
  await button('file-menu')
  const chooser = page.waitForEvent('filechooser')
  await button('import-project')
  await (await chooser).setFiles(`${out}/five-tier-shelving.json`)
  await page.getByTestId('current-project-name').filter({ hasText: 'five-tier-shelving.json' }).waitFor()
  await button('fit-view')
  await pause(1500)
  await page.screenshot({ path: `${out}/editor.png` })
  console.log('Saved demo document and screenshots')
} catch (error) {
  await page.screenshot({ path: `${out}/failure.png` }).catch(() => {})
  console.error('Recording failed:', error.message)
  throw error
} finally {
  const video = page.video()
  await context.close()
  await video.saveAs(`${out}/demo.webm`)
  await video.delete()
  await browser.close()
}
