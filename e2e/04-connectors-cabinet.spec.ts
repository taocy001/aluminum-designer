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
      expect((await tool(page)).viewMode).toBe('draw')
      // alternate between the two rail ends so we can see they snap
      const target: [number, number, number] = i % 2 === 0 ? [603, 10, 2] : [-2, 10, 3]
      await hoverWorld(page, target)
      await clickWorld(page, target)
      const cs = (await store(page)).connectors
      expect(cs).toHaveLength(i + 1)
      expect(cs[i].type.length).toBeGreaterThan(0)
      expect(cs[i].position.map(Math.round)).toEqual(i % 2 === 0 ? [600, 10, 0] : [0, 10, 0])
    }
    await expect(page.getByTestId('bom-table')).toContainText('L型角码')
    // select one connector in navigate mode and delete it
    await page.keyboard.press('Escape')
    expect((await tool(page)).viewMode).toBe('navigate')
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

  test('clicking the active connector again returns to navigate', async ({ page }) => {
    await page.getByRole('button', { name: 'L型角码', exact: true }).click()
    expect((await tool(page)).viewMode).toBe('draw')
    await page.getByRole('button', { name: 'L型角码', exact: true }).click()
    expect((await tool(page)).viewMode).toBe('navigate')
  })
})

test.describe('Cabinet build', () => {
  test('a 600×400×800 cabinet frame with a shelf is buildable end-to-end', async ({ page }) => {
    await openApp(page)
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
    // a member from the front rail crossing the shelf rail mid-span must be refused
    expect(await drawMember(page, [300, 400, 0], [300, 400, D])).toBe(0)
    await expect(page.getByTestId('toasts')).toContainText('重叠')

    const s = await store(page)
    expect(s.profiles).toHaveLength(16)
    await expect(page.getByTestId('bom-count')).toHaveText('16')
    await expect(page.getByTestId('bom-overall')).toHaveText('620×420×810')
    const table = page.getByTestId('bom-table')
    await expect(table).toContainText('810 mm')   // uprights extended to the top rail face
    await expect(table).toContainText('580 mm')   // X rails between uprights
    await expect(table).toContainText('380 mm')   // Z rails and side rails
    await expect(table.locator('div', { hasText: '810 mm' }).first()).toContainText('×4')
    await expect(table.locator('div', { hasText: '580 mm' }).first()).toContainText('×6')
    await expect(table.locator('div', { hasText: '380 mm' }).first()).toContainText('×6')
    // 12 rails × 2 butt ends = 24 brackets
    await expect(page.getByTestId('bom-brackets')).toHaveText('24')
    await page.screenshot({ path: 'test-results/cabinet.png' })
  })
})
