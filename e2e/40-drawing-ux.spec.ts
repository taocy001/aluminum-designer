import { test, expect, type Page } from '@playwright/test'
import { openApp, enterDraw, clickWorld, hoverWorld, store, w2c, settle } from './helpers'

async function drawing(page: Page) {
  return page.evaluate(() => {
    const w = (window as any).__aluframe, t = w.tool.getState()
    let ghost: any = null
    w.sceneRoot.traverseVisible((object: any) => {
      if (object.userData.drawingPreview) ghost = { profile: object.userData.previewProfile,
        position: object.position.toArray(), cutLength: object.scale.z }
    })
    return { active: t.isDrawing, axis: t.drawAxis, lock: t.lockedAxis, spec: t.activeSpec,
      start: t.startPoint?.toArray(), end: t.currentPoint?.toArray(), typed: t.drawLengthInput, ghost }
  })
}

test.describe('Drawing responds to keyboard and view changes without another mouse move', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); await enterDraw(page, '2020') })

  for (const axis of ['x', 'y', 'z'] as const) test(`a stationary ${axis.toUpperCase()} lock governs the preview and an immediate exact Enter`, async ({ page }) => {
    await clickWorld(page, [0, 0, 0])
    await hoverWorld(page, axis === 'x' ? [0, 10, 400] : [400, 10, 0])
    expect((await drawing(page)).axis).not.toBe(axis)
    // No pointer event between the lock, numeric entry and commit.
    await page.keyboard.press(axis)
    expect((await drawing(page)).axis).toBe(axis)
    expect((await drawing(page)).lock).toBe(axis)
    await page.keyboard.type('600')
    await expect.poll(async () => (await drawing(page)).ghost?.cutLength).toBeCloseTo(600)
    const preview = await drawing(page)
    expect(preview.ghost.cutLength).toBeCloseTo(600)
    await page.screenshot({ path: test.info().outputPath(`stationary-${axis}-lock.png`) })
    await page.keyboard.press('Enter')
    const profiles = (await store(page)).profiles
    expect(profiles).toHaveLength(1)
    expect(profiles[0].position).toEqual(preview.ghost.profile.position)
    expect(profiles[0].quaternion).toEqual(preview.ghost.profile.quaternion)
    expect(profiles[0].length).toBeCloseTo(600)
    const direction = await page.evaluate(() => {
      const w = (window as any).__aluframe, p = w.store.getState().profiles[0]
      return new w.THREE.Vector3(0, 0, 1).applyQuaternion(new w.THREE.Quaternion(...p.quaternion)).toArray()
    })
    expect(Math.abs(direction[['x', 'y', 'z'].indexOf(axis)])).toBeCloseTo(1)
  })

  test('unlocking an axis restores the pointer-selected direction immediately', async ({ page }) => {
    await clickWorld(page, [0, 0, 0])
    await hoverWorld(page, [0, 10, 400])
    const before = await drawing(page)
    expect(before.axis).toBe('z')
    await page.keyboard.press('x')
    expect((await drawing(page)).axis).toBe('x')
    await page.keyboard.press('x')
    const unlocked = await drawing(page)
    expect(unlocked.lock).toBeNull()
    expect(unlocked.axis).toBe('z')
    expect(unlocked.end).toEqual(before.end)
  })

  test('switching section keeps the draft and exact length while updating its floor height', async ({ page }) => {
    await clickWorld(page, [0, 0, 0])
    await hoverWorld(page, [400, 10, 0])
    await page.keyboard.type('350')
    await page.getByTestId('spec-4040').click()
    await settle(page)
    const changed = await drawing(page)
    expect(changed.active).toBe(true)
    expect(changed.spec).toBe('4040')
    expect(changed.typed).toBe('350')
    expect(changed.start[1]).toBeCloseTo(20)
    expect(changed.ghost.cutLength).toBeCloseTo(350)
    expect(changed.ghost.position[1]).toBeCloseTo(20)
    await page.getByTestId('precise-input').press('Enter')
    const profiles = (await store(page)).profiles
    expect(profiles).toHaveLength(1)
    expect(profiles[0].spec).toBe('4040')
    expect(profiles[0].position[1]).toBeCloseTo(20)
    expect(profiles[0].length).toBeCloseTo(350)
  })

  test('wheel zoom refreshes the stationary canvas endpoint before its next click', async ({ page }) => {
    await clickWorld(page, [0, 0, 0])
    await hoverWorld(page, [400, 10, 0])
    await page.keyboard.press('x')
    const cursor = await w2c(page, [400, 10, 0])
    const before = await drawing(page)
    await page.mouse.wheel(0, 650)
    await expect.poll(async () => (await drawing(page)).end[0]).not.toBe(before.end[0])
    await page.waitForTimeout(300)
    const zoomed = await drawing(page)
    expect(zoomed.active).toBe(true)
    expect(zoomed.axis).toBe('x')
    expect(zoomed.ghost.cutLength).not.toBe(before.ghost.cutLength)
    await page.mouse.click(cursor.x, cursor.y)
    const profiles = (await store(page)).profiles
    expect(profiles).toHaveLength(1)
    expect(profiles[0].position).toEqual(zoomed.ghost.profile.position)
    expect(profiles[0].length).toBeCloseTo(zoomed.ghost.profile.length)
  })

  test('pointer cancellation cannot place a point and restores stationary wheel refresh', async ({ page }) => {
    const cancelPointer = () => page.evaluate(() => {
      document.querySelector('canvas')!.dispatchEvent(new PointerEvent('pointercancel', {
        bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0,
      }))
    })
    await hoverWorld(page, [0, 0, 0])
    await page.mouse.down()
    await cancelPointer()
    await page.mouse.up()
    expect((await drawing(page)).active).toBe(false)
    expect((await store(page)).profiles).toHaveLength(0)

    await clickWorld(page, [0, 0, 0])
    await hoverWorld(page, [400, 10, 0])
    await page.keyboard.press('x')
    const before = await drawing(page)
    await page.mouse.down()
    await cancelPointer()
    // No pointerup or pointermove may repair stale button state before this zoom.
    await page.mouse.wheel(0, 650)
    await expect.poll(async () => (await drawing(page)).end[0]).not.toBe(before.end[0])
    expect((await drawing(page)).active).toBe(true)
    expect((await store(page)).profiles).toHaveLength(0)
    await page.mouse.up()
    await settle(page)
    expect((await drawing(page)).active).toBe(true)
    expect((await store(page)).profiles).toHaveLength(0)
  })

  test('toolbar zoom preserves a draft without steering it toward the toolbar pointer', async ({ page }) => {
    await clickWorld(page, [0, 0, 0])
    await hoverWorld(page, [400, 10, 0])
    await page.keyboard.type('350')
    await expect.poll(async () => (await drawing(page)).ghost?.cutLength).toBeCloseTo(350)
    const before = await drawing(page)
    await page.getByTestId('zoom-out').click()
    await page.waitForTimeout(300)
    const after = await drawing(page)
    expect(after.active).toBe(true)
    expect(after.typed).toBe('350')
    expect(after.start).toEqual(before.start)
    expect(after.end).toEqual(before.end)
    expect(after.ghost.position).toEqual(before.ghost.position)
    expect(after.ghost.cutLength).toBeCloseTo(before.ghost.cutLength)
    await page.getByTestId('precise-input').press('Enter')
    expect((await store(page)).profiles).toHaveLength(1)
    expect((await store(page)).profiles[0].length).toBeCloseTo(350)
  })
})
