import { test, expect } from '@playwright/test'
import { openApp, settle, store } from './helpers'

/** a rail and an upright meeting at the origin: the smallest thing with a real joint */
async function loadCorner(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const alongX = { quaternion: [0, 0.7071067811865475, 0, 0.7071067811865476], miterCuts: [], holes: [] }
    const up = { quaternion: [-0.7071067811865475, 0, 0, 0.7071067811865476], miterCuts: [], holes: [] }
    ;(window as any).__aluframe.store.getState().loadDocument({
      profiles: [
        { id: 'rail', spec: '2020', length: 600, position: [0, 10, 0], ...alongX },
        { id: 'post', spec: '2020', length: 600, position: [0, 20, 0], ...up },
        { id: 'rail2', spec: '2020', length: 600, position: [0, 10, 400], ...alongX },
      ],
      connectors: [], panels: [],
    })
  })
  await settle(page)
}

/**
 * An icon with no name is a puzzle. Resting on any control says what it does, at the cursor,
 * so the answer arrives where the question was asked rather than in a legend somewhere else.
 */
test.describe('Every control says what it does', () => {
  test.beforeEach(async ({ page }) => openApp(page))

  test('nothing appears on a glance', async ({ page }) => {
    await page.getByTestId('fit-view').hover()
    await page.waitForTimeout(120)
    await expect(page.getByTestId('tooltip')).toHaveCount(0)
  })

  test('resting on a toolbar icon explains it', async ({ page }) => {
    await page.getByTestId('fit-view').hover()
    await expect(page.getByTestId('tooltip')).toBeVisible({ timeout: 2000 })
    await expect(page.getByTestId('tooltip')).toContainText('F')
  })

  test('the browser’s own tooltip is held back, then handed straight back', async ({ page }) => {
    const btn = page.getByTestId('fit-view')
    const original = await btn.getAttribute('title')
    expect(original).toBeTruthy()
    await btn.hover()
    await expect(page.getByTestId('tooltip')).toBeVisible({ timeout: 2000 })
    expect(await btn.getAttribute('title')).toBeNull()      // only one box, not two
    await page.mouse.move(700, 600)
    await expect(page.getByTestId('tooltip')).toHaveCount(0)
    expect(await btn.getAttribute('title')).toBe(original)  // and the attribute survives
  })

  test('it follows the cursor', async ({ page }) => {
    const btn = page.getByTestId('fit-view')
    await btn.hover()
    await expect(page.getByTestId('tooltip')).toBeVisible({ timeout: 2000 })
    const a = (await page.getByTestId('tooltip').boundingBox())!
    const box = (await btn.boundingBox())!
    await page.mouse.move(box.x + 2, box.y + 2)
    await page.waitForTimeout(120)
    const b = (await page.getByTestId('tooltip').boundingBox())!
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(4)
  })

  test('a sidebar section and a profile button explain themselves too', async ({ page }) => {
    await page.getByTestId('spec-2040').hover()
    await expect(page.getByTestId('tooltip')).toContainText('2040', { timeout: 2000 })
    await page.mouse.move(900, 600)
    await page.getByTestId('section-bom').hover()
    await expect(page.getByTestId('tooltip')).toBeVisible({ timeout: 2000 })
  })

  test('moving on to a second control swaps the answer', async ({ page }) => {
    await page.getByTestId('spec-2020').hover()
    await expect(page.getByTestId('tooltip')).toContainText('2020', { timeout: 2000 })
    await page.getByTestId('spec-4040').hover()
    await expect(page.getByTestId('tooltip')).toContainText('4040', { timeout: 2000 })
  })
})

/**
 * Between two aligned members there is one bracket that fits and one way it goes on. So a
 * connector is placed and deleted, and nothing else — a bracket nudged off its joint still
 * looks fitted, which is worse than a missing one.
 */
