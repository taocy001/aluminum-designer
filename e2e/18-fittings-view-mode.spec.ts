import { test, expect } from '@playwright/test'
import { openApp, settle, store, setView } from './helpers'

/** a 600 × 600 × 800 bay, which is a kitchen cabinet */
async function bay(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const up = { quaternion: [-0.7071067811865475, 0, 0, 0.7071067811865476], miterCuts: [], holes: [] }
    const alongX = { quaternion: [0, 0.7071067811865475, 0, 0.7071067811865476], miterCuts: [], holes: [] }
    const alongZ = { quaternion: [0, 0, 0, 1], miterCuts: [], holes: [] }
    ;(window as any).__aluframe.store.getState().loadDocument({
      profiles: [
        { id: 'u1', spec: '2020', length: 800, position: [0, 0, 0], ...up },
        { id: 'u2', spec: '2020', length: 800, position: [600, 0, 0], ...up },
        { id: 'u3', spec: '2020', length: 800, position: [0, 0, 600], ...up },
        { id: 'u4', spec: '2020', length: 800, position: [600, 0, 600], ...up },
        { id: 'r1', spec: '2020', length: 600, position: [0, 10, 0], ...alongX },
        { id: 'r2', spec: '2020', length: 600, position: [0, 790, 0], ...alongX },
        { id: 'r3', spec: '2020', length: 600, position: [0, 10, 0], ...alongZ },
        { id: 'r4', spec: '2020', length: 600, position: [600, 10, 0], ...alongZ },
      ], connectors: [], panels: [], fittings: [],
    })
  })
  await settle(page)
  await setView(page, [1400, 900, 1600], [300, 400, 300])
}

const pick = (page: import('@playwright/test').Page, ids: string[]) =>
  page.evaluate((x) => (window as any).__aluframe.store.getState().selectItems(x), ids)

const fittings = async (page: import('@playwright/test').Page) => (await store(page)).fittings as any[]

/**
 * A drawer was six loose boards and two rails, so nothing held it together: resize the
 * opening and they stayed where they were, delete one and the rest were still a "drawer".
 */
test.describe('A drawer is one component', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); await bay(page) })

  test('fitting one adds a drawer, not a pile of board', async ({ page }) => {
    await pick(page, ['u1', 'u2', 'u3', 'u4'])
    await page.getByTestId('drawer-height').fill('250')
    await page.getByTestId('add-drawer').click()
    await settle(page)
    await page.waitForTimeout(250)
    const s = await store(page)
    expect(s.panels.length).toBe(0)
    expect((s.fittings as any[]).length).toBe(1)
    expect((s.fittings as any[])[0].kind).toBe('drawer')
  })

  test('it knows its own opening, less the frame', async ({ page }) => {
    await pick(page, ['u1', 'u2', 'u3', 'u4'])
    await page.getByTestId('drawer-height').fill('250')
    await page.getByTestId('add-drawer').click()
    await settle(page)
    await page.waitForTimeout(250)
    const f = (await fittings(page))[0]
    expect(Math.round(f.width)).toBe(580)     // 600 between centres, less a section
    expect(Math.round(f.height)).toBe(250)
    expect(Math.round(f.depth)).toBe(580)
  })

  test('two of them stack, and neither overlaps the other', async ({ page }) => {
    await pick(page, ['u1', 'u2', 'u3', 'u4'])
    await page.getByTestId('drawer-height').fill('250')
    await page.getByTestId('drawer-count').fill('2')
    await page.getByTestId('add-drawer').click()
    await settle(page)
    await page.waitForTimeout(250)
    const fs = await fittings(page)
    expect(fs.length).toBe(2)
    expect(Math.abs(fs[0].position[1] - fs[1].position[1])).toBeCloseTo(250, 0)
  })

  test('deleting it takes the whole drawer', async ({ page }) => {
    await pick(page, ['u1', 'u2', 'u3', 'u4'])
    await page.getByTestId('add-drawer').click()
    await settle(page)
    await page.waitForTimeout(250)
    const id = (await fittings(page))[0].id
    await pick(page, [id])
    await page.keyboard.press('Delete')
    await settle(page)
    expect(await fittings(page)).toHaveLength(0)
  })

  test('its boards and its runners reach the cut list', async ({ page }) => {
    await pick(page, ['u1', 'u2', 'u3', 'u4'])
    await page.getByTestId('add-drawer').click()
    await settle(page)
    await page.waitForTimeout(300)
    const csv = await page.evaluate(() => document.body.innerText)
    expect(csv).toContain('滑轨')
  })
})

/** Three hinges, and they are not interchangeable */
test.describe('A door hangs on a hinge', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); await bay(page) })

  test('two uprights are enough to say where it goes', async ({ page }) => {
    await pick(page, ['u1', 'u2'])
    await page.getByTestId('add-door').click()
    await settle(page)
    await page.waitForTimeout(250)
    const fs = await fittings(page)
    expect(fs).toHaveLength(1)
    expect(fs[0].kind).toBe('door')
    expect(Math.round(fs[0].width)).toBe(580)
  })

  test('the hinge side and kind are what was chosen', async ({ page }) => {
    await pick(page, ['u1', 'u2'])
    await page.getByTestId('hinge-right').click()
    await page.getByTestId('hingetype-slot').click()
    await page.getByTestId('overlay-half').click()
    await page.getByTestId('add-door').click()
    await settle(page)
    await page.waitForTimeout(250)
    const f = (await fittings(page))[0]
    expect(f.hinge).toBe('right')
    expect(f.hingeType).toBe('slot')
    expect(f.overlay).toBe('half')
  })

  test('a T-slot hinge lies back further than a cup hinge', async ({ page }) => {
    const swing = await page.evaluate(() => {
      const w = (window as any)
      return w.__aluframe.hingeSwing ?? null
    })
    void swing
    await pick(page, ['u1', 'u2'])
    await page.getByTestId('hingetype-cup').click()
    await page.getByTestId('add-door').click()
    await settle(page)
    await pick(page, ['u3', 'u4'])
    await page.getByTestId('hingetype-slot').click()
    await page.getByTestId('add-door').click()
    await settle(page)
    await page.waitForTimeout(250)
    const fs = await fittings(page)
    expect(fs[0].hingeType).toBe('cup')
    expect(fs[1].hingeType).toBe('slot')
  })

  test('its hinges reach the cut list, counted by height', async ({ page }) => {
    await pick(page, ['u1', 'u2'])
    await page.getByTestId('add-door').click()
    await settle(page)
    await page.waitForTimeout(300)
    expect(await page.evaluate(() => document.body.innerText)).toContain('杯铰')
  })
})

