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
