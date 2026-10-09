import { test, expect, type Page } from '@playwright/test'
import { chooseConnector, openApp, setView, enterDraw, drawMember, clickWorld, settle, store, tool, w2c } from './helpers'

/** Buildability, one-click connectors, overall size, the standard shortcuts, full screen. */

async function emptyHand(page: Page) {
  await page.keyboard.press('Escape')
  if ((await tool(page)).held !== null) await page.keyboard.press('Escape')
  expect((await tool(page)).held).toBe(null)
}

/** A post with a rail butting into it, both specs given */
async function postAndRail(page: Page, post: string, rail: string) {
  await openApp(page)
  await setView(page, [1500, 1100, 1900], [300, 400, 0])
  await enterDraw(page, post)
  await drawMember(page, [0, 0, 0], [0, 800, 0])
  await enterDraw(page, rail)
  await drawMember(page, [0, 0, 0], [600, 0, 0])
  await emptyHand(page)
  expect((await store(page)).profiles.length).toBe(2)
}

test.describe('Joint compatibility', () => {
  test('B6 2020 on I8 4040 is reported as unsupported', async ({ page }) => {
    await postAndRail(page, '4040', '2020')
    await expect(page.getByTestId('bom-mismatches')).toContainText('缺少可用连接件')
  })

  test('B6 2040 fits the two slots of a 4040-B6 post', async ({ page }) => {
    await postAndRail(page, '4040-B6', '2040')
    await expect(page.getByTestId('bom-mismatches')).not.toContainText('缺少可用连接件')
  })

  test('a 2020 on a 2040 bolts up: they share the 20 side', async ({ page }) => {
    await postAndRail(page, '2040', '2020')
    await expect(page.getByTestId('bom-mismatches')).toContainText('全部可接')
  })

  test('a 2020 on a 3030 is called out', async ({ page }) => {
    await postAndRail(page, '3030', '2020')
    await expect(page.getByTestId('bom-mismatches')).toContainText('缺少可用连接件')
  })

  test('matching outside faces do not hide unsupported B6/I8 slot systems', async ({ page }) => {
    await postAndRail(page, '4040', '2040')
    await expect(page.getByTestId('bom-mismatches')).toContainText('缺少可用连接件')
    await page.getByTestId('sidebar-tab-inspect').click()
    await expect(page.getByTestId('bom-cross-series')).toBeVisible()
    await chooseConnector(page, 'inside-corner')
    await page.getByTestId('auto-connect').click()
    expect((await store(page)).connectors).toEqual([])
  })

  test('3030 B8 and 4040 I8 use the verified common inner bracket', async ({ page }) => {
    await postAndRail(page, '4040', '3030')
    await expect(page.getByTestId('bom-mismatches')).toContainText('全部可接')
    await expect(page.getByTestId('bom-cross-series')).toHaveCount(0)
    await chooseConnector(page, 'inside-corner')
    await page.getByTestId('auto-connect').click()
    const connectors = (await store(page)).connectors
    expect(connectors.length).toBeGreaterThan(0)
    expect(connectors.every((c: any) => c.type === 'inside-corner' && c.mountSeries?.includes(30) && c.mountSeries?.includes(40))).toBe(true)
    expect(await page.evaluate(() => (window as any).__aluframe.bracketFaults())).toEqual([])
    expect(await page.evaluate(() => (window as any).__aluframe.conflicts().conflicts)).toEqual([])
  })

  test('a buildable frame has no warning markers in the scene', async ({ page }) => {
    await postAndRail(page, '4040-B6', '2040')
    const markers = await page.evaluate(() => (window as any).__aluframe.spriteCount())
    await postAndRail(page, '4040', '2020')
    const withBad = await page.evaluate(() => (window as any).__aluframe.spriteCount())
    expect(withBad).toBeGreaterThan(markers)
  })

  test('the readout selects the members it is complaining about', async ({ page }) => {
    await postAndRail(page, '4040', '2020')
    await page.getByTestId('sidebar-tab-inspect').click()
    await page.getByTestId('bom-mismatches').click()
    expect((await store(page)).selectedIds.length).toBe(2)
  })

  test('the readout is dead when everything bolts up', async ({ page }) => {
    await postAndRail(page, '2040', '2020')
    await expect(page.getByTestId('bom-mismatches')).toContainText('全部可接')
    await expect(page.getByTestId('bom-mismatches').locator('..')).toBeDisabled()
  })

  test('a frame of one series is clean', async ({ page }) => {
    await openApp(page)
    await setView(page, [1500, 1100, 1900], [300, 400, 0])
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [0, 800, 0])
    await drawMember(page, [0, 0, 0], [600, 0, 0])
    await drawMember(page, [600, 0, 0], [600, 800, 0])
    await emptyHand(page)
    await expect(page.getByTestId('bom-mismatches')).toContainText('全部可接')
  })
})

