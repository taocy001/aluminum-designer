import { test, expect } from '@playwright/test'
import { chooseConnector, openApp, settle, setView, store } from './helpers'

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

/** Controls show a custom tooltip at the pointer. */
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
    await page.getByTestId('sidebar-tab-inspect').click()
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

test.describe('A connector can be positioned independently', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await loadCorner(page)
    await chooseConnector(page, 'bracket')
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

  test('the move and turn widget is available', async ({ page }) => {
    expect(await page.evaluate(() => (window as any).__aluframe.gizmoHandles().length)).toBe(6)
  })

  test('its position and orientation are editable', async ({ page }) => {
    await expect(page.getByTestId('connector-position')).toBeVisible()
    await expect(page.getByTestId('connector-position').locator('input')).toHaveCount(3)
    await expect(page.getByTestId('connector-orientation').locator('input')).toHaveCount(3)
  })

  test('arrow keys move it and undo restores the seat', async ({ page }) => {
    const before = (await store(page)).connectors[0].position
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await settle(page)
    expect((await store(page)).connectors[0].position).not.toEqual(before)
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+z')
    expect((await store(page)).connectors[0].position).toEqual(before)
  })

  test('R turns it and undo restores the angle', async ({ page }) => {
    const before = (await store(page)).connectors[0].quaternion
    await page.keyboard.press('r')
    await page.keyboard.press('y')
    await settle(page)
    expect((await store(page)).connectors[0].quaternion).not.toEqual(before)
    await page.keyboard.press('Control+z')
    expect((await store(page)).connectors[0].quaternion).toEqual(before)
  })

  test('but Delete still removes it', async ({ page }) => {
    const before = (await store(page)).connectors.length
    await page.keyboard.press('Delete')
    await settle(page)
    expect((await store(page)).connectors.length).toBe(before - 1)
  })

  test('automatic placement preserves moved connectors and fills only vacant seats', async ({ page }) => {
    const installed = (await store(page)).connectors[0]
    const positionX = page.getByTestId('connector-position').locator('input').nth(0)
    await positionX.fill('3000')
    await positionX.press('Enter')
    await settle(page)
    await page.keyboard.press('Escape')
    const moved = await store(page)
    expect(moved.connectors.find((c) => c.id === installed.id)?.position[0]).toBe(3000)

    await chooseConnector(page, 'bracket')
    await page.getByTestId('auto-connect').click()
    await settle(page)
    const filled = await store(page)
    expect(filled.connectors.length).toBe(moved.connectors.length + 1)
    expect(filled.past).toBe(moved.past + 1)
    for (const existing of moved.connectors) {
      expect(filled.connectors.find((c) => c.id === existing.id)).toEqual(existing)
    }
    const added = filled.connectors.find((c) => !moved.connectors.some((existing) => existing.id === c.id))
    expect(added).toMatchObject({ type: installed.type, series: installed.series,
      position: installed.position, quaternion: installed.quaternion })

    // Added parts open Properties; keep the active connector while returning to Add.
    await page.getByTestId('sidebar-tab-add').click()
    await page.getByTestId('auto-connect').click()
    await settle(page)
    expect((await store(page)).connectors).toEqual(filled.connectors)
    expect((await store(page)).past).toBe(filled.past)

    await page.keyboard.press('Escape')
    await page.getByTestId('viewport').focus()
    await page.keyboard.press('Control+z')
    expect((await store(page)).connectors).toEqual(moved.connectors)
  })
})

test('an installed inner bracket previews and switches 2040 slots in one undo step', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => {
    const member = (id: string, quaternion: number[]) => ({ id, spec: '2040', length: 300,
      position: [0, 100, 0], quaternion, miterCuts: [], holes: [] })
    ;(window as any).__aluframe.store.getState().loadDocument({
      profiles: [member('rail', [0.5, 0.5, 0.5, 0.5]), member('post', [-Math.SQRT1_2, 0, 0, Math.SQRT1_2])],
      connectors: [], panels: [], fittings: [], equipment: [], throughRule: 'rails',
    })
  })
  await settle(page)
  await chooseConnector(page, 'inside-corner')
  await page.getByTestId('auto-connect').click()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  const before = await page.evaluate(() => {
    const app = (window as any).__aluframe, c = app.store.getState().connectors.find((part: any) => part.type === 'inside-corner')
    if (!c) throw new Error('Inner bracket not installed')
    app.store.setState({ connectors: [c], selectedIds: [c.id], past: [], future: [] })
    return c
  })
  await settle(page)
  await page.getByTestId('connector-reseat').click()
  const choices = page.getByTestId('connector-seat-option')
  await expect.poll(() => choices.count()).toBeGreaterThanOrEqual(2)
  const current = page.locator('[data-testid="connector-seat-option"][aria-pressed="true"]')
  await expect(current).toHaveAttribute('data-allowed', 'true')
  const other = page.locator('[data-testid="connector-seat-option"][aria-pressed="false"][data-allowed="true"]').first()
  await other.click()
  const picked = await current.textContent()
  await settle(page)
  const preview = await page.evaluate(() => {
    let legs: string[] | null = null
    const slots: string[] = []
    ;(window as any).__aluframe.sceneRoot.traverse((object: any) => {
      if (object.userData.connectorEditPreview) legs = object.userData.seatLegs
      if (object.userData.connectorSlotGuide) slots.push(object.userData.profileId)
    })
    return { legs, slots }
  })
  expect(preview.legs?.sort()).toEqual(['post', 'rail'])
  expect(preview.slots.sort()).toEqual(['post', 'rail'])
  await setView(page, [-1300, 1000, -1600], [0, 100, 0])
  await expect(current).toHaveText(picked!)
  await page.getByTestId('connector-seat-apply').click()
  await expect(page.getByTestId('connector-reseat')).toHaveAttribute('aria-expanded', 'false')
  expect((await store(page)).connectors[0].position).not.toEqual(before.position)
  expect((await store(page)).past).toBe(1)
  await page.getByTestId('viewport').focus()
  await page.keyboard.press('Control+z')
  expect((await store(page)).connectors[0]).toEqual(before)
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
