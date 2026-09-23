import { test, expect } from '@playwright/test'
import { openApp, settle, store, setView } from './helpers'

const UP = [-0.7071067811865475, 0, 0, 0.7071067811865476]

async function onePost(page: import('@playwright/test').Page) {
  await page.evaluate((up) => {
    ;(window as any).__aluframe.store.getState().loadDocument({
      profiles: [{ id: 'a', spec: '2020', length: 600, position: [0, 0, 0], quaternion: up, miterCuts: [], holes: [] }],
      connectors: [], panels: [], fittings: [],
    })
  }, UP)
  await settle(page)
  await setView(page, [900, 700, 900], [0, 300, 0])
}

const sightDistance = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const c = (window as any).__aluframe.camera.position
  const t = (window as any).__aluframe.controls.target
  return Math.hypot(c.x - t.x, c.y - t.y, c.z - t.z)
})

const pinch = (page: import('@playwright/test').Page, deltaY: number, n = 30) => page.evaluate(([d, count]) => {
  const c = document.querySelector('canvas')!
  for (let i = 0; i < count; i++) {
    c.dispatchEvent(new WheelEvent('wheel', { deltaY: d, ctrlKey: true, bubbles: true, cancelable: true }))
  }
}, [deltaY, n])

/**
 * Three and four fingers belong to macOS, and a two-finger swipe sideways belongs to the
 * browser. What is left is the pinch, which is the one everybody already knows.
 */
test.describe('Trackpad gestures', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); await onePost(page) })

  test('a pinch zooms the model', async ({ page }) => {
    const before = await sightDistance(page)
    await pinch(page, -6)
    await settle(page)
    expect(await sightDistance(page)).toBeLessThan(before * 0.6)
  })

  test('...and spreading takes it back', async ({ page }) => {
    const before = await sightDistance(page)
    await pinch(page, -6)
    await settle(page)
    await pinch(page, 6)
    await settle(page)
    expect(await sightDistance(page)).toBeCloseTo(before, -1)
  })

  test('it zooms the model, not the page', async ({ page }) => {
    // the browser's own response to ctrl+wheel is to scale the whole page, toolbar and all
    const taken = await page.evaluate(() => {
      const c = document.querySelector('canvas')!
      const e = new WheelEvent('wheel', { deltaY: -6, ctrlKey: true, bubbles: true, cancelable: true })
      c.dispatchEvent(e)
      return e.defaultPrevented
    })
    expect(taken).toBe(true)
  })

  test('an ordinary scroll still zooms, and is left to the camera controls', async ({ page }) => {
    // OrbitControls takes the plain wheel itself — it has always zoomed and still does.
    // What matters is that the pinch handler does not also act on it and double the step.
    const before = await sightDistance(page)
    await page.mouse.move(800, 500)
    await page.mouse.wheel(0, -120)
    await settle(page)
    await page.waitForTimeout(150)
    const after = await sightDistance(page)
    expect(after).not.toBeCloseTo(before, 0)
    expect(after).toBeGreaterThan(before * 0.5)     // one notch, not a whole pinch
  })

  test('a sideways swipe cannot navigate away from the drawing', async ({ page }) => {
    // the back gesture would leave, and the drawing lives in storage rather than the URL
    expect(await page.evaluate(() => getComputedStyle(document.body).overscrollBehaviorX)).toBe('none')
  })
})