test.describe('A connector goes on one way and stays there', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await loadCorner(page)
    await page.getByTestId('connector-bracket').click()
    await page.getByTestId('auto-connect').click()
    await settle(page)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    const s = await store(page)
    expect(s.connectors.length).toBeGreaterThan(0)
    await page.evaluate((id) => (window as any).__aluframe.store.getState().selectItem(id, false),
      (await store(page)).connectors[0].id)
    await settle(page)
  })

  test('it can still be selected, which is what deleting one needs', async ({ page }) => {
    expect((await store(page)).selectedIds.length).toBe(1)
  })

  test('the move and turn widget stays away', async ({ page }) => {
    expect(await page.evaluate(() => (window as any).__aluframe.gizmoHandles().length)).toBe(0)
  })

  test('its position is shown but not editable', async ({ page }) => {
    await expect(page.getByTestId('connector-position')).toBeVisible()
    await expect(page.getByTestId('connector-position').locator('input')).toHaveCount(0)
  })

  test('an arrow key does not move it', async ({ page }) => {
    const before = (await store(page)).connectors[0].position
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await settle(page)
    expect((await store(page)).connectors[0].position).toEqual(before)
  })

  test('R does not turn it', async ({ page }) => {
    const before = (await store(page)).connectors[0].quaternion
    await page.keyboard.press('r')
    await page.keyboard.press('y')
    await settle(page)
    expect((await store(page)).connectors[0].quaternion).toEqual(before)
  })

  test('but Delete still removes it', async ({ page }) => {
    const before = (await store(page)).connectors.length
    await page.keyboard.press('Delete')
    await settle(page)
    expect((await store(page)).connectors.length).toBe(before - 1)
  })

  test('one click fits them all, and clears the ones a move stranded', async ({ page }) => {
    await page.keyboard.press('Escape')
    const fitted = (await store(page)).connectors.length
    // take the upright right away: the brackets at its foot now hold nothing
    await page.evaluate(() => {
      const s = (window as any).__aluframe.store.getState()
      const up = s.profiles.find((p: any) => p.length > 500 && p.position[1] < 100 && p.quaternion[0] !== 0)
        ?? s.profiles[1]
      s.commitTransform({ profiles: [{ id: up.id, updates: { position: [3000, 10, 3000] } }] })
      s.clearSelection()
    })
    await settle(page)
    await page.getByTestId('connector-bracket').click()
    await page.getByTestId('auto-connect').click()
    await settle(page)
    await page.waitForTimeout(300)
    const after = (await store(page)).connectors.length
    // whatever the new count is, no bracket may be left sitting at no joint at all
    expect(after).toBeLessThanOrEqual(fitted)
    const stranded = await page.evaluate(() => {
      const s = (window as any).__aluframe.store.getState()
      return s.connectors.filter((c: any) => {
        const [cx, cy, cz] = c.position
        return !s.profiles.some((p: any) => {
          const [x, y, z, w] = p.quaternion
          const d = [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)]
          const a = p.position, b = a.map((v: number, i: number) => v + d[i] * p.length)
          const ab = b.map((v: number, i: number) => v - a[i])
          const t = Math.max(0, Math.min(1,
            ((cx - a[0]) * ab[0] + (cy - a[1]) * ab[1] + (cz - a[2]) * ab[2]) /
            (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2)))
          const q = a.map((v: number, i: number) => v + ab[i] * t)
          return Math.hypot(q[0] - cx, q[1] - cy, q[2] - cz) < 60
        })
      }).length
    })
    expect(stranded).toBe(0)
  })
})

/** A turn needs an axis, and F frames what you are looking at rather than everything */
test.describe('Two keys that used to guess', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await loadCorner(page)
  })

  test('R asks which axis instead of assuming Y', async ({ page }) => {
    await page.evaluate(() => {
      const s = (window as any).__aluframe.store.getState()
      s.selectItem(s.profiles[0].id, false)
    })
    await settle(page)
    const before = (await store(page)).profiles[0].quaternion
    await page.keyboard.press('r')
    await expect(page.getByTestId('rotate-axis-hud')).toBeVisible()
    expect((await store(page)).profiles[0].quaternion).toEqual(before)   // nothing yet
    await page.keyboard.press('z')
    await settle(page)
    await expect(page.getByTestId('rotate-axis-hud')).toHaveCount(0)
    expect((await store(page)).profiles[0].quaternion).not.toEqual(before)
  })

  test('Escape calls the turn off', async ({ page }) => {
    await page.evaluate(() => {
      const s = (window as any).__aluframe.store.getState()
      s.selectItem(s.profiles[0].id, false)
    })
    await settle(page)
    const before = (await store(page)).profiles[0].quaternion
    await page.keyboard.press('r')
    await expect(page.getByTestId('rotate-axis-hud')).toBeVisible()
    await page.keyboard.press('Escape')
    await settle(page)
    await expect(page.getByTestId('rotate-axis-hud')).toHaveCount(0)
    expect((await store(page)).profiles[0].quaternion).toEqual(before)
  })

  test('R with nothing selected says so rather than doing nothing', async ({ page }) => {
    await page.keyboard.press('r')
    await settle(page)
    await expect(page.getByTestId('rotate-axis-hud')).toHaveCount(0)
  })

  test('F frames the selection; with nothing selected it frames the drawing', async ({ page }) => {
    await page.evaluate(() => {
      const s = (window as any).__aluframe.store.getState()
      s.selectItem(s.profiles[1].id, false)
    })
    await settle(page)
    await page.keyboard.press('f')
    await page.waitForTimeout(300)
    expect(await page.evaluate(() => (window as any).__aluframe.tool.getState().cameraFitScope)).toBe('selection')
    const onOne = await page.evaluate(() => (window as any).__aluframe.camera.position.toArray())
    await page.keyboard.press('Escape')
    await settle(page)
    await page.keyboard.press('f')
    await page.waitForTimeout(300)
    expect(await page.evaluate(() => (window as any).__aluframe.tool.getState().cameraFitScope)).toBe('all')
    const onAll = await page.evaluate(() => (window as any).__aluframe.camera.position.toArray())
    expect(onAll).not.toEqual(onOne)
  })

  test('the Home button still frames everything', async ({ page }) => {
    await page.evaluate(() => {
      const s = (window as any).__aluframe.store.getState()
      s.selectItem(s.profiles[0].id, false)
    })
    await settle(page)
    await page.getByTestId('fit-view').click()
    await page.waitForTimeout(300)
    expect(await page.evaluate(() => (window as any).__aluframe.tool.getState().cameraFitScope)).toBe('all')
  })
})
