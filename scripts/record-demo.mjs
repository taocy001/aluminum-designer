/**
 * Records the demo GIF for the README: building a small cabinet by hand, with the
 * hesitations and corrections a person has — jittered clicks, a misdrawn rail that
 * gets undone, a drag that gets reconsidered.
 *
 * Run:  node scripts/record-demo.mjs
 * Out:  test-results/demo-recording/*.webm  →  docs/demo.gif (via ffmpeg, see end)
 *
 * Headless video has no OS cursor, so a red dot follows every pointer move; the dot
 * grows while a button is held. Speed-up and GIF conversion happen in the ffmpeg step.
 */
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'

const PORT = 5174
const BASE = `http://127.0.0.1:${PORT}`
const OUT = 'test-results/demo-recording'

// deterministic jitter, same run every time
let seed = 11
const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280 }
const jitter = (px = 2) => (rnd() * 2 - 1) * px
const think = (ms) => page.waitForTimeout(ms * (0.7 + rnd() * 0.8))

let page
let cur = { x: -100, y: -100 }

async function startServer() {
  try { if ((await fetch(BASE)).ok) return null } catch { /* not running */ }
  const p = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' })
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(BASE)).ok) return p } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('dev server did not come up')
}

async function cursorTo(x, y, steps = 16) {
  const from = { ...cur }
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t * t * (3 - 2 * t)
    cur = { x: from.x + (x - from.x) * e + jitter(1), y: from.y + (y - from.y) * e + jitter(1) }
    await page.mouse.move(cur.x, cur.y)
    await page.evaluate(([cx, cy]) => window.__demoCursor?.(cx, cy), [cur.x, cur.y])
    await page.waitForTimeout(14)
  }
}

async function press() { await page.evaluate(([x, y]) => window.__demoCursor?.(x, y, true), [cur.x, cur.y]) }
async function release() { await page.evaluate(([x, y]) => window.__demoCursor?.(x, y, false), [cur.x, cur.y]) }

async function clickAt(x, y, opts = {}) {
  await cursorTo(x + jitter(), y + jitter())
  await think(180)
  if (opts.ctrl) await page.keyboard.down('Control')
  await press(); await page.mouse.down(); await think(90); await page.mouse.up(); await release()
  if (opts.ctrl) await page.keyboard.up('Control')
  await settle()
}

const w2c = (p) => page.evaluate(([x, y, z]) => window.__aluframe.worldToClient(x, y, z), p)
const clickWorld = async (p, opts) => { const c = await w2c(p); await clickAt(c.x, c.y, opts) }
const hoverWorld = async (p) => { const c = await w2c(p); await cursorTo(c.x + jitter(), c.y + jitter()) }

const store = () => page.evaluate(() => window.__aluframe.store.getState())
const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))

async function clickTestId(id, opts = {}) {
  const loc = page.locator(`[data-testid="${id}"]`).first()
  await loc.scrollIntoViewIfNeeded()
  const box = await loc.boundingBox()
  await clickAt(box.x + box.width / 2, box.y + box.height / 2, opts)
}

/** click start, hover end, click end — the member may snap, that's the point.
 *  If `expectLen` is given and the result is way off, undo and try once more. */
async function draw(from, to, expectLen) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const n = (await store()).profiles.length
    await clickWorld(from)
    await page.waitForFunction(() => window.__aluframe.tool.getState().isDrawing, null, { timeout: 5000 })
    await hoverWorld(to); await think(350)
    await clickWorld(to)
    await page.waitForFunction((k) => window.__aluframe.store.getState().profiles.length > k, n, { timeout: 5000 })
    const last = (await store()).profiles.at(-1)
    console.log('drawn:', JSON.stringify({ from, to, got: { len: Math.round(last.length), pos: last.position.map(Math.round) } }))
    if (!expectLen || Math.abs(last.length - expectLen) < 40) return
    console.log('  way off, undoing and retrying')
    await undo()
  }
  throw new Error(`draw failed twice: ${JSON.stringify({ from, to })}`)
}

