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
