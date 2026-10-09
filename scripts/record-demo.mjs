/** Record a five-tier shelving build through the public UI.
 * Serve a production build with VITE_TEST_HOOK=1 on 5174, then run node scripts/record-demo.mjs.
 * Output is staged in test-results/demo-recording; see docs/MEDIA.md for encoding.
 * Development hooks are read only: they project click targets and verify results.
 */
import { chromium } from '@playwright/test'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

const auditServer = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
const [{ computeAllTrims }, { auditBrackets }, { findConflicts }, { unfastenedPanels }] = await Promise.all(
  ['jointUtils', 'bracketSeat', 'analysis', 'panelFastening'].map(name => auditServer.ssrLoadModule(`/src/utils/${name}.ts`)))
await auditServer.close()

const out = 'test-results/demo-recording'
mkdirSync(out, { recursive: true })
// An interrupted run must never reuse the previous run's publication metadata.
for (const name of ['complete.json', 'chapters.json']) rmSync(`${out}/${name}`, { force: true })
let completed = false
const browser = await chromium.launch({ args: process.env.RECORD_GL_BACKEND
  ? ['--use-gl=angle', `--use-angle=${process.env.RECORD_GL_BACKEND}`, '--ignore-gpu-blocklist'] : [] })
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, recordVideo: { dir: out, size: { width: 1400, height: 900 } } })
const page = await context.newPage()
const started = Date.now()
const chapters = []
async function chapter(label) {
  chapters.push({ label, seconds: (Date.now() - started) / 1000 })
  await page.evaluate(label => { document.getElementById('demo-caption').textContent = label }, label)
  console.log(label)
}
page.setDefaultTimeout(60_000)
await page.addInitScript(() => { delete window.showOpenFilePicker; delete window.showSaveFilePicker })
await page.routeWebSocket('**/*', socket => socket.close())
const pause = (ms = 450) => page.waitForTimeout(ms)
const state = () => page.evaluate(() => {
  const s = window.__aluframe.store.getState()
  return { profiles: s.profiles, panels: s.panels, connectors: s.connectors, fittings: s.fittings, selectedIds: s.selectedIds }
})
let cursor = { x: 800, y: 650 }
async function move(x, y, duration = 450) {
  const steps = Math.ceil(duration / 25)
  const start = Date.now()
  for (let step = 1; step <= steps; step++) {
    await page.mouse.move(cursor.x + (x - cursor.x) * step / steps, cursor.y + (y - cursor.y) * step / steps)
    await pause(Math.max(1, start + duration * step / steps - Date.now()))
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
async function button(id) {
  const tab = id.startsWith('template-') || id.startsWith('connector-') || id === 'auto-connect' ? 'add'
    : id.startsWith('add-panel-') || id.startsWith('rot-') ? 'properties' : null
  if (tab) await click(page.getByTestId(`sidebar-tab-${tab}`))
  await click(page.getByTestId(id))
}
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
    const canvas = document.querySelector('canvas')
    const gl = canvas.getContext('webgl2')
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    window.__demoRenderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
    const cursor = document.createElement('div')
    cursor.style.cssText = 'position:fixed;pointer-events:none;z-index:99999;width:12px;height:12px;border:2px solid white;border-radius:50%;background:#3b82f6;transform:translate(-50%,-50%);left:-30px;top:-30px'
    document.body.append(cursor)
    document.addEventListener('pointermove', e => { cursor.style.left = `${e.clientX}px`; cursor.style.top = `${e.clientY}px` })
    document.addEventListener('pointerdown', () => { cursor.style.background = '#f59e0b' })
    document.addEventListener('pointerup', () => { cursor.style.background = '#3b82f6' })
    const caption = document.createElement('div')
    caption.id = 'demo-caption'
    caption.style.cssText = 'position:fixed;pointer-events:none;z-index:99998;bottom:45px;left:58%;transform:translateX(-50%);padding:8px 18px;border-radius:8px;background:#0f172ae8;color:#e2e8f0;font:15px sans-serif;white-space:nowrap'
    document.body.append(caption)
  })
  const renderer = await page.evaluate(() => window.__demoRenderer)
  assert(!/swiftshader|llvmpipe|software/i.test(renderer), `Hardware rendering required: ${renderer}`)
  console.log('WebGL renderer:', renderer)
  await chapter('设置尺寸，生成五层框架')
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
    await chapter(`第 ${tier + 1} 层：Shift 多选横梁，嵌入齐平隔板并安装固定件`)
    await key('Control+Shift+a')
    const y = 40 + tier * 350
    await world([0, y, 250])
    await world([1200, y, 250], true)
    assert.equal((await state()).selectedIds.length, 2, `Tier ${tier + 1}: Shift selection`)
    await button('add-panel-inset')
    const added = await state()
    assert.equal(added.panels.length, tier + 1)
    const panel = added.panels.at(-1)
    assert(Math.abs(panel.position[1] + panel.thickness / 2 - (y + 10)) < .01, 'Shelf top must be flush with the rails')
    const [qx, qy, qz, qw] = panel.quaternion
    assert(Math.abs(2 * (qy * qz - qw * qx)) > .999999, 'Shelf normal must be vertical')
    await click(page.getByRole('button', { name: '固定所选板材', exact: true }))
    assert.equal((await state()).connectors.filter(c => c.panelMount?.panelId === panel.id).length, 8, 'Each shelf needs eight mounts')
    console.log(`Added and fastened shelf ${tier + 1}`)
  }
  // Copy and undo are real commands with count assertions, not fabricated edits.
  const before = await state()
  await chapter('Ctrl+C / Ctrl+V 复制粘贴，撤销恢复')
  await key('Control+c'); await key('Control+v')
  assert.equal((await state()).panels.length, before.panels.length + 1)
  await pause(700)
  await click(page.getByRole('button', { name: '撤销', exact: true }))
  assert.equal((await state()).panels.length, before.panels.length)
  await key('Control+Shift+a')
  await chapter('选择内角码，连接框架接头')
  await button('connector-picker-toggle')
  await button('connector-inside-corner')
  await pause(700)
  await button('auto-connect')
  await key('Escape')
  const built = await state()
  assert(built.connectors.length > before.connectors.length)
  console.log('Auto-connect result:', built.profiles.length, 'profiles,', built.panels.length, 'panels,', built.connectors.length, 'connectors')
  const trims = computeAllTrims(built.profiles)
  const audit = {
    invalid: auditBrackets(built.profiles, built.connectors, trims, undefined, built.panels).length,
    conflicts: findConflicts(built.profiles, trims, built.connectors, built.panels, built.fittings).length,
    unfastened: unfastenedPanels(built).length,
  }
  assert.deepEqual(audit, { invalid: 0, conflicts: 0, unfastened: 0 }, 'Finished model must pass installation checks')
  await chapter('全选，Shift 拖拽移动整个置物架')
  await key('Control+a')
  const original = await state()
  const points = await page.evaluate(() => [
    window.__aluframe.worldToClient(600, 1440, 500),
    window.__aluframe.worldToClient(750, 1440, 500),
  ])
  await move(points[0].x, points[0].y)
  await page.keyboard.down('Shift'); await page.mouse.down()
  await move(points[1].x, points[1].y, 1800)
  await page.mouse.up(); await page.keyboard.up('Shift'); await pause(900)
  const moved = await state()
  assert(moved.profiles.every((p, i) => p.position.some((v, axis) => Math.abs(v - original.profiles[i].position[axis]) > 1)), 'Drag must move every selected profile')
  await key('Control+z')
  assert.deepEqual((await state()).profiles, original.profiles, 'Undo must restore the dragged frame')
  await chapter('输入 15°，绕 Y 轴旋转整组；撤销恢复')
  await button('sidebar-tab-properties')
  const angle = page.getByTestId('rotate-angle')
  await click(angle); await page.keyboard.press('Control+a'); await page.keyboard.type('15', { delay: 150 })
  await button('rot-y-plus'); await pause(1200)
  assert.notDeepEqual((await state()).profiles[0].position, original.profiles[0].position, 'Angle control must rotate the frame')
  await key('Control+z')
  assert.deepEqual((await state()).profiles, original.profiles)
  await key('Control+Shift+a')
  await chapter('切换正视图，检查隔板与横梁上表面齐平')
  await button('view-front'); await pause(900)
  await button('view-iso'); await button('fit-view'); await pause(900)
  await chapter('左键拖动空白处，环绕查看装配')
  await move(820, 160); await page.mouse.down()
  await move(1020, 195, 2400); await move(740, 175, 2400)
  await page.mouse.up(); await pause(900)
  await chapter('滚轮放大，检查板边和连接件；滚轮缩小')
  for (const delta of [-35, 35]) {
    for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, delta); await pause(90) }
    await pause(1000)
  }
  await chapter('右键拖动平移视图，F 适配整图')
  await move(820, 160); await page.mouse.down({ button: 'right' })
  await move(945, 210, 1600); await page.mouse.up({ button: 'right' }); await pause(800)
  await key('f')
  await button('view-iso'); await button('fit-view')
  await move(140, 350); await page.mouse.wheel(0, -5000); await pause(500)
  await chapter('保存 JSON，再打开核对工程')
  await button('export-project')
  const filename = page.getByTestId('save-filename')
  await click(filename); await page.keyboard.press('Control+a')
  await page.keyboard.type('five-tier-shelving.json', { delay: 65 })
  await pause(900)
  await page.evaluate(() => { document.getElementById('demo-caption').style.display = 'none' })
  await page.screenshot({ path: `${out}/save-dialog.png` })
  const download = page.waitForEvent('download')
  await button('save-confirm')
  await (await download).saveAs(`${out}/five-tier-shelving.json`)
  // A download does not bind the file. Reopen the saved JSON through the file menu.
  await button('file-menu')
  const chooser = page.waitForEvent('filechooser')
  await button('import-project')
  await (await chooser).setFiles(`${out}/five-tier-shelving.json`)
  await button('switch-keep-draft')
  await page.getByTestId('current-project-name').filter({ hasText: 'five-tier-shelving.json' }).waitFor()
  await button('fit-view')
  await button('sidebar-tab-objects')
  await move(345, 100); await pause(1500)
  await page.screenshot({ path: `${out}/editor.png` })
  console.log('Saved demo document and screenshots')
  writeFileSync(`${out}/chapters.json`, JSON.stringify(chapters, null, 2))
  completed = true
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
  if (completed) {
    const files = ['demo.webm', 'chapters.json', 'editor.png', 'save-dialog.png', 'five-tier-shelving.json']
    const hashes = Object.fromEntries(files.map(name => [name, createHash('sha256').update(readFileSync(`${out}/${name}`)).digest('hex')]))
    writeFileSync(`${out}/complete.json`, JSON.stringify(hashes, null, 2))
  }
}
