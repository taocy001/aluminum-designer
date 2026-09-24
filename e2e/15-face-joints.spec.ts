import { test, expect, type Page } from '@playwright/test'
import { openApp, setView, enterDraw, drawMember, clickWorld, store, tool } from './helpers'

/**
 * Frames are drawn on centrelines and assembled face to face. These pin down what the tool
 * does about the difference: line the faces up when the sections differ, say so when it
 * cannot, and put the brackets where they would really be bolted.
 */

async function emptyHand(page: Page) {
  await page.keyboard.press('Escape')
  if ((await tool(page)).held !== null) await page.keyboard.press('Escape')
  expect((await tool(page)).held).toBe(null)
}

const unflush = (page: Page) => page.evaluate(() => (window as any).__aluframe.unflush())
const profiles = async (page: Page) => (await store(page)).profiles

test.describe('A new member lines its faces up with what it lands on', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await setView(page, [1800, 1300, 2200], [400, 400, 200])
  })

  test('a 2040 rail landing on a 4040 post turns rather than steps aside', async ({ page }) => {
    await enterDraw(page, '4040')
    await drawMember(page, [0, 0, 0], [0, 800, 0])
    await enterDraw(page, '2040')
    await drawMember(page, [0, 0, 0], [800, 0, 0])
    await emptyHand(page)
    const all = await profiles(page)
    expect(all.length).toBe(2)
    // a 2040 has a 40 side to offer the post: turning it costs nothing and keeps the rail
    // on the line it was drawn on, where pushing it 10 mm aside would not have
    const rail = all.find((p: any) => p.spec === '2040')!
    expect(Math.round(rail.position[2])).toBe(0)
    expect(await unflush(page)).toBe(0)
    const facing = await page.evaluate(() => {
      const p = (window as any).__aluframe.store.getState().profiles.find((q: any) => q.spec === '2040')
      const [x, y, z, w] = p.quaternion
      // the section's local Y is its 40 side; where does it point?
      return [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)].map((v) => Math.round(v))
    })
    expect(Math.abs(facing[2])).toBe(1)   // the 40 side faces the post, along Z
  })

  test('two members of the same section are left where they were put', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [0, 800, 0])
    await drawMember(page, [0, 0, 0], [800, 0, 0])
    await emptyHand(page)
    const rail = (await profiles(page))[1]
    expect(Math.round(rail.position[2])).toBe(0)
    expect(await unflush(page)).toBe(0)
  })

  test('a 2020 on a 4040 cannot be made to work, and is reported', async ({ page }) => {
    await enterDraw(page, '4040')
    await drawMember(page, [0, 0, 0], [0, 800, 0])
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [800, 0, 0])
    await emptyHand(page)
    // 20 against 40 leaves a 10 mm step whichever way it is pushed
    expect(await unflush(page)).toBeGreaterThan(0)
    await expect(page.getByTestId('bom-mismatches')).toContainText('贴不平')
  })

  test('the first member sets the plane; nothing already placed is moved', async ({ page }) => {
    await enterDraw(page, '4040')
    await drawMember(page, [0, 0, 0], [0, 800, 0])
    const before = (await profiles(page))[0].position.map((v: number) => Math.round(v))
    await enterDraw(page, '2040')
    await drawMember(page, [0, 0, 0], [800, 0, 0])
    await emptyHand(page)
    expect((await profiles(page))[0].position.map((v: number) => Math.round(v))).toEqual(before)
  })
})

test.describe('Which way a rectangular section is turned', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await setView(page, [1600, 1200, 2000], [300, 300, 0])
    await enterDraw(page, '2040')
    await drawMember(page, [0, 0, 0], [800, 0, 0])
    await emptyHand(page)
    await clickWorld(page, [400, 20, 0])
    expect((await store(page)).selectedIds.length).toBe(1)
  })

  test('the panel says which way the long side faces', async ({ page }) => {
    await expect(page.getByTestId('section-roll')).toBeVisible()
    await expect(page.getByTestId('section-roll')).toContainText('40')
  })

  test('turning it ninety degrees changes the facing and nothing else', async ({ page }) => {
    const before = (await profiles(page))[0]
    const facingBefore = await page.getByTestId('section-roll').innerText()
    await page.getByTestId('roll-section').click()
    await page.waitForTimeout(120)
    const after = (await profiles(page))[0]
    expect(await page.getByTestId('section-roll').innerText()).not.toBe(facingBefore)
    expect(Math.round(after.length)).toBe(Math.round(before.length))
    expect(after.position.map((v: number) => Math.round(v))).toEqual(before.position.map((v: number) => Math.round(v)))
  })

  test('a square section has nothing to turn, so the control is not offered', async ({ page }) => {
    await openApp(page)
    await setView(page, [1600, 1200, 2000], [300, 300, 0])
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [800, 0, 0])
    await emptyHand(page)
    await clickWorld(page, [400, 10, 0])
    await expect(page.getByTestId('section-roll')).toHaveCount(0)
  })

  test('the turn is one undo step', async ({ page }) => {
    const before = (await store(page)).past
    await page.getByTestId('roll-section').click()
    await page.waitForTimeout(100)
    expect((await store(page)).past).toBe(before + 1)
  })
})

