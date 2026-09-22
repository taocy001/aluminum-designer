import { test, expect, type Page } from '@playwright/test'
import { openApp, enterDraw, setView, store, tool, w2c, type V3 } from './helpers'

// deterministic jitter so runs are reproducible
let seed = 7
const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280 }
const jitter = (px = 3) => (rnd() * 2 - 1) * px

async function clickNear(page: Page, p: V3, px = 3) {
  const c = await w2c(page, p)
  await page.mouse.move(c.x + jitter(px), c.y + jitter(px)); await page.waitForTimeout(30)
  await page.mouse.click(c.x + jitter(px), c.y + jitter(px)); await page.waitForTimeout(30)
}
async function hoverNear(page: Page, p: V3, px = 3) {
  const c = await w2c(page, p)
  await page.mouse.move(c.x + jitter(px), c.y + jitter(px)); await page.waitForTimeout(40)
}
/** sloppy member: click near `from` (may be on a body surface), pull toward `to`, click near it */
async function sloppy(page: Page, from: V3, to: V3) {
  const n = (await store(page)).profiles.length
  await clickNear(page, from); await hoverNear(page, to)
  const t = await tool(page)
  await clickNear(page, to)
  const added = (await store(page)).profiles.length - n
  if (added !== 1) console.log('SLOPPY FAILED', JSON.stringify({ from, to, start: t.start, cur: t.cur, axis: t.drawAxis, toasts: (await tool(page)).toasts, members: (await store(page)).profiles.map((p) => [p.spec, p.length, p.position.map(Math.round), p.quaternion.map((v: number) => +v.toFixed(2))]) }))
  return added
}
async function dumpJoints(page: Page) {
  return page.evaluate(() => {
    const w = (window as any).__aluframe; const tr = w.trims()
    return w.store.getState().profiles.map((p: any) => ({ id: p.id, spec: p.spec, len: p.length, pos: p.position.map(Math.round), cut: tr[p.id].cutLength, s: tr[p.id].start, e: tr[p.id].end }))
  })
}
async function bom(page: Page) {
  return {
    count: await page.getByTestId('bom-count').textContent(),
    brackets: await page.getByTestId('bom-brackets').textContent(),
    overall: await page.getByTestId('bom-overall').textContent(),
    pen: await page.getByTestId('bom-penetrations').textContent(),
    table: (await page.getByTestId('bom-table').textContent())!.replace(/\s+/g, ' '),
  }
}

