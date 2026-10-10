/** Benchmark repeated real assemblies. Usage: node scripts/benchmark-mixed.mjs URL /tmp/results.json */
import { chromium } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { Quaternion, Vector3 } from 'three'
import assert from 'node:assert/strict'
const source = JSON.parse(readFileSync(new URL('../examples/flat/05-media-unit.json', import.meta.url), 'utf8'))
const kinds = ['profiles', 'connectors', 'panels', 'fittings', 'equipment']
const browser = await chromium.launch({ args: ['--use-gl=angle', `--use-angle=${process.env.BENCH_GL_BACKEND ?? 'swiftshader'}`, '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const results = []
const statistics = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return { samples: sorted.length, medianMs: sorted[Math.floor(sorted.length * .5)] ?? 0, p95Ms: sorted[Math.floor(sorted.length * .95)] ?? 0 }
}
try {
  for (const copies of [1, 3]) {
    const doc = { throughRule: source.throughRule, ...Object.fromEntries(kinds.map(k => [k, []])) }
    for (let i = 0; i < copies; i++) {
      const ids = new Map(kinds.flatMap(k => (source[k] ?? []).map(p => [p.id, `copy-${i}-${p.id}`])))
      const remap = value => Array.isArray(value) ? value.map(remap) : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v)])) : ids.get(value) ?? value
      for (const k of kinds) doc[k].push(...(source[k] ?? []).map(p => {
        const copy = remap(p); copy.position[0] += i * 2000; return copy
      }))
      // A separate board adds the standalone-panel render path without changing the fixture's joints.
      doc.panels.push({ id: `board-${i}`, width: 600, height: 350, thickness: 18, material: 'ply',
        position: [900 + i * 2000, 850, 200], quaternion: [0, 0, 0, 1] })
    }
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.goto(process.argv[2] ?? 'http://127.0.0.1:4186')
    await page.waitForFunction(() => window.__aluframe?.setView)
    const renderer = await page.evaluate(({ doc, copies, kinds }) => {
      const api = window.__aluframe
      api.store.getState().loadDocument(doc)
      api.tool.getState().putDown()
      api.tool.setState({ showPartNumbers: false, showDimensionLabels: false })
      api.store.setState({ selectedIds: kinds.flatMap(k => doc[k].map(p => p.id)) })
      api.setView([copies * 1000 + 1500, 1900, copies * 2500 + 1500], [copies * 1000 - 100, 350, 200])
      const gl = document.querySelector('canvas').getContext('webgl2'), ext = gl.getExtension('WEBGL_debug_renderer_info')
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown'
    }, { doc, copies, kinds })
    await page.waitForTimeout(1200)
    const resources = await page.evaluate(() => {
      const geometries = new Set(), materials = new Set()
      let renderables = 0
      window.__aluframe.sceneRoot.traverseVisible(o => {
        if (!o.isMesh && !o.isLine) return
        renderables++
        if (o.geometry) geometries.add(o.geometry.uuid)
        for (const material of Array.isArray(o.material) ? o.material : [o.material]) if (material) materials.add(material.uuid)
      })
      return { renderables, geometries: geometries.size, materials: materials.size }
    })
    const points = doc.profiles.map(p => new Vector3(0, 0, p.length / 2).applyQuaternion(new Quaternion(...p.quaternion)).add(new Vector3(...p.position)).toArray())
    const target = await page.evaluate(points => {
      for (const p of points) {
        const at = window.__aluframe.worldToClient(...p)
        if (at.x < 430 || at.x > 1100 || at.y < 160 || at.y > 760) continue
        const hit = window.__aluframe.pickAt(at.x, at.y)[0]
        if (hit?.kind === 'profile') return { ...at, id: hit.id }
      }
    }, points)
    assert(target, 'A visible profile must be picked')
    const pickSamples = await page.evaluate(at => Array.from({ length: 30 }, () => {
      const start = performance.now(); window.__aluframe.pickAt(at.x, at.y); return performance.now() - start
    }), target)
    const profiler = process.env.BENCH_PROFILE ? await page.context().newCDPSession(page) : null
    if (profiler) { await profiler.send('Profiler.enable'); await profiler.send('Profiler.start') }
    const before = await page.evaluate(() => window.__aluframe.store.getState().profiles[0].position)
    await page.mouse.move(target.x, target.y)
    await page.keyboard.down('Shift')
    await page.mouse.down()
    await page.evaluate(() => {
      window.__bench = { frames: [], start: performance.now() }
      window.__aluframe.sceneRoot.onAfterRender = () => window.__bench.frames.push(performance.now())
    })
    const inputSamples = []
    for (let i = 1; i <= 24; i++) {
      const start = performance.now()
      await page.mouse.move(target.x + i * 3, target.y - i / 2)
      inputSamples.push(performance.now() - start)
      await page.waitForTimeout(16)
    }
    await page.mouse.up(); await page.keyboard.up('Shift')
    const drag = await page.evaluate(() => {
      const s = window.__aluframe.store.getState(), b = window.__bench
      window.__aluframe.sceneRoot.onAfterRender = () => {}
      return { position: s.profiles[0].position, selected: s.selectedIds.length, frames: b.frames, elapsedMs: performance.now() - b.start }
    })
    if (profiler) {
      const { profile } = await profiler.send('Profiler.stop')
      writeFileSync(`${process.env.BENCH_PROFILE}-${copies}.cpuprofile`, JSON.stringify(profile))
    }
    assert.notDeepEqual(drag.position, before, 'Pointer drag must change geometry')
    assert.equal(drag.selected, kinds.reduce((n, k) => n + doc[k].length, 0), 'Drag must preserve the mixed selection')
    await page.keyboard.press('Control+z')
    assert.deepEqual(await page.evaluate(() => window.__aluframe.store.getState().profiles[0].position), before, 'One undo must restore the assembly')
    const cameraBefore = await page.evaluate(() => window.__aluframe.worldToClient(0, 0, 0))
    await page.mouse.move(900, 430)
    const navigationStart = performance.now()
    await page.mouse.wheel(0, -300)
    await page.mouse.down({ button: 'middle' })
    await page.mouse.move(990, 470, { steps: 20 })
    await page.mouse.up({ button: 'middle' })
    await page.waitForTimeout(300)
    assert.notDeepEqual(await page.evaluate(() => window.__aluframe.worldToClient(0, 0, 0)), cameraBefore, 'Wheel and orbit must change the view')
    const intervals = drag.frames.slice(1).map((t, i) => t - drag.frames[i]).filter(t => t > .5)
    results.push({ copies, counts: Object.fromEntries(kinds.map(k => [k, doc[k].length])), renderer, resources,
      pick: statistics(pickSamples), dragInputRoundTrip: statistics(inputSamples), frameIntervals: statistics(intervals),
      dragElapsedMs: drag.elapsedMs, navigationElapsedMs: performance.now() - navigationStart })
    console.log(JSON.stringify(results.at(-1)))
    await page.close()
  }
  if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(results, null, 2))
} finally { await browser.close() }
