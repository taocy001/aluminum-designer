import { expect, type Page } from '@playwright/test'

export type V3 = [number, number, number]

export async function openApp(page: Page) {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__aluframe?.setView, null, { timeout: 20_000 })
  await setView(page, [1300, 1000, 1600], [300, 300, 200])
}

export async function setView(page: Page, pos: V3, target: V3 = [0, 0, 0]) {
  await page.evaluate(([p, t]) => (window as any).__aluframe.setView(p, t), [pos, target])
  await page.waitForTimeout(80)
}

export async function w2c(page: Page, p: V3): Promise<{ x: number; y: number }> {
  return page.evaluate(([x, y, z]) => (window as any).__aluframe.worldToClient(x, y, z), p)
}

export async function store(page: Page) {
  return page.evaluate(() => {
    const s = (window as any).__aluframe.store.getState()
    return {
      profiles: s.profiles as any[],
      connectors: s.connectors as any[],
      panels: s.panels as any[],
      fittings: s.fittings as any[],
      selectedIds: s.selectedIds as string[],
      past: s.past.length as number,
      future: s.future.length as number,
    }
  })
}

export async function conflicts(page: Page): Promise<{ conflicts: Array<{ a: string; b: string; depth: number }>; ids: string[] }> {
  return page.evaluate(() => (window as any).__aluframe.conflicts())
}

export async function cursor(page: Page): Promise<string> {
  return page.getByTestId('viewport').evaluate((el) => getComputedStyle(el as HTMLElement).cursor)
}

export async function hoverId(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as any).__aluframe.tool.getState().hoverProfileId)
}

/** Press, move in steps, hold — the caller releases. Useful to inspect mid-drag state. */
export async function dragHold(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 6) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps)
    await page.waitForTimeout(15)
  }
}

export async function tool(page: Page) {
  return page.evaluate(() => {
    const t = (window as any).__aluframe.tool.getState()
    return {
      held: (t.held ?? null) as string | null, hoverEnd: (t.hoverEnd ?? null) as string | null, isDrawing: t.isDrawing as boolean, drawAxis: t.drawAxis as string | null,
      selectMode: t.selectMode as boolean, isDragging: t.isDragging as boolean,
      start: t.startPoint ? (t.startPoint.toArray() as number[]).map((v: number) => Math.round(v) || 0) : null,
      cur: t.currentPoint ? (t.currentPoint.toArray() as number[]).map((v: number) => Math.round(v) || 0) : null,
      toasts: t.toasts.map((x: any) => x.message) as string[],
      snap: !!t.snapPoint,
    }
  })
}

export async function enterDraw(page: Page, spec = '2020') {
  await page.getByTestId(`spec-${spec}`).click()
  expect((await tool(page)).held).not.toBe(null)
}

/**
 * Wait for the scene to have drawn, rather than for a number of milliseconds.
 *
 * Hover state is computed in a pointer handler and consumed on the next render, so a fixed
 * sleep is a bet on how loaded the machine is. Two frames is the same wait every time.
 */
export async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
}

export async function clickWorld(page: Page, p: V3, opts: { button?: 'left' | 'right'; modifiers?: ('Control' | 'Shift' | 'Meta')[] } = {}) {
  const c = await w2c(page, p)
  await page.mouse.move(c.x, c.y)
  await settle(page)
  for (const m of opts.modifiers ?? []) await page.keyboard.down(m)
  await page.mouse.click(c.x, c.y, { button: opts.button ?? 'left' })
  for (const m of opts.modifiers ?? []) await page.keyboard.up(m)
  await settle(page)
}

export async function hoverWorld(page: Page, p: V3) {
  const c = await w2c(page, p)
  await page.mouse.move(c.x, c.y)
  await settle(page)
}

/** Draw a member by clicking its start and end in the scene (draw mode must be active) */
export async function drawMember(page: Page, from: V3, to: V3) {
  const before = (await store(page)).profiles.length
  await clickWorld(page, from)
  // the first click has to have opened a line before the second one can close it
  await page.waitForFunction(() => (window as any).__aluframe.tool.getState().isDrawing, null, { timeout: 5000 }).catch(() => {})
  await hoverWorld(page, to)
  await clickWorld(page, to)
  await page.waitForFunction(
    (n) => (window as any).__aluframe.store.getState().profiles.length > n
      || !(window as any).__aluframe.tool.getState().isDrawing,
    before, { timeout: 5000 },
  ).catch(() => {})
  return (await store(page)).profiles.length - before
}

/** Draw a member using the exact-length input: click start, pull toward `toward`, type length, Enter */
export async function drawExact(page: Page, from: V3, toward: V3, length: number) {
  const before = (await store(page)).profiles.length
  await clickWorld(page, from)
  await hoverWorld(page, toward)
  await page.keyboard.type(String(length))
  await expect(page.getByTestId('precise-input')).toHaveValue(String(length))
  await page.keyboard.press('Enter')
  await page.waitForTimeout(30)
  return (await store(page)).profiles.length - before
}

export async function dragWorld(page: Page, from: V3, to: V3, modifiers: ('Shift' | 'Control' | 'Alt')[] = []) {
  const a = await w2c(page, from)
  const b = await w2c(page, to)
  for (const m of modifiers) await page.keyboard.down(m)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  const steps = 8
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps)
    await page.waitForTimeout(15)
  }
  await page.mouse.up()
  for (const m of modifiers) await page.keyboard.up(m)
  await page.waitForTimeout(40)
}

export function endpoints(p: any): { start: V3; end: V3 } {
  const [x, y, z, w] = p.quaternion
  // rotate (0,0,1) by quaternion
  const dx = 2 * (x * z + w * y)
  const dy = 2 * (y * z - w * x)
  const dz = 1 - 2 * (x * x + y * y)
  const s = p.position as V3
  return { start: s, end: [s[0] + dx * p.length, s[1] + dy * p.length, s[2] + dz * p.length] }
}

export const r = (v: number) => Math.round(v) || 0


/**
 * Make the project save fall back to a download.
 *
 * A native save dialog cannot be driven from a test — nothing can press "Save" in it. What
 * these tests are about is whether a saved document comes back the same, which is the
 * serialisation, not the dialog; so the dialog is taken away and the download path runs.
 * That the dialog is preferred when it exists is checked on its own, by watching for the call.
 */
export async function useDownloadFallback(page: Page) {
  await page.addInitScript(() => {
    delete (window as unknown as Record<string, unknown>).showSaveFilePicker
    delete (window as unknown as Record<string, unknown>).showOpenFilePicker
  })
}