test.describe('Hand-built cabinets with imprecise clicks', () => {
  test.beforeEach(async ({ page }) => {
    seed = 7 // same jitter sequence for every test regardless of run order
    await openApp(page)
    // These cabinets are described with the posts running past the rails, which decides
    // every trim and every butt end in them. The default is the other way round now.
    await page.getByTestId('through-posts').click()
    await setView(page, [1900, 1500, 2300], [300, 400, 200])
  })

  test('start points attach to member faces: side face → centerline, top face → end', async ({ page }) => {
    await enterDraw(page, '2020')
    await sloppy(page, [0, 0, 0], [0, 800, 0])
    const post = (await store(page)).profiles[0]
    const [px, , pz] = post.position.map(Math.round)
    expect(post.length).toBeGreaterThanOrEqual(790)
    // hover ON the +X side face of the post at mid height (10 mm off the centerline, on the surface)
    await hoverNear(page, [px + 10, 400, pz], 0)
    let t = await tool(page)
    expect(t.snap).toBe(true)
    expect(t.cur![0]).toBe(px); expect(Math.abs(t.cur![1] - 400)).toBeLessThanOrEqual(10); expect(t.cur![2]).toBe(pz)
    // the visible top face → the centerline top end
    await hoverNear(page, [px + 4, post.length, pz - 3], 0)
    t = await tool(page)
    expect(t.cur).toEqual([px, Math.round(post.length), pz])
    // bottom end zone of the side face → the bottom endpoint
    await hoverNear(page, [px + 10, 12, pz], 0)
    t = await tool(page)
    expect(t.cur).toEqual([px, 0, pz])
    // while drawing toward another member's centerline the HUD names the attachment
    // a second post in front-right (not occluding the first one from this camera)
    expect(await sloppy(page, [px + 400, 0, pz - 300], [px + 400, 500, pz - 300])).toBe(1)
    const post2 = (await store(page)).profiles[1]
    const [qx] = post2.position.map(Math.round)
    await clickNear(page, [px + 10, 300, pz], 0)
    await hoverNear(page, [qx - 10, 300, pz + 30], 0)
    t = await tool(page)
    expect(t.cur![0]).toBe(qx); expect(t.cur![2]).toBe(pz); expect(Math.abs(t.cur![1] - 300)).toBeLessThanOrEqual(5) // end aligned with the second post's X although it stands at another Z
    await expect(page.getByTestId('snap-kind')).toHaveText('对齐')
    await page.keyboard.press('Escape')
    // and a genuine crossing: from the first post toward the second post's centerline at the same Z
    await sloppy(page, [px + 400, 0, pz], [px + 400, 500, pz])
    await clickNear(page, [px + 10, 300, pz], 0)
    await hoverNear(page, [px + 380, 300, pz], 0)
    await expect(page.getByTestId('snap-kind')).toHaveText('中线 T 接')
    const cur = (await tool(page)).cur!
    expect(cur[0]).toBe(px + 400); expect(cur[2]).toBe(pz); expect(Math.abs(cur[1] - 300)).toBeLessThanOrEqual(5)
    await page.keyboard.press('Escape')
  })

  test('cabinet A: posts first, rails clicked on post bodies (600×400×800, 2020)', async ({ page }) => {
    const W = 600, D = 400, H = 800
    await enterDraw(page, '2020')
    // four posts from sloppy floor clicks; heights align to the first post via the alignment snap
    expect(await sloppy(page, [0, 0, 0], [0, H, 0])).toBe(1)
    for (const [x, z] of [[W, 0], [0, D], [W, D]]) expect(await sloppy(page, [x, 0, z], [x, H - 7, z])).toBe(1)
    const posts = (await store(page)).profiles
    for (const p of posts) expect(p.length).toBe(posts[0].length)
    const h = posts[0].length
    const xs = new Set(posts.map((p) => Math.round(p.position[0]))), zs = new Set(posts.map((p) => Math.round(p.position[2])))
    expect(xs.size).toBe(2); expect(zs.size).toBe(2)  // floor alignment made a proper rectangle
    const [ax0, ax1] = [...xs].sort((a, b) => a - b); const [az0, az1] = [...zs].sort((a, b) => a - b)
    // bottom rails: click on the post bodies near the floor (on the surface, not the centerline)
    expect(await sloppy(page, [ax0 + 10, 30, az0], [ax1 - 10, 30, az0])).toBe(1)
    expect(await sloppy(page, [ax0 + 10, 30, az1], [ax1 - 10, 30, az1])).toBe(1)
    expect(await sloppy(page, [ax0, 30, az0 + 10], [ax0, 30, az1 - 10])).toBe(1)
    expect(await sloppy(page, [ax1, 30, az0 + 10], [ax1, 30, az1 - 10])).toBe(1)
    // top rails: click on the post top faces
    expect(await sloppy(page, [ax0 + 3, h, az0 + 2], [ax1 - 3, h, az0 + 2])).toBe(1)
    expect(await sloppy(page, [ax0 + 3, h, az1 - 2], [ax1 - 3, h, az1 - 2])).toBe(1)
    expect(await sloppy(page, [ax0 + 2, h, az0 + 3], [ax0 + 2, h, az1 - 3])).toBe(1)
    expect(await sloppy(page, [ax1 - 2, h, az0 + 3], [ax1 - 2, h, az1 - 3])).toBe(1)
    const b = await bom(page)
    if (b.brackets !== '16') console.log('JOINTS A', JSON.stringify(await dumpJoints(page)))
    expect(b.count).toBe('12')
    expect(b.pen).toBe('无干涉')
    expect(b.brackets).toBe('0/16')   // none fitted yet, sixteen joints want one
    expect(b.table).toContain(`${h + 10} mm×4`)
    expect(b.table).toContain(`${ax1 - ax0 - 20} mm×4`)
    expect(b.table).toContain(`${az1 - az0 - 20} mm×4`)
    expect(b.overall).toBe(`${ax1 - ax0 + 20}×${az1 - az0 + 20}×${h + 10}`)
    await page.screenshot({ path: 'test-results/cabinet-A.png' })
  })

  test('cabinet B: floor rectangle first, posts from the rail corners, top rails between post tops', async ({ page }) => {
    const W = 600, D = 400, H = 800
    await enterDraw(page, '2020')
    expect(await sloppy(page, [0, 0, 0], [W, 10, 0])).toBe(1)
    const r1 = (await store(page)).profiles[0]
    const [x0, , z0] = r1.position.map(Math.round); const x1 = x0 + Math.round(r1.length)
    expect(await sloppy(page, [x1, 10, z0], [x1, 10, z0 + D])).toBe(1)     // start on the rail end
    const r2 = (await store(page)).profiles[1]; const z1 = z0 + Math.round(r2.length)
    expect(await sloppy(page, [x1, 10, z1], [x0, 10, z1])).toBe(1)          // end snaps to the far corner's X coordinate (alignment)
    expect(await sloppy(page, [x0, 10, z1], [x0, 10, z0])).toBe(1)          // closes on rail 1's start (endpoint snap)
    const corners: V3[] = [[x0, 10, z0], [x1, 10, z0], [x0, 10, z1], [x1, 10, z1]]
    // posts up from the four rail corners (corner joints: posts extend down to the rail bottom face)
    for (const [x, , z] of corners) expect(await sloppy(page, [x, 10, z], [x, 10 + H, z])).toBe(1)
    const posts = (await store(page)).profiles.slice(4)
    const h = posts[0].length
    for (const p of posts) expect(p.length).toBe(h)
    const top = 10 + h
    expect(await sloppy(page, [x0, top, z0], [x1, top, z0])).toBe(1)
    expect(await sloppy(page, [x1, top, z0], [x1, top, z1])).toBe(1)
    expect(await sloppy(page, [x1, top, z1], [x0, top, z1])).toBe(1)
    expect(await sloppy(page, [x0, top, z1], [x0, top, z0])).toBe(1)
    const b = await bom(page)
    if (b.brackets !== '16') console.log('JOINTS B', JSON.stringify(await dumpJoints(page)))
    expect(b.count).toBe('12')
    expect(b.pen).toBe('无干涉')
    expect(b.brackets).toBe('0/16')   // none fitted yet, sixteen joints want one
    expect(b.table).toContain(`${h + 20} mm×4`)  // posts extended to both rail faces
    expect(b.table).toContain(`${x1 - x0 - 20} mm×4`)
    expect(b.table).toContain(`${z1 - z0 - 20} mm×4`)
    await page.screenshot({ path: 'test-results/cabinet-B.png' })
  })

  test('cabinet C: 2040 posts with 2020 rails and two shelves — trims follow the partner section', async ({ page }) => {
    const W = 600, D = 400, H = 800
    await enterDraw(page, '2040')
    for (const [x, z] of [[0, 0], [W, 0], [0, D], [W, D]]) expect(await sloppy(page, [x, 0, z], [x, H, z])).toBe(1)
    const posts = (await store(page)).profiles
    const h = posts[0].length
    const [ax, , az] = posts[0].position.map(Math.round); const [bx, , bz] = posts[1].position.map(Math.round)
    const [cx, , cz] = posts[2].position.map(Math.round); const [dx, , dz] = posts[3].position.map(Math.round)
    await enterDraw(page, '2020')
    for (const y of [30, 400, h]) {
      expect(await sloppy(page, [ax + 10, y, az], [bx - 10, y, bz])).toBe(1)   // clicks on the post faces
      expect(await sloppy(page, [cx + 10, y, cz], [dx - 10, y, dz])).toBe(1)
      expect(await sloppy(page, [ax, y, az + 20], [cx, y, cz - 20])).toBe(1)
      expect(await sloppy(page, [bx, y, bz + 20], [dx, y, dz - 20])).toBe(1)
    }
    // a shelf rail between the two side rails at y=400 (T-joints on both)
    expect(await sloppy(page, [ax, 400, (az + cz) / 2], [bx, 400, (az + cz) / 2])).toBe(1)
    const b = await bom(page)
    console.log('JOINTS C', JSON.stringify(await dumpJoints(page)))
    expect(b.count).toBe('17')
    expect(b.pen).toBe('无干涉')
    expect(b.brackets).toBe('0/26')
    // 2040 upright along Y is 20 mm across X and 40 mm across Z → X rails lose 10 per end, Z rails lose 20 per end
    const cuts = (await dumpJoints(page)).map((j: any) => j.cut)
    expect(cuts.filter((c: number) => Math.abs(c - (bx - ax - 20)) < 0.01)).toHaveLength(7)   // 6 X rails + shelf rail (between 2020 side rails: −10 each end → same as bx-ax-20)
    expect(cuts.filter((c: number) => Math.abs(c - (cz - az - 40)) < 0.01)).toHaveLength(6)
    await page.screenshot({ path: 'test-results/cabinet-C.png' })
  })
})