/** A tablet has no space bar and no keyboard shortcut for undo */
test.describe('Touch gestures', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); await onePost(page) })

  test('a two-finger tap undoes, the way a tablet does', async ({ page }) => {
    await page.evaluate(() => {
      const s = (window as any).__aluframe.store.getState()
      s.addItems([{ ...s.profiles[0], id: 'b', position: [300, 0, 0] }], [], false)
    })
    await settle(page)
    expect((await store(page)).profiles.length).toBe(2)
    await page.evaluate(() => {
      const c = document.querySelector('canvas')!
      const touch = (id: number, x: number) => ({ identifier: id, target: c, clientX: x, clientY: 500 })
      c.dispatchEvent(new TouchEvent('touchstart', {
        bubbles: true,
        touches: [new Touch(touch(1, 700)), new Touch(touch(2, 760))] as unknown as Touch[],
      }))
      c.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] }))
    })
    await settle(page)
    await page.waitForTimeout(200)
    expect((await store(page)).profiles.length).toBe(1)
  })

  test('press and hold opens the menu the space bar opens', async ({ page }) => {
    await page.evaluate(() => {
      const c = document.querySelector('canvas')!
      c.dispatchEvent(new TouchEvent('touchstart', {
        bubbles: true,
        touches: [new Touch({ identifier: 1, target: c, clientX: 800, clientY: 500 })] as unknown as Touch[],
      }))
    })
    await expect(page.getByTestId('quick-menu')).toBeVisible({ timeout: 2000 })
  })

  test('a hold that wanders is a drag, not a menu', async ({ page }) => {
    await page.evaluate(() => {
      const c = document.querySelector('canvas')!
      const t = (x: number) => [new Touch({ identifier: 1, target: c, clientX: x, clientY: 500 })] as unknown as Touch[]
      c.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: t(800) }))
      c.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: t(880) }))
    })
    await page.waitForTimeout(700)
    await expect(page.getByTestId('quick-menu')).toHaveCount(0)
  })
})

/**
 * A screen-space picker has to be generous — a member is a couple of pixels wide at any
 * useful zoom — but being generous about near misses must not mean contradicting a direct
 * hit. What is drawn at a pixel is what clicking there selects.
 */
test.describe('What you can see is what you click', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await page.evaluate(() => {
      const up = [-0.7071067811865475, 0, 0, 0.7071067811865476]
      ;(window as any).__aluframe.store.getState().loadDocument({
        profiles: [
          { id: 'u1', spec: '2020', length: 800, position: [0, 0, 0], quaternion: up, miterCuts: [], holes: [] },
          { id: 'u2', spec: '2020', length: 800, position: [600, 0, 0], quaternion: up, miterCuts: [], holes: [] },
        ],
        connectors: [],
        panels: [{ id: 'shelf', width: 560, height: 560, thickness: 18, position: [300, 400, 300],
          quaternion: [0.7071067811865476, 0, 0, 0.7071067811865476], material: 'mdf' }],
        fittings: [{ id: 'door', kind: 'door', position: [300, 400, 0], quaternion: [0, 0, 0, 1],
          width: 580, height: 760, depth: 600, material: 'mdf', open: 0,
          hinge: 'left', hingeType: 'cup', overlay: 'full', swing: 110 }],
      })
    })
    await settle(page)
    await setView(page, [800, 900, 1500], [300, 400, 150])
  })

  const pickKinds = (page: import('@playwright/test').Page, p: number[]) => page.evaluate((pt) => {
    const w = (window as any).__aluframe
    const c = w.worldToClient(pt[0], pt[1], pt[2])
    return w.pickAt(c.x, c.y).map((h: { kind: string }) => h.kind)
  }, p)

  test('the door in front wins where the door is drawn', async ({ page }) => {
    expect((await pickKinds(page, [300, 400, 0]))[0]).toBe('fitting')
  })

  test('putting the doors away gets you at the frame behind them', async ({ page }) => {
    await page.getByTestId('fittings-toggle').click()
    await settle(page)
    await page.waitForTimeout(250)
    expect((await pickKinds(page, [300, 400, 300]))[0]).toBe('panel')
  })

  test('a door put away is not clickable either', async ({ page }) => {
    await page.getByTestId('fittings-toggle').click()
    await settle(page)
    await page.waitForTimeout(250)
    expect(await pickKinds(page, [300, 400, 0])).not.toContain('fitting')
  })

  test('and it comes back', async ({ page }) => {
    await page.getByTestId('fittings-toggle').click()
    await settle(page)
    await page.getByTestId('fittings-toggle').click()
    await settle(page)
    await page.waitForTimeout(250)
    expect((await pickKinds(page, [300, 400, 0]))[0]).toBe('fitting')
  })
})

