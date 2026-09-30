import { test, expect } from '@playwright/test'
import { openApp, settle, setView, store, w2c } from './helpers'

/** a corner where four members meet: two uprights and two rails sharing one point */
async function corner(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const up = [-0.7071067811865475, 0, 0, 0.7071067811865476]
    const alongX = [0, 0.7071067811865475, 0, 0.7071067811865476]
    const alongZ = [0, 0, 0, 1]
    ;(window as any).__aluframe.store.getState().loadDocument({
      profiles: [
        { id: 'post', spec: '2020', length: 800, position: [0, 0, 0], quaternion: up, miterCuts: [], holes: [] },
        { id: 'post2', spec: '2020', length: 800, position: [900, 0, 0], quaternion: up, miterCuts: [], holes: [] },
        { id: 'rail', spec: '2020', length: 900, position: [0, 20, 0], quaternion: alongX, miterCuts: [], holes: [] },
        { id: 'cross', spec: '2020', length: 400, position: [0, 20, 0], quaternion: alongZ, miterCuts: [], holes: [] },
      ],
      connectors: [], panels: [],
    })
  })
  await settle(page)
}

const lengths = async (page: import('@playwright/test').Page) =>
  Object.fromEntries((await store(page)).profiles.map((p) => [p.id, Math.round(p.length)]))

/** Stretching requires the member to have been selected before the pointer press. */
test.describe('A press in a crowded corner', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await corner(page)
    await setView(page, [1100, 900, 1200], [300, 300, 150])
  })

  test('pressing an unselected member selects it and stretches nothing', async ({ page }) => {
    const before = await lengths(page)
    // aim at the corner itself, where all four members end
    const at = await w2c(page, [0, 20, 0])
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.mouse.move(at.x + 60, at.y - 40, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(250)
    expect(await lengths(page)).toEqual(before)
  })

  test('moving one member never changes another one’s length', async ({ page }) => {
    const before = await lengths(page)
    await page.evaluate(() => (window as any).__aluframe.store.getState().selectItem('rail', false))
    await settle(page)
    const at = await w2c(page, [450, 20, 0])        // the middle of the rail, away from its ends
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.mouse.move(at.x, at.y - 70, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(250)
    const after = await lengths(page)
    for (const id of ['post', 'post2', 'cross']) {
      expect(after[id], `${id} was not the one being moved`).toBe(before[id])
    }
  })

  test('and the member that is selected can still be stretched by its end', async ({ page }) => {
    const middle = await w2c(page, [450, 20, 0])
    await page.mouse.click(middle.x, middle.y)
    await settle(page)
    expect((await store(page)).selectedIds).toEqual(['rail'])
    const originalCuts = await page.evaluate(() => Object.fromEntries(Object.entries((window as any).__aluframe.trims())
      .map(([id, trim]: [string, any]) => [id, trim.cutLength])))
    // The post covers the joined cap. Reach for the exposed body just inside the
    // physical end, where the visible resize affordance belongs to this rail.
    const exposed = await page.evaluate(() => {
      const w = (window as any).__aluframe
      const rail = w.store.getState().profiles.find((p: any) => p.id === 'rail')
      const dir = new w.THREE.Vector3(0, 0, 1).applyQuaternion(new w.THREE.Quaternion(...rail.quaternion))
      return new w.THREE.Vector3(...rail.position).addScaledVector(dir, rail.length - w.trims().rail.end.trim - 20).toArray()
    })
    const end = await w2c(page, exposed)
    await page.mouse.move(end.x, end.y)
    await settle(page)
    expect(await page.evaluate(({ x, y }) => (window as any).__aluframe.frontmostAt(x, y)?.id, end)).toBe('rail')
    expect(await page.evaluate(() => (window as any).__aluframe.tool.getState().hoverEnd)).toBe('end')
    await page.mouse.down()
    await page.mouse.move(end.x - 90, end.y, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(250)
    const after = await lengths(page)
    expect(after.rail).not.toBe(900)
    expect(after.post).toBe(800)
    expect(after.post2).toBe(800)
    expect(after.cross).toBe(400)
    const finalCuts = await page.evaluate(() => Object.fromEntries(Object.entries((window as any).__aluframe.trims())
      .map(([id, trim]: [string, any]) => [id, trim.cutLength])))
    for (const id of ['post', 'post2', 'cross']) expect(finalCuts[id]).toBe(originalCuts[id])
    expect(finalCuts.rail).not.toBe(originalCuts.rail)
  })
})