test.describe('Brackets sit on the faces they would be bolted to', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await setView(page, [1800, 1300, 2200], [400, 400, 200])
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [0, 800, 0])
    await drawMember(page, [800, 0, 0], [800, 800, 0])
    await drawMember(page, [0, 0, 0], [800, 0, 0])
    await drawMember(page, [0, 800, 0], [800, 800, 0])
    await emptyHand(page)
    expect((await store(page)).profiles.length).toBe(4)
  })

  /** how far outside the nearest member's surface each bracket sits (negative = buried) */
  const bracketDepths = (page: Page) => page.evaluate(() => {
    const THREE = (window as any).THREE_TEST ?? null
    void THREE
    const s = (window as any).__aluframe.store.getState()
    const q4 = (q: number[]) => q
    const rot = (q: number[], v: number[]) => {
      const [x, y, z, w] = q4(q)
      const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])]
      return [
        v[0] + w * t[0] + (y * t[2] - z * t[1]),
        v[1] + w * t[1] + (z * t[0] - x * t[2]),
        v[2] + w * t[2] + (x * t[1] - y * t[0]),
      ]
    }
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    return s.connectors.map((c: any) => {
      let best = Infinity
      for (const p of s.profiles) {
        const dir = rot(p.quaternion, [0, 0, 1])
        const rel = [0, 1, 2].map((i) => c.position[i] - p.position[i])
        const t = Math.max(0, Math.min(p.length, dot(rel, dir)))
        const off = [0, 1, 2].map((i) => rel[i] - dir[i] * t)
        const lx = rot(p.quaternion, [1, 0, 0]), ly = rot(p.quaternion, [0, 1, 0])
        const w2 = Number(p.spec.slice(0, 2)) / 2, h2 = Number(p.spec.slice(2)) / 2
        best = Math.min(best, Math.max(Math.abs(dot(off, lx)) - w2, Math.abs(dot(off, ly)) - h2))
      }
      return Math.round(best * 10) / 10
    })
  })

  test('every auto-fitted bracket ends up on a surface, not inside the metal', async ({ page }) => {
    await page.getByTestId('connector-bracket').click()
    await page.getByTestId('auto-connect').click()
    await page.waitForTimeout(300)
    const depths = await bracketDepths(page)
    expect(depths.length).toBeGreaterThan(0)
    const buried = depths.filter((d: number) => d < -1).length
    expect(buried).toBe(0)
  })

  test('the brackets are still one per butting end', async ({ page }) => {
    await page.getByTestId('connector-bracket').click()
    await page.getByTestId('auto-connect').click()
    await page.waitForTimeout(300)
    const text = await page.getByTestId('bom-brackets').innerText()
    const [fitted, needed] = text.split('/').map((v) => Number(v.trim()))
    expect(fitted).toBe(needed)
  })
})

test.describe('Which member runs through a corner', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await setView(page, [1800, 1300, 2200], [400, 400, 0])
  })

  const cut = (page: Page, id: string) => page.evaluate((i) =>
    Math.round((window as any).__aluframe.trims()[i].cutLength), id)

  test('rails over posts is the default, and the post is the one cut', async ({ page }) => {
    await expect(page.getByTestId('through-rails')).toHaveClass(/bg-blue-600/)
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [0, 800, 0])      // post
    await drawMember(page, [0, 800, 0], [800, 800, 0])  // rail landing on its top
    await emptyHand(page)
    const all = await profiles(page)
    const post = all.find((p: any) => Math.round(p.length) === 800)!
    const rail = all.find((p: any) => p.id !== post.id)!
    expect(await cut(page, post.id)).toBeLessThan(800)   // cut back under the rail
    expect(await cut(page, rail.id)).toBeGreaterThanOrEqual(Math.round(rail.length))
  })

  test('switching to posts past rails swaps which one is cut', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [0, 800, 0])
    await drawMember(page, [0, 800, 0], [800, 800, 0])
    await emptyHand(page)
    const all = await profiles(page)
    const post = all.find((p: any) => Math.round(p.length) === 800)!
    const before = await cut(page, post.id)
    await page.getByTestId('through-posts').click()
    await page.waitForTimeout(150)
    expect(await cut(page, post.id)).toBeGreaterThan(before)
  })

  test('the choice survives being switched back', async ({ page }) => {
    await page.getByTestId('through-posts').click()
    await expect(page.getByTestId('through-posts')).toHaveClass(/bg-blue-600/)
    await page.getByTestId('through-rails').click()
    await expect(page.getByTestId('through-rails')).toHaveClass(/bg-blue-600/)
  })
})

