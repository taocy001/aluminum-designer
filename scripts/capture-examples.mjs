/** Refresh the example screenshots and BOMs from their current JSON geometry.
 * Start Vite on 5174, then run: node scripts/capture-examples.mjs
 */
import { chromium } from '@playwright/test'
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
  await page.goto(baseURL)
  await page.waitForFunction(() => window.__aluframe?.setView)
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
  const samples = [
    ['c0', 'L 角接 · L 型角码', [240, -170, 280], ['p0', 'p1']],
    ['c1', 'L 角接 · 内角码', [240, -170, 280], ['p2', 'p3']],
    ['c2', 'L 角接 · 加强筋', [200, -130, -360], ['p4', 'p5']],
    ['c3', 'T 接 · T 型角码', [180, 100, 400], ['p6', 'p7']],
    ['c4', 'T 接 · L 型角码', [240, 170, 280], ['p8', 'p9']],
    ['c5', '三维角 · 三维角码', [220, -150, 280], ['p10', 'p11', 'p12']],
    ['c6', '十字面装 · 十字连接板', [170, 120, -420], ['p13', 'p14']],
    ['c7', '对接延长 · 直连板', [220, 230, 350], ['p15', 'p16']],
    ['c8', '对接延长 · 对接板', [180, 160, -350], ['p17', 'p18']],
    ['c9', '端面 · 端盖', [380, 130, 190], ['p19']],
    ['c10', '柱底 · 调节脚', [200, 120, 300], ['p20']],
    ['c11', '柱底 · 脚轮座', [250, 150, 375], ['p21']],
    ['c12', '槽内 · 滑块螺母', [160, 280, 250], ['p22']],
    ['c13', '面装 · 合页', [220, 100, 350], ['p23']],
    ['c14', '面装 · 轴承座', [160, 280, 250], ['p24']],
  ]
  const canvas = await page.locator('canvas').boundingBox()
  if (!canvas || demo.connectors.length !== samples.length) throw new Error('Connector demo must contain all 15 samples')
  const clip = { x: canvas.x + (canvas.width - 650) / 2, y: canvas.y + (canvas.height - 520) / 2, width: 650, height: 520 }
  const tiles = []
  for (const [id, label, offset, profileIds] of samples) {
    const part = demo.connectors.find((connector) => connector.id === id)
    if (!part) throw new Error(`Connector demo is missing ${id}`)
    const profiles = demo.profiles.filter((profile) => profileIds.includes(profile.id))
    if (profiles.length !== profileIds.length) throw new Error(`Connector demo is missing members for ${id}`)
    // Each tile shows one complete fixture, without unrelated samples in its background.
    await show({ ...demo, profiles, connectors: [part] })
    await page.evaluate(({ target, offset }) => {
      window.__aluframe.setView(target.map((value, axis) => value + offset[axis]), target)
    }, { target: part.position, offset })
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const png = await page.screenshot({ clip })
    tiles.push({ label, src: `data:image/png;base64,${png.toString('base64')}` })
  }
  const collage = await browser.newPage({ viewport: { width: 1300, height: 1920 } })
  await collage.setContent('<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>body{margin:0;background:#0f172a;color:#e2e8f0;font:20px system-ui,sans-serif}main{box-sizing:border-box;padding:8px;display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(5,1fr);gap:8px;width:1300px;height:1920px}figure{margin:0;min-height:0;overflow:hidden;background:#1e293b;display:flex;flex-direction:column}img{display:block;width:100%;min-height:0;flex:1;object-fit:cover}figcaption{padding:9px 12px;line-height:24px;white-space:nowrap}</style></head><body><main></main></body></html>')
  await collage.evaluate((tiles) => {
    const main = document.querySelector('main')
    for (const tile of tiles) {
      const figure = document.createElement('figure')
      const image = document.createElement('img')
      image.src = tile.src
      image.alt = tile.label
      const caption = document.createElement('figcaption')
      caption.textContent = tile.label
      figure.append(image, caption)
      main.append(figure)
    }
    return Promise.all(Array.from(document.images, (image) => image.decode()))
  }, tiles)
  await collage.screenshot({ path: join(output, 'connector-demo.png') })
  await collage.close()
  await page.evaluate(() => window.__aluframe.setView([600, 500, 600]))
  console.log('Refreshed connector close-ups')
  const flat = readdirSync('examples/flat').filter((name) => name.endsWith('.json')).sort().map((name) => JSON.parse(readFileSync(`examples/flat/${name}`, 'utf8')))
  const overview = await page.evaluate(async (sources) => {
    const { parseProjectDocument } = await import('/src/utils/document.ts')
    const { computeFrameBounds } = await import('/src/utils/jointUtils.ts')
    const result = { profiles: [], connectors: [], panels: [], fittings: [], throughRule: 'rails' }
    sources.forEach((source, index) => {
      const doc = parseProjectDocument(source)
      const box = computeFrameBounds(doc.profiles)
      const dx = (index % 4) * 4100 - box.min.x
      const dz = Math.floor(index / 4) * 2400 - box.min.z
      for (const kind of ['profiles', 'connectors', 'panels', 'fittings']) for (const part of doc[kind]) {
        result[kind].push({ ...part, id: `unit-${index}-${part.id}`, position: [part.position[0] + dx, part.position[1], part.position[2] + dz] })
      }
    })
    return result
  }, flat)
  await page.setViewportSize({ width: 2000, height: 1250 })
  await show(overview)
  await page.screenshot({ path: join(output, 'apartment-12-units-overview.png') })
  complete = true
  console.log('Refreshed apartment overview')
} finally {
  await browser.close()
  if (complete) for (const name of readdirSync(output)) copyFileSync(join(output, name), join('examples', name))
  rmSync(output, { recursive: true, force: true })
}
