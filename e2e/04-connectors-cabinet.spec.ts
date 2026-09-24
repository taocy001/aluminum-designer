import { test, expect } from '@playwright/test'
import { openApp, enterDraw, drawMember, drawExact, clickWorld, hoverWorld, store, tool, setView } from './helpers'

const CONNECTORS = ['L型角码', '内角码', '加强筋', '直连板', 'T型角码', '十字连接板', '三维角码', '对接板', '端盖', '滑块螺母', '合页', '轴承座', '脚轮座', '调节脚']

test.describe('Connectors', () => {
  test.beforeEach(async ({ page }) => { await openApp(page) })

  test('every connector type can be placed at a snapped endpoint, selected and deleted', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    for (let i = 0; i < CONNECTORS.length; i++) {
      await page.getByRole('button', { name: CONNECTORS[i], exact: true }).click()
      expect((await tool(page)).held).not.toBe(null)
      // alternate between the two rail ends so we can see they snap
      const target: [number, number, number] = i % 2 === 0 ? [603, 10, 2] : [-2, 10, 3]
      await hoverWorld(page, target)
      await clickWorld(page, target)
      const cs = (await store(page)).connectors
      expect(cs).toHaveLength(i + 1)
      expect(cs[i].type.length).toBeGreaterThan(0)
      // Each part lands on the end it was dropped near. The two that stand under a member —
      // a levelling foot and a caster mount — are seated just outside that end face rather
      // than in the metal, so they sit one half-length further along.
      const want = i % 2 === 0 ? [600, 10, 0] : [0, 10, 0]
      const under = CONNECTORS[i] === '调节脚' || CONNECTORS[i] === '脚轮座'
      const got = cs[i].position.map(Math.round)
      expect([got[1], got[2]]).toEqual([want[1], want[2]])
      expect(Math.abs(got[0] - want[0])).toBeLessThanOrEqual(under ? 12 : 0)
    }
    await expect(page.getByTestId('bom-table')).toContainText('L型角码')
    // select one connector in navigate mode and delete it
    await page.keyboard.press('Escape')
    expect((await tool(page)).held).toBe(null)
    const c0 = (await store(page)).connectors[0]
    await clickWorld(page, [600, 22, 0])
    const sel = (await store(page)).selectedIds
    expect(sel.length).toBe(1)
    expect((await store(page)).connectors.map((c) => c.id).concat((await store(page)).profiles.map((p) => p.id))).toContain(sel[0])
    await page.keyboard.press('Delete')
    expect((await store(page)).connectors.length + (await store(page)).profiles.length).toBe(CONNECTORS.length)
    await page.keyboard.press('Control+z')
    expect((await store(page)).connectors).toHaveLength(CONNECTORS.length)
    expect((await store(page)).connectors[0].id).toBe(c0.id)
  })

  test('clicking the active connector again empties the hand', async ({ page }) => {
    await page.getByTestId('connector-bracket').click()
    expect((await tool(page)).held).toBe('connector')
    await page.getByTestId('connector-bracket').click()
    expect((await tool(page)).held).toBe(null)
  })
})

test.describe('Cabinet build', () => {
  test('a 600×400×800 cabinet frame with a shelf is buildable end-to-end', async ({ page }) => {
    await openApp(page)
    await page.getByTestId('through-posts').click()   // this build is described posts-through
    await setView(page, [1900, 1500, 2300], [300, 400, 200])
    const W = 600, D = 400, H = 800
    await enterDraw(page, '2020')
    // 4 uprights, exact height from the floor
    for (const [x, z] of [[0, 0], [W, 0], [0, D], [W, D]]) {
      expect(await drawExact(page, [x, 0, z], [x, 300, z], H)).toBe(1)
    }
    // bottom rails between upright bases (snap start at upright bottom, end on the next upright centerline)
    expect(await drawMember(page, [0, 10, 0], [W, 10, 0])).toBe(1)
    expect(await drawMember(page, [0, 10, D], [W, 10, D])).toBe(1)
    expect(await drawMember(page, [0, 10, 0], [0, 10, D])).toBe(1)
    expect(await drawMember(page, [W, 10, 0], [W, 10, D])).toBe(1)
    // top rails between upright tops (endpoint snap both ends)
    expect(await drawMember(page, [0, H, 0], [W, H, 0])).toBe(1)
    expect(await drawMember(page, [0, H, D], [W, H, D])).toBe(1)
    expect(await drawMember(page, [0, H, 0], [0, H, D])).toBe(1)
    expect(await drawMember(page, [W, H, 0], [W, H, D])).toBe(1)
    // a shelf half way up, spanning between the two Z uprights' centerlines at x=300 → needs side rails: draw side rails at y=400 first
    expect(await drawMember(page, [0, 400, 0], [0, 400, D])).toBe(1)   // T-joints on uprights
    expect(await drawMember(page, [W, 400, 0], [W, 400, D])).toBe(1)
    expect(await drawMember(page, [0, 400, 200], [W, 400, 200])).toBe(1) // shelf rail between the side rails (T-joints)
    expect(await drawMember(page, [0, 400, 0], [W, 400, 0])).toBe(1)     // front rail at shelf height
    const s = await store(page)
    expect(s.profiles).toHaveLength(16)
    await expect(page.getByTestId('bom-count')).toHaveText('16')
    await expect(page.getByTestId('bom-penetrations')).toHaveText('无干涉')
    await expect(page.getByTestId('bom-overall')).toHaveText('620×420×810')
    const table = page.getByTestId('bom-table')
    await expect(table).toContainText('810 mm')   // uprights extended to the top rail face
    await expect(table).toContainText('580 mm')   // X rails between uprights
    await expect(table).toContainText('380 mm')   // Z rails and side rails
    await expect(table.locator('div', { hasText: '810 mm' }).first()).toContainText('×4')
    await expect(table.locator('div', { hasText: '580 mm' }).first()).toContainText('×6')
    await expect(table.locator('div', { hasText: '380 mm' }).first()).toContainText('×6')
    // 12 rails × 2 butt ends = 24 brackets
    await expect(page.getByTestId('bom-brackets')).toHaveText('0/24')
    await page.screenshot({ path: 'test-results/cabinet.png' })
  })
})