/** One arrow press is a whole edit; half a typed number is not a number */
test.describe('Nudging a number', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await page.evaluate(() => (window as any).__aluframe.store.getState().loadDocument({
      profiles: [], connectors: [],
      panels: [{ id: 'b', width: 500, height: 300, thickness: 18, position: [0, 400, 0], quaternion: [0, 0, 0, 1], material: 'mdf' }],
      fittings: [],
    }))
    await settle(page)
    await page.evaluate(() => (window as any).__aluframe.store.getState().selectItem('b', false))
    await settle(page)
  })

  const width = (page: import('@playwright/test').Page) =>
    page.evaluate(() => (window as any).__aluframe.store.getState().panels[0].width)

  test('an arrow key changes the drawing without waiting for Enter', async ({ page }) => {
    const f = page.getByTestId('panel-props').locator('input[type=number]').first()
    await f.click()
    await f.press('ArrowUp')
    await settle(page)
    await page.waitForTimeout(150)
    expect(await width(page)).toBe(510)
  })

  test('shift takes bigger steps', async ({ page }) => {
    const f = page.getByTestId('panel-props').locator('input[type=number]').first()
    await f.click()
    await f.press('Shift+ArrowUp')
    await settle(page)
    await page.waitForTimeout(150)
    expect(await width(page)).toBe(600)
  })

  test('a size follows the typing, so 560 can be told from 650 before committing to one', async ({ page }) => {
    const f = page.getByTestId('panel-props').locator('input[type=number]').first()
    await f.click()
    await f.fill('')
    await f.type('7')
    await page.waitForTimeout(200)
    expect(await width(page)).toBe(7)
    await f.type('50')
    await page.waitForTimeout(200)
    expect(await width(page)).toBe(750)
  })

  test('...and the whole edit is one step to undo', async ({ page }) => {
    const before = await page.evaluate(() => (window as any).__aluframe.store.getState().past.length)
    const f = page.getByTestId('panel-props').locator('input[type=number]').first()
    await f.click()
    await f.fill('')
    await f.type('750')
    await f.press('Enter')
    await settle(page)
    await page.waitForTimeout(200)
    expect(await page.evaluate(() => (window as any).__aluframe.store.getState().past.length)).toBe(before + 1)
    await page.keyboard.press('Control+z')
    await settle(page)
    await page.waitForTimeout(200)
    expect(await width(page)).toBe(500)
  })
})


/** A drawer is a part like any other and moves like one */
test.describe('Moving a drawer', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await page.evaluate(() => (window as any).__aluframe.store.getState().loadDocument({
      profiles: [], connectors: [], panels: [],
      fittings: [{ id: 'dr', kind: 'drawer', position: [300, 300, 0], quaternion: [0, 0, 0, 1],
        width: 560, height: 250, depth: 560, material: 'ply', open: 0 }],
    }))
    await settle(page)
    await setView(page, [1100, 900, 1600], [300, 300, 0])
  })

  test('it can be dragged', async ({ page }) => {
    await page.evaluate(() => (window as any).__aluframe.store.getState().selectItem('dr', false))
    await settle(page)
    const before = await page.evaluate(() => (window as any).__aluframe.store.getState().fittings[0].position)
    const c = await page.evaluate((p) => (window as any).__aluframe.worldToClient(p[0], p[1], p[2]), before)
    await page.mouse.move(c.x, c.y)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) { await page.mouse.move(c.x + i * 10, c.y + i * 3); await page.waitForTimeout(16) }
    await page.mouse.up()
    await page.waitForTimeout(250)
    const after = await page.evaluate(() => (window as any).__aluframe.store.getState().fittings[0].position)
    expect(after).not.toEqual(before)
  })

  test('the arrow keys nudge it too', async ({ page }) => {
    await page.evaluate(() => (window as any).__aluframe.store.getState().selectItem('dr', false))
    await settle(page)
    const before = await page.evaluate(() => (window as any).__aluframe.store.getState().fittings[0].position[0])
    await page.mouse.move(700, 500)
    await page.keyboard.press('ArrowRight')
    await settle(page)
    await page.waitForTimeout(150)
    expect(await page.evaluate(() => (window as any).__aluframe.store.getState().fittings[0].position[0])).toBe(before + 5)
  })
})
