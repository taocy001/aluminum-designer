/** Refresh the example screenshots and BOMs from their current JSON geometry.
 * Start Vite on 5174, then run: node scripts/capture-examples.mjs
 */
import { chromium } from '@playwright/test'
import { Quaternion, Vector3 } from 'three'
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const baseURL = process.env.EXAMPLES_BASE_URL ?? 'http://127.0.0.1:5174'
const names = ['kitchen-l-shaped', 'wardrobe-2-door', 'desk-with-pedestal', 'bookcase-tall', 'display-shelf-open', 'rolling-cart']
// Writing watched example files mid-capture reloads Vite. Publish the completed batch
// only after the browser has closed, so every screenshot captures the intended document.
const output = mkdtempSync(join(tmpdir(), 'aluframe-examples-'))
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
let complete = false
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
  // A static capture must not reload when the dev server broadcasts file changes.
  await page.routeWebSocket('**/*', (socket) => socket.close())
  await page.goto(baseURL)
  await page.waitForFunction(() => window.__aluframe?.setView)
  // Render changes on demand during static captures to let the GPU finish each frame.
  await page.evaluate(async () => {
    const viewport = await (await fetch('/src/components/Viewport.tsx')).text()
    const moduleURL = viewport.match(/from "([^"]*react-three_fiber[^"]*)"/)?.[1]
    if (!moduleURL) throw new Error('Cannot find the active canvas module')
    const { _roots } = await import(moduleURL)
    for (const root of _roots.values()) root.store.getState().setFrameloop('demand')
  })
  const show = async (source) => {
    const result = await page.evaluate(async (source) => {
      const { parseProjectDocument } = await import('/src/utils/document.ts')
      const { buildBom, bomToCsv } = await import('/src/utils/bom.ts')
      const { computeAllTrims, computeFrameBounds } = await import('/src/utils/jointUtils.ts')
      const doc = parseProjectDocument(source)
      const { store, tool } = window.__aluframe
      store.getState().loadDocument(doc)
      tool.getState().setLanguage('zh')
      tool.getState().setViewMode(true)
      tool.setState({ showDimensionLabels: false, showFittings: true, buildStep: null })
      tool.getState().triggerCameraReset('all')
      const trims = computeAllTrims(doc.profiles)
      const box = computeFrameBounds(doc.profiles, trims)
      const size = box ? [box.max.x - box.min.x, box.max.z - box.min.z, box.max.y - box.min.y] : []
      const overall = size.map((v) => Math.round(v * 1000) / 1000).join('x')
      return bomToCsv(buildBom(doc.profiles, doc.connectors, trims, 'zh', doc.panels, doc.fittings), overall)
    }, source)
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.mouse.move(1, 1)
    return result
  }
  for (const name of names) {
    const source = JSON.parse(readFileSync(`examples/${name}.json`, 'utf8'))
    const csv = await show(source)
    await page.screenshot({ path: join(output, `${name}.png`) })
    writeFileSync(join(output, `${name}-bom.csv`), '\ufeff' + csv + '\n')
    console.log(`Refreshed ${name}`)
  }
  const demo = JSON.parse(readFileSync('examples/connector-demo.json', 'utf8'))
  await show(demo)
  // Use fixed close-up views of the current document, then assemble the renders.
  // Keep scene diagnostics visible: a broken sample must remain visible in its image.
  // Camera offsets are in each connector's local frame, so the selected mounting
  // side stays visible if the fixture chooses the opposite outside face.
  const samples = [
    ['bracket', 'L 角接 · L 型角码', [240, 170, 280]],
    ['inside-corner', '槽内 · 内角码与两颗顶丝', [240, 170, 280]],
    ['gusset', 'L 角接 · 40 系列加强角码', [220, 160, 280]],
    ['t-bracket', '五孔面装 · T 型连接板', [180, 100, 400]],
    ['corner-3way', '三端面攻牙 · 三维角块', [220, 160, 280]],
    ['flat-plate', '对接延长 · 四孔直连板', [200, 300, 230]],
    ['joining-plate', '对接延长 · 两孔对接板', [380, 140, 180]],
    ['end-cap', '匹配完整截面 · 2040 端盖', [240, 180, 380]],
    ['foot', 'M8 攻牙端孔 · 调节脚', [200, 120, 300]],
    ['cross-bracket', '三构件面装 · 十字连接板', [170, 120, 420]],
    ['t-nut', 'I8 槽内 · M8 槽螺母', [160, 280, 250]],
    ['hinge', '两构件四孔 · 合页', [380, 160, 190]],
    ['pivot', '两孔固定 · 轴承座', [200, 220, 300]],
    ['caster-mount', '3030 B8 端孔 M8×25 · 75 mm 脚轮', [250, 150, 375]],
  ]
  const canvas = await page.locator('canvas').boundingBox()
  if (!canvas || demo.connectors.length !== 14 || samples.length !== 14
    || new Set(demo.connectors.map((part) => part.type)).size !== 14) throw new Error('Connector demo must contain all 14 connector types')
  if (demo.showcaseSamples?.length) throw new Error('Every connector demo part must be installed')
  const clip = { x: canvas.x + (canvas.width - 650) / 2, y: canvas.y + (canvas.height - 520) / 2, width: 650, height: 520 }
  const tiles = []
  for (const [id, label, offset] of samples) {
    const part = demo.connectors.find((connector) => connector.id === id)
    if (!part) throw new Error(`Connector demo is missing ${id}`)
    const profileIds = demo.showcaseFixtures?.find((fixture) => fixture.connectorId === id)?.profileIds
    if (!profileIds?.length) throw new Error(`Connector demo is missing its fixture for ${id}`)
    const profiles = demo.profiles.filter((profile) => profileIds.includes(profile.id))
    if (profiles.length !== profileIds.length) throw new Error(`Connector demo is missing members for ${id}`)
    // Each tile shows one complete fixture, without unrelated samples in its background.
    await show({ ...demo, profiles, connectors: [part] })
    const direction = new Vector3(...offset).applyQuaternion(new Quaternion(...part.quaternion)).toArray()
    await page.evaluate(({ target, direction }) => {
      window.__aluframe.setView(target.map((value, axis) => value + direction[axis]), target)
    }, { target: part.position, direction })
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const png = await page.screenshot({ clip })
    tiles.push({ label, note: '', src: `data:image/png;base64,${png.toString('base64')}` })
  }
  const collage = await browser.newPage({ viewport: { width: 1300, height: 1920 } })
  await collage.setContent('<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>body{margin:0;background:#0f172a;color:#e2e8f0;font:20px system-ui,sans-serif}main{box-sizing:border-box;padding:8px;display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(5,1fr);gap:8px;width:1300px;height:1920px}figure{margin:0;min-height:0;overflow:hidden;background:#1e293b;display:flex;flex-direction:column}img{display:block;width:100%;min-height:0;flex:1;object-fit:cover}figcaption{padding:9px 12px;line-height:24px}small{display:block;color:#fbbf24;font-size:14px;line-height:19px}</style></head><body><main></main></body></html>')
  await collage.evaluate((tiles) => {
    const main = document.querySelector('main')
    for (const tile of tiles) {
      const figure = document.createElement('figure')
      const image = document.createElement('img')
      image.src = tile.src
      image.alt = tile.label
      const caption = document.createElement('figcaption')
      caption.textContent = tile.label
      if (tile.note) {
        const note = document.createElement('small')
        note.textContent = tile.note
        caption.append(note)
      }
      figure.append(image, caption)
      main.append(figure)
    }
    return Promise.all(Array.from(document.images, (image) => image.decode()))
  }, tiles)
  await collage.screenshot({ path: join(output, 'connector-demo.png') })
  await collage.close()
  await page.evaluate(() => window.__aluframe.setView([600, 500, 600]))
  console.log('Refreshed connector close-ups')
  // Render each cabinet separately: combining every assembly retains thousands
  // of meshes and obscures both small cabinets and the installation diagnostics.
  await page.setViewportSize({ width: 1000, height: 700 })
  const flatImages = []
  for (const name of readdirSync('examples/flat').filter((name) => name.endsWith('.json')).sort()) {
    await show(JSON.parse(readFileSync(`examples/flat/${name}`, 'utf8')))
    const src = await page.evaluate(async () => {
      const viewport = await (await fetch('/src/components/Viewport.tsx')).text()
      const moduleURL = viewport.match(/from "([^"]*react-three_fiber[^"]*)"/)?.[1]
      if (!moduleURL) throw new Error('Cannot find the active canvas module')
      const { _roots } = await import(moduleURL)
      const root = _roots.values().next().value?.store.getState()
      if (!root) throw new Error('Canvas renderer is unavailable')
      root.setFrameloop('demand')
      root.gl.render(root.scene, root.camera)
      return root.gl.domElement.toDataURL('image/png')
    })
    flatImages.push({ label: name.replace('.json', ''), src })
    console.log(`Refreshed ${name}`)
  }
  await page.close()
  const overview = await browser.newPage({ viewport: { width: 2000, height: 1120 } })
  await overview.setContent('<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>body{margin:0;background:#0f172a;color:#e2e8f0;font:18px system-ui,sans-serif}main{padding:8px;display:grid;grid-template-columns:repeat(4,1fr);gap:8px}figure{margin:0;background:#1e293b}img{display:block;width:100%}figcaption{padding:8px 12px}</style></head><body><main></main></body></html>')
  await overview.evaluate(async (images) => {
    for (const tile of images) {
      const figure = document.createElement('figure')
      const image = document.createElement('img')
      image.src = tile.src
      image.alt = tile.label
      const caption = document.createElement('figcaption')
      caption.textContent = tile.label
      figure.append(image, caption)
      document.querySelector('main').append(figure)
    }
    await Promise.all(Array.from(document.images, (image) => image.decode()))
  }, flatImages)
  await overview.screenshot({ path: join(output, 'apartment-12-units-overview.png'), fullPage: true })
  await overview.close()
  complete = true
  console.log('Refreshed apartment overview')
} finally {
  await browser.close()
  if (complete) for (const name of readdirSync(output)) copyFileSync(join(output, name), join('examples', name))
  if (complete) rmSync(output, { recursive: true, force: true })
  else console.error(`Incomplete capture; completed images retained in ${output}`)
}
