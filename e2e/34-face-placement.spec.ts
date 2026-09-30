import { test, expect, type Page } from '@playwright/test'
import { openApp, setView, enterDraw, clickWorld, hoverWorld, settle, store } from './helpers'

async function seedAndChooseSide(page: Page, side: -1 | 1) {
  await page.evaluate(() => {
    const w = (window as any).__aluframe
    w.tool.getState().putDown()
    w.store.getState().loadDocument({ profiles: [{ id: 'post', spec: '4040', length: 800,
      position: [0, 0, 0], quaternion: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], holes: [], miterCuts: [] }],
    connectors: [], panels: [], fittings: [], throughRule: 'rails' })
    w.store.getState().clearSelection()
  })
  await setView(page, [1400, 850, side * 1600], [200, 400, 0])
  await enterDraw(page, '2020')
  await clickWorld(page, [0, 400, side * 20])
  await expect.poll(() => page.evaluate(() => (window as any).__aluframe.tool.getState().isDrawing)).toBe(true)
  const start = await page.evaluate(() => {
    const t = (window as any).__aluframe.tool.getState()
    return { point: t.startPoint.toArray(), face: t.drawStartFace }
  })
  expect(start.face).toEqual({ profileId: 'post', axis: 1, side: -side })
  return start.point as [number, number, number]
}

async function shownMember(page: Page, preview: boolean) {
  return page.evaluate((isPreview) => {
    const w = (window as any).__aluframe
    const member = w.store.getState().profiles.find((p: any) => p.id !== 'post')
    let result: any = null
    w.sceneRoot.traverseVisible((o: any) => {
      if (isPreview ? o.userData.drawingPreview : member && o.isMesh && o.userData.profileId === member.id) {
        result = { position: o.position.toArray(), quaternion: o.quaternion.toArray(), cutLength: o.scale.z,
          profile: isPreview ? o.userData.previewProfile : member }
      }
    })
    return result
  }, preview)
}

test.describe('The chosen attachment face controls the actual member', () => {
  test.beforeEach(async ({ page }) => { await openApp(page) })

  for (const side of [1, -1] as const) test(`choosing the ${side > 0 ? '+Z' : '−Z'} face places and previews on that same side`, async ({ page }) => {
    const start = await seedAndChooseSide(page, side)
    const end: [number, number, number] = [600, start[1], 0]
    await hoverWorld(page, end)
    await expect.poll(async () => (await shownMember(page, true))?.profile.position[2]).toBe(side * 10)
    const ghost = await shownMember(page, true)
    const before = await store(page)
    await page.screenshot({ path: test.info().outputPath(`selected-face-${side}.png`) })
    await clickWorld(page, end)
    await expect.poll(async () => (await store(page)).profiles.length).toBe(2)
    await expect.poll(async () => (await shownMember(page, false))?.profile.position[2]).toBe(side * 10)
    const placed = await shownMember(page, false)
    for (let i = 0; i < 3; i++) expect(placed.position[i]).toBeCloseTo(ghost.position[i], 5)
    expect(placed.quaternion).toEqual(ghost.quaternion)
    expect(placed.cutLength).toBeCloseTo(ghost.cutLength, 5)
    expect((await store(page)).past).toBe(before.past + 1)
    await page.keyboard.press('Control+z')
    expect((await store(page)).profiles).toHaveLength(1)
  })

  for (const side of [1, -1] as const) test(`an exact length retains the selected ${side > 0 ? '+Z' : '−Z'} side and means actual cut length`, async ({ page }) => {
    const start = await seedAndChooseSide(page, side)
    await hoverWorld(page, [600, start[1], 0])
    await page.getByTestId('precise-input').fill('600')
    await expect.poll(async () => (await shownMember(page, true))?.cutLength).toBe(600)
    await expect(page.getByTestId('draw-length')).toHaveText('600 mm')
    const ghost = await shownMember(page, true)
    await page.getByTestId('precise-input').press('Enter')
    await expect.poll(async () => (await store(page)).profiles.length).toBe(2)
    await expect.poll(async () => (await shownMember(page, false))?.cutLength).toBe(600)
    expect((await shownMember(page, false)).profile.position[2]).toBe(side * 10)
    const placed = await shownMember(page, false)
    expect(placed.position).toEqual(ghost.position)
    expect(placed.quaternion).toEqual(ghost.quaternion)
    expect(placed.cutLength).toBe(ghost.cutLength)
  })

  test('invalid numeric input hides the solid preview and can be corrected before committing', async ({ page }) => {
    const start = await seedAndChooseSide(page, 1)
    await hoverWorld(page, [600, start[1], 0])
    const before = await store(page)
    const input = page.getByTestId('precise-input')
    await input.fill('5')
    await expect(input).toHaveAttribute('aria-invalid', 'true')
    await expect.poll(() => shownMember(page, true)).toBeNull()
    await expect(page.getByTestId('face-placement-status')).toContainText('最小 10 mm')
    await expect(input.locator('..').getByRole('button')).toBeDisabled()
    await input.press('Enter')
    expect((await store(page)).profiles).toHaveLength(1)
    expect((await store(page)).past).toBe(before.past)
    await input.fill('640')
    await expect.poll(async () => (await shownMember(page, true))?.cutLength).toBe(640)
    await expect(page.getByTestId('face-placement-status')).toBeHidden()
    await input.press('Enter')
    await expect.poll(async () => (await shownMember(page, false))?.cutLength).toBe(640)
  })

  test('a canvas click commits the same numeric preview as Enter', async ({ page }) => {
    const start = await seedAndChooseSide(page, 1)
    const end: [number, number, number] = [600, start[1], 0]
    await hoverWorld(page, end)
    await page.getByTestId('precise-input').fill('720')
    await expect.poll(async () => (await shownMember(page, true))?.cutLength).toBe(720)
    const ghost = await shownMember(page, true)
    await clickWorld(page, end)
    await expect.poll(async () => (await shownMember(page, false))?.cutLength).toBe(720)
    expect((await shownMember(page, false)).position).toEqual(ghost.position)
  })

  test('drawing outward puts the actual cut end on the selected face', async ({ page }) => {
    const start = await seedAndChooseSide(page, 1)
    await page.keyboard.press('z')
    const end: [number, number, number] = [0, start[1], 600]
    await hoverWorld(page, end)
    await expect.poll(async () => (await shownMember(page, true))?.position[2]).toBe(20)
    const ghost = await shownMember(page, true)
    await clickWorld(page, end)
    await expect.poll(async () => (await shownMember(page, false))?.position[2]).toBe(20)
    expect((await shownMember(page, false)).cutLength).toBeCloseTo(ghost.cutLength, 5)
  })

  test('drawing behind the chosen face is explained and cannot silently switch the attachment', async ({ page }) => {
    const start = await seedAndChooseSide(page, 1)
    const before = await store(page)
    await page.keyboard.press('z')
    await hoverWorld(page, [0, start[1], -600])
    await expect(page.getByTestId('face-placement-status')).toContainText('向外绘制')
    await clickWorld(page, [0, start[1], -600])
    expect((await store(page)).profiles).toHaveLength(1)
    expect((await store(page)).past).toBe(before.past)
    expect(await page.evaluate(() => (window as any).__aluframe.tool.getState().drawStartFace)).toEqual({ profileId: 'post', axis: 1, side: -1 })
    await hoverWorld(page, [0, start[1], 600])
    await expect(page.getByTestId('face-placement-status')).toBeHidden()
    await clickWorld(page, [0, start[1], 600])
    await settle(page)
    expect((await store(page)).profiles).toHaveLength(2)
  })
})