/** Building or looking. A drawing you cannot open is a drawing. */
test.describe('Looking at it instead of building it', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await bay(page)
    await pick(page, ['u1', 'u2', 'u3', 'u4'])
    await page.getByTestId('drawer-height').fill('250')
    await page.getByTestId('add-drawer').click()
    await settle(page)
    await page.waitForTimeout(250)
  })

  test('the mode switch says which one you are in', async ({ page }) => {
    // one switch, two states. The toolbar is icons, so the state it is in is the icon and
    // the name it answers to, never a caption on one button among a row that has none.
    await expect(page.getByTestId('mode-toggle')).toHaveAttribute('aria-label', '编辑')
    await expect(page.getByTestId('mode-toggle')).toHaveText('')
    await page.getByTestId('mode-toggle').click()
    await settle(page)
    expect(await page.evaluate(() => (window as any).__aluframe.tool.getState().viewMode)).toBe(true)
    await expect(page.getByTestId('mode-toggle')).toHaveAttribute('aria-label', '查看')
    await page.getByTestId('mode-toggle').click()
    await settle(page)
    expect(await page.evaluate(() => (window as any).__aluframe.tool.getState().viewMode)).toBe(false)
  })

  test('a press on a drawer pulls it out, and again puts it back', async ({ page }) => {
    await page.getByTestId('mode-toggle').click()
    await settle(page)
    const f = (await fittings(page))[0]
    const c = await page.evaluate((p) => (window as any).__aluframe.worldToClient(p[0], p[1], p[2]), f.position)
    await page.mouse.click(c.x, c.y)
    await page.waitForTimeout(300)
    expect((await fittings(page))[0].open).toBe(1)
    await page.mouse.click(c.x, c.y)
    await page.waitForTimeout(300)
    expect((await fittings(page))[0].open).toBe(0)
  })

  test('opening one is not something to undo: it is not a change to the design', async ({ page }) => {
    const before = (await store(page)).past
    await page.getByTestId('mode-toggle').click()
    await settle(page)
    const f = (await fittings(page))[0]
    const c = await page.evaluate((p) => (window as any).__aluframe.worldToClient(p[0], p[1], p[2]), f.position)
    await page.mouse.click(c.x, c.y)
    await page.waitForTimeout(300)
    expect((await store(page)).past).toBe(before)
  })

  test('nothing can be moved or deleted while looking', async ({ page }) => {
    await pick(page, ['u1'])
    await page.getByTestId('mode-toggle').click()
    await settle(page)
    const before = await store(page)
    await page.keyboard.press('Delete')
    await page.keyboard.press('ArrowRight')
    await settle(page)
    const after = await store(page)
    expect(after.profiles.length).toBe(before.profiles.length)
    expect(after.profiles[0].position).toEqual(before.profiles[0].position)
  })

  test('the move and turn handles go away, because nothing moves', async ({ page }) => {
    await pick(page, ['u1'])
    await settle(page)
    await page.waitForTimeout(200)
    expect(await page.evaluate(() => (window as any).__aluframe.gizmoHandles().length)).toBeGreaterThan(0)
    await page.getByTestId('mode-toggle').click()
    await settle(page)
    await page.waitForTimeout(250)
    expect(await page.evaluate(() => (window as any).__aluframe.gizmoHandles().length)).toBe(0)
  })

  test('picking up a part goes back to building rather than doing nothing', async ({ page }) => {
    await page.getByTestId('mode-toggle').click()
    await settle(page)
    await page.getByTestId('spec-2040').click()
    await settle(page)
    const t = await page.evaluate(() => (window as any).__aluframe.tool.getState())
    expect(t.viewMode).toBe(false)
    expect(t.held).toBe('profile')
  })
})

/** The corner box said eight lines nobody read; every button explains itself now */
test.describe('The corner of the canvas', () => {
  test.beforeEach(async ({ page }) => openApp(page))

  test('it is one line, and it says what you are doing', async ({ page }) => {
    await expect(page.getByTestId('mode-line')).toBeVisible()
    const text = await page.getByTestId('mode-line').textContent()
    expect(text!.split('\n').length).toBe(1)
  })

  test('the key list is one press away, not printed there', async ({ page }) => {
    await expect(page.getByTestId('help-panel')).toHaveCount(0)
    await page.getByTestId('help-toggle').click()
    await expect(page.getByTestId('help-panel')).toBeVisible()
    await page.getByTestId('help-toggle').click()
    await expect(page.getByTestId('help-panel')).toHaveCount(0)
  })

  test('the line follows what is in hand', async ({ page }) => {
    await page.getByTestId('spec-2040').click()
    await settle(page)
    await expect(page.getByTestId('mode-line')).toContainText('2040')
    await page.getByTestId('mode-toggle').click()
    await settle(page)
    await expect(page.getByTestId('mode-line')).not.toContainText('2040')
  })
})