test.describe('One click fits the connector to every joint', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await setView(page, [1600, 1200, 2000], [300, 400, 0])
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [0, 800, 0])
    await drawMember(page, [600, 0, 0], [600, 800, 0])
    await drawMember(page, [0, 0, 0], [600, 0, 0])
    await drawMember(page, [0, 800, 0], [600, 800, 0])
    await emptyHand(page)
    expect((await store(page)).profiles.length).toBe(4)
  })

  test('the button only appears with a connector in hand', async ({ page }) => {
    await expect(page.getByTestId('auto-connect')).toHaveCount(0)
    await chooseConnector(page, 'bracket')
    await expect(page.getByTestId('auto-connect')).toBeVisible()
  })

  test('brackets land on every butt joint in one step', async ({ page }) => {
    await chooseConnector(page, 'bracket')
    await page.getByTestId('auto-connect').click()
    const after = await store(page)
    expect(after.connectors.length).toBeGreaterThan(2)
    expect(after.connectors.every((c: any) => c.type === 'bracket')).toBe(true)
    await page.keyboard.press('Control+z')
    expect((await store(page)).connectors.length).toBe(0)
  })

  test('a second run adds nothing and says so', async ({ page }) => {
    await chooseConnector(page, 'bracket')
    await page.getByTestId('auto-connect').click()
    const n = (await store(page)).connectors.length
    await page.getByTestId('auto-connect').click()
    expect((await store(page)).connectors.length).toBe(n)
    await expect(page.getByTestId('toasts')).toContainText('没有待补齐的安装位置')
  })

  test('end caps go on free ends, not on joints', async ({ page }) => {
    await chooseConnector(page, 'end-cap')
    await page.getByTestId('auto-connect').click()
    // Rails butt against the fixed posts' sides. All four post caps remain exposed.
    const caps = await page.evaluate(() => {
      const w = (window as any).__aluframe
      return w.store.getState().connectors.map((cap: any) => ({ ...cap,
        normal: new w.THREE.Vector3(0, 0, 1).applyQuaternion(new w.THREE.Quaternion(...cap.quaternion)).toArray(),
      })).sort((a: any, b: any) => a.position[0] - b.position[0] || a.position[1] - b.position[1])
    })
    expect(caps).toHaveLength(4)
    const expected = [[0, 0, 0], [0, 800, 0], [600, 0, 0], [600, 800, 0]]
    for (const [index, cap] of caps.entries()) {
      expect(cap.type).toBe('end-cap'); expect(cap.series).toBe(20)
      for (const axis of [0, 1, 2]) expect(cap.position[axis]).toBeCloseTo(expected[index][axis], 5)
      expect(cap.normal[0]).toBeCloseTo(0, 5); expect(cap.normal[2]).toBeCloseTo(0, 5)
      expect(cap.normal[1]).toBeCloseTo(expected[index][1] === 0 ? -1 : 1, 5)
    }
    expect(await page.evaluate(() => (window as any).__aluframe.conflicts().conflicts)).toEqual([])
    const before = await store(page)
    await page.getByTestId('auto-connect').click()
    expect((await store(page)).connectors).toEqual(before.connectors)
    expect((await store(page)).past).toBe(before.past)
    await expect(page.getByTestId('toasts')).toContainText('没有待补齐的安装位置')
  })

  test('a part that goes on a face says which face is the user\'s call', async ({ page }) => {
    await chooseConnector(page, 'hinge')
    await page.getByTestId('auto-connect').click()
    await expect(page.getByTestId('toasts')).toContainText('需要你来指定')
    expect((await store(page)).connectors.length).toBe(0)
  })

  test('the series follows the members it lands on', async ({ page }) => {
    await chooseConnector(page, 'bracket')
    await page.getByTestId('auto-connect').click()
    expect((await store(page)).connectors.every((c: any) => c.series === 20)).toBe(true)
  })
})

test.describe('Overall size', () => {
  // Load a fixture to isolate the rendering switch from drawing input.
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await setView(page, [2000, 1500, 2500], [300, 400, 200])
    await page.evaluate(() => {
      const up = { quaternion: [-0.7071067811865475, 0, 0, 0.7071067811865476], miterCuts: [], holes: [] }
      ;(window as any).__aluframe.store.getState().loadDocument({
        profiles: [
          { id: 'u1', spec: '2020', length: 800, position: [0, 0, 0], ...up },
          { id: 'u2', spec: '2020', length: 800, position: [600, 0, 0], ...up },
        ],
        connectors: [], panels: [],
      })
    })
    expect((await store(page)).profiles.length).toBe(2)
  })

  test('the size lines are on by default and follow the labels switch', async ({ page }) => {
    // the scene is queried after it has drawn: a toggle is React state and the group only
    // leaves the graph on the next render
    const dims = async () => { await settle(page); return page.evaluate(() => (window as any).__aluframe.countByName('frame-dimensions')) }
    expect(await dims()).toBe(1)
    await page.getByTestId('labels-toggle').click()
    expect(await dims()).toBe(0)
    await page.getByTestId('labels-toggle').click()
    expect(await dims()).toBe(1)
  })

  test('one switch covers both scales: the cut lengths and the overall size', async ({ page }) => {
    const sprites = () => page.evaluate(() => (window as any).__aluframe.spriteCount())
    const withLabels = await sprites()
    await page.getByTestId('labels-toggle').click()
    await settle(page)
    expect(await sprites()).toBeLessThan(withLabels)
  })
})