/** a patch of empty sky to grab for an orbit */
async function emptyPoint() {
  for (const [fx, fy] of [[0.62, 0.14], [0.3, 0.12], [0.8, 0.2], [0.15, 0.3]]) {
    const x = 1400 * fx, y = 900 * fy
    await cursorTo(x, y, 8); await settle()
    const hovering = await page.evaluate(() => {
      const t = window.__aluframe.tool.getState()
      return t.hoverProfileId || t.hoverPartId
    })
    if (!hovering) return { x, y }
  }
  return { x: 900, y: 130 }
}

async function orbit(dx, dy = 40) {
  const p = await emptyPoint()
  await press(); await page.mouse.down()
  await cursorTo(p.x + dx, p.y + dy, 22)
  await page.mouse.up(); await release()
  await think(300)
}

async function undo() { await page.keyboard.press('Control+z'); await settle(); await think(300) }

/** Escape peels one layer at a time (menu, drawing, held part); press until empty-handed */
async function putDown() {
  for (let i = 0; i < 4; i++) {
    const held = await page.evaluate(() => window.__aluframe.tool.getState().held)
    if (!held) return
    await page.keyboard.press('Escape'); await settle()
  }
  console.log('WARN still holding after Escapes')
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const server = await startServer()
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  })
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    recordVideo: { dir: OUT, size: { width: 1400, height: 900 } },
  })
  page = await context.newPage()

  await page.goto(BASE)
  await page.evaluate(() => localStorage.clear())
  await page.goto(BASE)
  await page.waitForFunction(() => window.__aluframe?.setView, null, { timeout: 20_000 })
  await page.evaluate(() => {
    const c = document.createElement('div')
    c.style.cssText = 'position:fixed;left:-100px;top:-100px;width:16px;height:16px;border-radius:50%;'
      + 'background:rgba(255,90,40,.9);border:2px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.55);'
      + 'z-index:99999;pointer-events:none;transition:transform .08s'
    document.body.appendChild(c)
    window.__demoCursor = (x, y, down) => {
      c.style.left = `${x - 8}px`; c.style.top = `${y - 8}px`
      c.style.transform = down ? 'scale(1.6)' : 'scale(1)'
    }
  })
  await page.evaluate(() => window.__aluframe.setView([1650, 1250, 2050], [300, 430, 250]))
  await settle()

  try {
  // —— 四根立柱：第一根随手画，后三根敲数字定成一样高（画完之前不转视角）——
  await clickTestId('spec-2020')
  await think(600)
  await draw([0, 0, 0], [0, 895, 0])
  const h = Math.round((await store()).profiles[0].length)
  for (const [x, z] of [[600, 0], [0, 500], [600, 500]]) {
    const n = (await store()).profiles.length
    await clickWorld([x, 0, z])
    await page.waitForFunction(() => window.__aluframe.tool.getState().isDrawing, null, { timeout: 5000 })
    await hoverWorld([x, h + 10, z]); await think(250)
    await page.keyboard.type(String(h), { delay: 110 })
    await page.keyboard.press('Enter')
    await page.waitForFunction((k) => window.__aluframe.store.getState().profiles.length > k, n, { timeout: 5000 })
    const last = (await store()).profiles.at(-1)
    console.log('typed post:', JSON.stringify({ len: Math.round(last.length), pos: last.position.map(Math.round) }))
    await think(300)
  }

  const posts = (await store()).profiles.slice(0, 4)
  const xs = [...new Set(posts.map((p) => Math.round(p.position[0])))].sort((a, b) => a - b)
  const zs = [...new Set(posts.map((p) => Math.round(p.position[2])))].sort((a, b) => a - b)
  const [x0, x1] = xs, [z0, z1] = zs
  console.log('posts settled:', JSON.stringify({ h, xs, zs }))

  // —— 底圈横梁（点在立柱身上）——
  await draw([x0 + 10, 30, z0], [x1 - 10, 30, z0], x1 - x0)
  await think(400)
  await draw([x0 + 10, 30, z1], [x1 - 10, 30, z1], x1 - x0)
  // 画错一根：高度错了，撤销重来
  await draw([x0 + 10, 450, z0], [x1 - 10, 450, z0])
  await think(700)
  await undo()
  console.log('after undo, profiles:', (await store()).profiles.length)
  await draw([x0, 30, z0 + 10], [x0, 30, z1 - 10], z1 - z0)
  await draw([x1, 30, z0 + 10], [x1, 30, z1 - 10], z1 - z0)

  // —— 顶圈：点在立柱顶面；最后一根敲数字定长 ——
  await draw([x0 + 3, h, z0 + 2], [x1 - 3, h, z0 + 2], x1 - x0)
  await think(300)
  await draw([x0 + 3, h, z1 - 2], [x1 - 3, h, z1 - 2], x1 - x0)
  {
    const n = (await store()).profiles.length
    await clickWorld([x0 + 2, h, z0 + 3])
    await page.waitForFunction(() => window.__aluframe.tool.getState().isDrawing, null, { timeout: 5000 })
    await hoverWorld([x0 + 2, h, z1 - 3]); await think(300)
    await page.keyboard.type(String(z1 - z0), { delay: 110 })
    await think(300)
    await page.keyboard.press('Enter')
    await page.waitForFunction((k) => window.__aluframe.store.getState().profiles.length > k, n, { timeout: 5000 })
    const last = (await store()).profiles.at(-1)
    console.log('typed rail:', JSON.stringify({ len: Math.round(last.length), pos: last.position.map(Math.round) }))
  }
  await draw([x1 - 2, h, z0 + 3], [x1 - 2, h, z1 - 3], z1 - z0)

  // —— 画完了，转一圈看看 ——
  await putDown()
  await think(400)
  await orbit(-260, 40)
  await think(500)
  await orbit(200, -30)

  // —— 拖动调整一根底梁，想想还是算了 ——
  {
    const rail = (await store()).profiles[5]   // z1 侧底梁
    const mid = [(x0 + x1) / 2, Math.round(rail.position[1]), z1]
    const a = await w2c(mid)
    const b = await w2c([mid[0], mid[1] + 170, mid[2]])
    await cursorTo(a.x, a.y); await think(250)
    await press(); await page.mouse.down()
    await cursorTo(b.x, b.y, 20)
    await think(500)
    await page.mouse.up(); await release()
    await settle(); await think(600)
    await undo()
  }

  // —— 内角码：一键连接所有接头 ——
  await clickTestId('connector-inside-corner')
  await think(500)
  await clickTestId('auto-connect')
  await think(900)
  await putDown()

  // —— 柜门：选中两根前立柱 ——
  await think(300)
  await clickWorld([x0, 450, z1])
  await think(300)
  await clickWorld([x1, 450, z1], { ctrl: true })
  await think(500)
  console.log('selected:', JSON.stringify((await store()).selectedIds))
  await clickTestId('hinge-right')
  await think(300)
  await clickTestId('add-door')
  await think(800)
  console.log('fittings:', (await store()).fittings.length,
    'toasts:', JSON.stringify(await page.evaluate(() => window.__aluframe.tool.getState().toasts.map((t) => t.message))))

  // —— 查看模式开门看看（点开没反应就再点一次，跟人一样）——
  const toggleDoor = async (target) => {
    for (let i = 0; i < 3; i++) {
      if ((((await store()).fittings[0].open) ?? 0) === target) return
      const pt = await page.evaluate(() => {
        const w = window.__aluframe
        const f0 = w.store.getState().fittings[0]
        const o = w.leafObb(f0, f0.open)
        return o ? o.center.toArray() : f0.position
      })
      await clickWorld(pt)
      await think(700)
    }
  }
  await clickTestId('mode-toggle')
  await think(500)
  await toggleDoor(1)
  await think(1400)
  await toggleDoor(0)
  await think(400)
  await clickTestId('mode-toggle')

  // —— 清单与收尾 ——
  await page.evaluate(() => document.querySelector('[data-testid="bom-table"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
  await think(1200)
  await orbit(-160, 25)
  await page.keyboard.press('f')
  await think(2000)

  } finally {
    const videoPath = await page.video().path()
    await context.close()
    await browser.close()
    server?.kill()
    console.log('video:', videoPath)
  }
  console.log('next: ffmpeg -i <video>.webm -vf "setpts=PTS/6,fps=12,scale=900:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4" docs/demo.gif')
}

main().catch((e) => { console.error(e); process.exit(1) })