test.describe('Connectors land the right way round', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); await setView(page, [1500, 1200, 1800], [300, 300, 200]) })

  const axisOf = (q: number[], local: [number, number, number]) => {
    const [x, y, z, w] = q
    const [vx, vy, vz] = local
    // quaternion rotation of a unit axis, rounded for comparison
    const ix = w * vx + y * vz - z * vy
    const iy = w * vy + z * vx - x * vz
    const iz = w * vz + x * vy - y * vx
    const iw = -x * vx - y * vy - z * vz
    return [
      ix * w + iw * -x + iy * -z - iz * -y,
      iy * w + iw * -y + iz * -x - ix * -z,
      iz * w + iw * -z + ix * -y - iy * -x,
    ].map((v) => (Math.round(v * 100) / 100) || 0)
  }

  test('an L-bracket dropped in a corner points along both members', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawExact(page, [0, 0, 0], [0, 300, 0], 600)     // upright
    await drawMember(page, [0, 10, 0], [600, 10, 0])       // rail off its base
    await page.getByRole('button', { name: 'L型角码', exact: true }).click()
    await clickWorld(page, [0, 10, 0])
    const c = (await store(page)).connectors[0]
    expect(c.series).toBe(20)
    const arms = [axisOf(c.quaternion, [1, 0, 0]), axisOf(c.quaternion, [0, 1, 0])].map((v) => v.map(Math.round).join(','))
    expect(arms).toContain('0,1,0')                        // one arm up the post
    expect(arms).toContain('1,0,0')                        // the other out along the rail
  })

  test('an end cap points out of the end it caps', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 10, 0])
    await page.getByRole('button', { name: '端盖', exact: true }).click()
    await clickWorld(page, [600, 10, 0])
    const c = (await store(page)).connectors[0]
    expect(axisOf(c.quaternion, [0, 0, 1])).toEqual([1, 0, 0])
  })

  test('the part takes the series of the member it lands on', async ({ page }) => {
    await enterDraw(page, '4040')
    await drawMember(page, [0, 0, 0], [600, 20, 0])
    await page.getByRole('button', { name: 'L型角码', exact: true }).click()
    await clickWorld(page, [600, 20, 0])
    expect((await store(page)).connectors[0].series).toBe(40)
  })

  test('the BOM lists connectors by series and derives the fasteners', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawExact(page, [0, 0, 0], [0, 300, 0], 600)
    await drawMember(page, [0, 10, 0], [600, 10, 0])
    await page.getByRole('button', { name: 'L型角码', exact: true }).click()
    await clickWorld(page, [0, 10, 0])
    await clickWorld(page, [600, 10, 0])
    const table = page.getByTestId('bom-table')
    await expect(table).toContainText('L型角码')
    await expect(page.getByTestId('bom-fasteners')).toBeVisible()
    await expect(table).toContainText('螺栓 M5×10')
    await expect(table).toContainText('T型螺母 M5')
    // two L-brackets at two bolts each
    await expect(table.locator('div', { hasText: '螺栓 M5×10' }).last()).toContainText('×4')
  })

  test('suggestions drop as the real parts are placed', async ({ page }) => {
    await enterDraw(page, '2020')
    await drawExact(page, [0, 0, 0], [0, 300, 0], 600)
    await drawMember(page, [0, 10, 0], [600, 10, 0])
    await expect(page.getByTestId('bom-suggested')).toBeVisible()
    const before = await page.getByTestId('bom-table').textContent()
    await page.getByRole('button', { name: 'L型角码', exact: true }).click()
    await clickWorld(page, [0, 10, 0])
    const after = await page.getByTestId('bom-table').textContent()
    expect(after).not.toEqual(before)
  })
})