test.describe('The shortcuts people already know', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await setView(page, [2200, 1500, 2600], [700, 400, 200])
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [0, 800, 0])
    await drawMember(page, [0, 0, 0], [600, 0, 0])
    await drawMember(page, [1500, 0, 0], [1500, 800, 0])   // standing on its own
    await emptyHand(page)
    expect((await store(page)).profiles.length).toBe(3)
  })

  test('Ctrl+A takes everything and Ctrl+Shift+A lets it go', async ({ page }) => {
    await page.keyboard.press('Control+a')
    expect((await store(page)).selectedIds.length).toBe(3)
    await page.keyboard.press('Control+Shift+a')
    expect((await store(page)).selectedIds.length).toBe(0)
  })

  test('the quick menu takes the sub-assembly a member belongs to', async ({ page }) => {
    const c = await w2c(page, [300, 10, 0])
    await page.mouse.click(c.x, c.y)
    expect((await store(page)).selectedIds.length).toBe(1)
    await page.mouse.move(c.x, c.y)
    await page.keyboard.press('Space')
    await page.getByTestId('quick-connected').click()
    await page.waitForTimeout(200)
    const ids = (await store(page)).selectedIds
    expect(ids.length).toBe(2)          // the two that meet at the corner, not the lone one
  })

  /** Double-click zoom works over members and empty space; connected selection uses the quick menu. */
  test('double-clicking a member comes in on it rather than selecting', async ({ page }) => {
    const before = await page.evaluate(() => (window as any).__aluframe.camera.position.toArray().map(Math.round))
    const c = await w2c(page, [1500, 400, 0])
    await page.mouse.dblclick(c.x, c.y)
    await page.waitForTimeout(250)
    expect(await page.evaluate(() => (window as any).__aluframe.camera.position.toArray().map(Math.round))).not.toEqual(before)
  })

  test('double-clicking empty space comes in too', async ({ page }) => {
    const before = await page.evaluate(() => (window as any).__aluframe.camera.position.toArray().map(Math.round))
    await page.mouse.dblclick(1200, 820)
    await page.waitForTimeout(250)
    expect(await page.evaluate(() => (window as any).__aluframe.camera.position.toArray().map(Math.round))).not.toEqual(before)
  })

  test('a lone member’s sub-assembly is just itself', async ({ page }) => {
    const c = await w2c(page, [1500, 400, 0])
    await page.mouse.click(c.x, c.y)
    await page.mouse.move(c.x, c.y)
    await page.keyboard.press('Space')
    await page.getByTestId('quick-connected').click()
    await page.waitForTimeout(200)
    expect((await store(page)).selectedIds.length).toBe(1)
  })

  test('Space works with nothing selected too', async ({ page }) => {
    await page.mouse.move(800, 400)
    await page.keyboard.press('Space')
    await expect(page.getByTestId('quick-menu')).toBeVisible()
    await page.getByTestId('quick-select-all').click()
    expect((await store(page)).selectedIds.length).toBe(3)
  })
})

test.describe('Full screen', () => {
  test('the button is there and reports what the browser allowed', async ({ page }) => {
    await openApp(page)
    await expect(page.getByTestId('fullscreen-toggle')).toBeVisible()
    await page.getByTestId('fullscreen-toggle').click()
    await page.waitForTimeout(250)
    // headless Chromium may refuse; either it went full screen or it said why
    const went = await page.evaluate(() => document.fullscreenElement !== null)
    if (!went) await expect(page.getByTestId('toasts')).toContainText('全屏')
  })

  test('F frames the selected member', async ({ page }) => {
    await openApp(page)
    await enterDraw(page, '2020')
    await drawMember(page, [0, 0, 0], [600, 0, 0])
    await emptyHand(page)
    await clickWorld(page, [300, 10, 0])
    const before = await page.evaluate(() => (window as any).__aluframe.camera.position.toArray().map(Math.round))
    await page.keyboard.press('f')
    await page.waitForTimeout(200)
    expect(await page.evaluate(() => (window as any).__aluframe.camera.position.toArray().map(Math.round))).not.toEqual(before)
  })
})
