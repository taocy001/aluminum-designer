/** Production interaction benchmark. Build with VITE_TEST_HOOK=1; pass URL and optional JSON output path. */
import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const browser = await chromium.launch({ args: process.env.BENCH_GL_BACKEND
  ? ['--use-gl=angle', `--use-angle=${process.env.BENCH_GL_BACKEND}`, '--ignore-gpu-blocklist'] : [] })
const results = []
try {
  for (const count of [150, 500]) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.goto(process.argv[2] ?? 'http://127.0.0.1:4176')
    await page.waitForFunction(() => window.__aluframe?.setView)
    const fixture = await page.evaluate(count => {
      const api = window.__aluframe, cols = 15, rows = Math.ceil(count / cols)
      const profiles = Array.from({ length: count }, (_, i) => ({ id: `bench-${i}`, spec: '2020', length: 180,
        position: [(i % cols) * 240, Math.floor(i / cols) * 100 + 100, 0],
        quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2], holes: [], miterCuts: [] }))
      api.store.getState().loadDocument({ profiles, connectors: [], panels: [], fittings: [], equipment: [], throughRule: 'rails' })
      api.store.setState({ selectedIds: profiles.map(p => p.id) })
      api.tool.getState().putDown()
      api.tool.setState({ showPartNumbers: false, showDimensionLabels: false })
      api.setView([1700, rows * 50 + 2100, 6500], [1700, rows * 50 + 100, 0])
      const gl = document.querySelector('canvas').getContext('webgl2'), ext = gl.getExtension('WEBGL_debug_renderer_info')
      return { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown', point: [1680 + 90, Math.floor(rows / 2) * 100 + 100, 10] }
    }, count)
    console.log('Loaded', count, fixture.renderer)
    await page.waitForTimeout(1000)
    const point = await page.evaluate(p => window.__aluframe.worldToClient(...p), fixture.point)
    const before = await page.evaluate(() => window.__aluframe.store.getState().profiles[0].position)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 1000 }); await cdp.send('Profiler.start')
    await page.mouse.move(point.x, point.y)
    await page.keyboard.down('Shift')
    console.log('Drag target', point, await page.evaluate(p => window.__aluframe.pickAt(p.x, p.y), point))
    await page.mouse.down()
    console.log('Pressed', count)
    await page.evaluate(() => {
      const api = window.__aluframe
      window.__bench = { frames: [], edits: 0, started: performance.now() }
      api.sceneRoot.onAfterRender = () => window.__bench.frames.push(performance.now())
      window.__bench.unsubscribe = api.store.subscribe((s, prev) => { if (s.profiles !== prev.profiles) window.__bench.edits++ })
    })
    const start = Date.now()
    for (let i = 1; i <= 30; i++) {
      await page.mouse.move(point.x + i * 3, point.y - i * .4)
      if (i % 10 === 0) console.log('Moved', count, i)
      await page.waitForTimeout(Math.max(1, start + i * 25 - Date.now()))
    }
    const samples = await page.evaluate(() => {
      const b = window.__bench
      b.unsubscribe(); window.__aluframe.sceneRoot.onAfterRender = () => {}
      return { frames: b.frames, edits: b.edits, elapsed: performance.now() - b.started,
        moved: window.__aluframe.store.getState().profiles[0].position }
    })
    await page.mouse.up(); await page.keyboard.up('Shift')
    const { profile } = await cdp.send('Profiler.stop')
    assert.notDeepEqual(samples.moved, before, 'The pointer must actually move the assembly')
    const frames = samples.frames.filter((t, i, a) => !i || t - a[i - 1] > .5)
    const intervals = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => a - b)
    const hits = new Map()
    for (const id of profile.samples ?? []) hits.set(id, (hits.get(id) ?? 0) + 1)
    const hotspots = profile.nodes.map(n => ({ function: n.callFrame.functionName || '(anonymous)',
      url: n.callFrame.url.replace(/.*\/assets\//, 'assets/'), samples: hits.get(n.id) ?? 0 }))
      .filter(n => n.samples).sort((a, b) => b.samples - a.samples).slice(0, 15)
    results.push({ count, fixture: 'separate 2020 beams, full selection drag', renderer: fixture.renderer,
      elapsedMs: Math.round(samples.elapsed), sceneRenders: frames.length, committedEdits: samples.edits,
      renderedFramesPerSecond: +(frames.length * 1000 / samples.elapsed).toFixed(1),
      medianIntervalMs: +intervals[Math.floor(intervals.length * .5)]?.toFixed(1),
      p95IntervalMs: +intervals[Math.floor(intervals.length * .95)]?.toFixed(1), hotspots })
    console.log(JSON.stringify(results.at(-1), null, 2))
    await page.close()
  }
  if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(results, null, 2))
} finally { await browser.close() }