test.describe('Zoom buttons', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 0, 0])
    await emptyHand(page)
  })

  const dist = (page: Page) => page.evaluate(() => {
    const c = (window as any).__aluframe.controls
    const cam = (window as any).__aluframe.camera
    return Math.round(cam.position.distanceTo(c ? c.target : { x: 0, y: 0, z: 0 }))
  })

  test('the plus button brings the camera closer and the minus takes it back', async ({ page }) => {
    const start = await dist(page)
    await page.getByTestId('zoom-in').click()
    await page.waitForTimeout(150)
    const closer = await dist(page)
    expect(closer).toBeLessThan(start)
    await page.getByTestId('zoom-out').click()
    await page.waitForTimeout(150)
    expect(await dist(page)).toBeGreaterThan(closer)
  })

  test('zooming leaves the drawing alone', async ({ page }) => {
    const before = (await profiles(page))[0]
    await page.getByTestId('zoom-in').click()
    await page.waitForTimeout(150)
    expect((await profiles(page))[0].position).toEqual(before.position)
  })
})

test.describe('Everything under the cursor lights up, not only members', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await setView(page, [1800, 1300, 2200], [400, 400, 200])
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [0, 800, 0])
    await drawMember(page, [0, 800, 0], [800, 800, 0])
    await emptyHand(page)
    await page.getByTestId('connector-bracket').click()
    await page.getByTestId('auto-connect').click()
    await page.waitForTimeout(300)
    await page.keyboard.press('Escape')
    expect((await store(page)).connectors.length).toBeGreaterThan(0)
  })

  test('hovering a bracket marks it, and a click then selects it', async ({ page }) => {
    const c = (await store(page)).connectors[0]
    // A bracket is twenty millimetres on a frame nearly a metre across and it sits inside
    // the corner, so from most angles the metal is in front of most of it. The promise is
    // not that any particular point works — it is that wherever the renderer draws the
    // bracket, that is what the cursor marks. So find such a pixel and ask there.
    const at = await page.evaluate((id) => (window as any).__aluframe.connectorOBB(id), c.id)
    const seed = await page.evaluate((pos) => (window as any).__aluframe.worldToClient(...pos), at)
    // ...and stand where the inside of the corner faces you, or there is nothing to hover:
    // the flanges are against the metal and the metal is between you and them
    await setView(page, [at[0] + 320, at[1] + 240, at[2] + 320], at as [number, number, number])
    await page.waitForTimeout(200)
    const px = await page.evaluate((id) => {
      const w = (window as any).__aluframe
      for (let y = 40; y < 860; y += 4) {
        for (let x = 340; x < 1380; x += 4) if (w.frontmostAt(x, y)?.id === id) return { x, y }
      }
      return null
    }, c.id)
    void seed
    expect(px, 'the bracket is drawn somewhere on the screen').not.toBeNull()
    await page.mouse.move(px!.x, px!.y)
    await page.waitForTimeout(200)
    expect(await page.evaluate(() => (window as any).__aluframe.tool.getState().hoverPartId)).toBe(c.id)
    await page.mouse.click(px!.x, px!.y)
    await page.waitForTimeout(150)
    expect((await store(page)).selectedIds[0]).toBe(c.id)
  })

  test('the cursor says a part is grabbable when a bracket is under it', async ({ page }) => {
    const c = (await store(page)).connectors[0]
    const at = await page.evaluate((id) => (window as any).__aluframe.connectorOBB(id), c.id)
    const px = await page.evaluate((pos) => (window as any).__aluframe.worldToClient(...pos), at)
    await page.mouse.move(px.x, px.y)
    await page.waitForTimeout(200)
    const cursor = await page.getByTestId('viewport').evaluate((el) => getComputedStyle(el as HTMLElement).cursor)
    expect(cursor).toBe('grab')
  })
})

// The drawer suite that was here described a drawer as six loose boards and two rails.
// A drawer is one component now, with its own opening and its own hardware, so what it is
// made of is pinned in `18-fittings-view-mode` instead.
