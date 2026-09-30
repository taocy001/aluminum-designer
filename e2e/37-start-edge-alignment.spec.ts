import { test, expect, type Page } from '@playwright/test'
import { openApp, setView, enterDraw, clickWorld, hoverWorld, settle, store } from './helpers'

async function seed(page: Page, corner = false, spec = '2020') {
  await page.evaluate((corner) => {
    const w = (window as any).__aluframe
    w.tool.getState().putDown()
    const base = { spec: '4040', length: 500, holes: [], miterCuts: [], fixedTrims: { start: 0, end: 0 } }
    w.store.getState().loadDocument({ profiles: [
      { ...base, id: 'a', position: [0, 400, 0], quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2], fixedTrims: { start: 0, end: corner ? 20 : 0 } },
      corner ? { ...base, id: 'b', position: [500, 400, 0], quaternion: [0, 0, 0, 1] }
        : { ...base, id: 'b', position: [500, 400, 0], quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2] },
    ], connectors: [], panels: [], fittings: [], throughRule: 'rails' })
    w.store.getState().clearSelection()
  }, corner)
  await setView(page, [1300, 1400, 1400], [450, 400, 50])
  await enterDraw(page, spec)
}

async function drawing(page: Page) {
  return page.evaluate(() => {
    const w = (window as any).__aluframe, t = w.tool.getState()
    let ghost: any = null
    const contacts: any[] = []
    w.sceneRoot.traverseVisible((o: any) => {
      if (o.userData.drawingPreview) ghost = { profile: o.userData.previewProfile, position: o.position.toArray(), cut: o.scale.z }
      if (o.userData.drawingContact) contacts.push(o.userData)
    })
    return { ghost, contacts, start: t.drawStartFace, alignment: t.drawStartAlignmentFace,
      hover: t.drawSnapFace, hoverAlignment: t.drawSnapAlignmentFace }
  })
}

test.describe('Drawing upright from an existing horizontal joint', () => {
  test.beforeEach(async ({ page }) => { await openApp(page) })

  for (const side of ['left', 'right'] as const) test(`the ${side} side of a butt joint puts the upright side flush with the seam`, async ({ page }) => {
    await seed(page)
    const x = side === 'left' ? 490 : 510
    const target = side === 'left' ? 'a' : 'b'
    await hoverWorld(page, [x, 420, 0])
    await expect(page.getByTestId('start-edge-kind')).toContainText('端面齐边')
    expect((await drawing(page)).hoverAlignment.profileId).toBe(target)
    expect((await drawing(page)).hover.axis).not.toBe(2)
    await clickWorld(page, [x, 420, 0])
    await page.keyboard.press('y')
    await hoverWorld(page, [x, 900, 0])
    await expect(page.getByTestId('draw-start-contact')).toContainText('贴合')
    await expect(page.getByTestId('draw-start-alignment')).toContainText('端面齐边')
    const preview = await drawing(page)
    expect(preview.ghost.position[0]).toBeCloseTo(x)
    expect(preview.ghost.position[1]).toBeCloseTo(420)
    const alignment = preview.contacts.find((c) => c.purpose === 'alignment')
    expect(alignment.referenceFace.profileId).toBe(target)
    expect(alignment.kind).toBe('align')
    expect(alignment.patch).toBeNull()
    expect(alignment.referenceAnchor[0]).toBeCloseTo(500)
    expect(alignment.memberAnchor[0]).toBeCloseTo(500)
    const before = await store(page)
    await page.screenshot({ path: test.info().outputPath(`butt-${side}-upright.png`) })
    await clickWorld(page, [x, 900, 0])
    const after = await store(page)
    expect(after.profiles.slice(0, 2)).toEqual(before.profiles)
    expect(after.profiles[2].position).toEqual(preview.ghost.profile.position)
    expect(after.profiles[2].fixedTrims).toEqual(preview.ghost.profile.fixedTrims)
    expect(after.past).toBe(before.past + 1)
    await page.keyboard.press('Control+z')
    expect((await store(page)).profiles).toEqual(before.profiles)
  })

  test('a trimmed L joint uses its actual end plane and preserves an exact physical length', async ({ page }) => {
    await seed(page, true)
    await hoverWorld(page, [475, 420, -5])
    await expect(page.getByTestId('start-edge-kind')).toContainText('端面齐边')
    await clickWorld(page, [475, 420, -5])
    await page.keyboard.press('y')
    await hoverWorld(page, [470, 900, 0])
    await page.getByTestId('precise-input').fill('365')
    await expect(page.getByTestId('draw-length')).toHaveText('365 mm')
    await expect(page.getByTestId('draw-start-alignment')).toContainText('端面齐边')
    const preview = await drawing(page)
    expect(preview.ghost.position[0]).toBeCloseTo(470)
    expect(preview.ghost.position[1]).toBeCloseTo(420)
    const alignment = preview.contacts.find((c) => c.purpose === 'alignment')
    expect(alignment.referenceAnchor[0]).toBeCloseTo(480)
    expect(alignment.memberAnchor[0]).toBeCloseTo(480)
    const before = await store(page)
    await page.screenshot({ path: test.info().outputPath('trimmed-corner-upright.png') })
    await page.getByTestId('precise-input').press('Enter')
    const after = await store(page)
    expect(after.profiles.slice(0, 2)).toEqual(before.profiles)
    expect(after.profiles[2].position).toEqual(preview.ghost.profile.position)
    expect(after.profiles[2].length).toEqual(preview.ghost.profile.length)
    expect(after.profiles[2].fixedTrims).toEqual(preview.ghost.profile.fixedTrims)
    expect(after.past).toBe(before.past + 1)
  })

  test('hover departure and cancelling a draw clear the extra end-plane reference', async ({ page }) => {
    await seed(page)
    await hoverWorld(page, [490, 420, 0])
    await expect(page.getByTestId('start-edge-kind')).toBeVisible()
    await hoverWorld(page, [200, 420, 0])
    await expect(page.getByTestId('start-edge-kind')).toBeHidden()
    expect((await drawing(page)).hoverAlignment).toBeNull()
    await clickWorld(page, [490, 420, 0])
    await page.keyboard.press('y')
    await hoverWorld(page, [490, 900, 0])
    await expect(page.getByTestId('draw-start-alignment')).toBeVisible()
    await page.keyboard.press('Escape')
    await settle(page)
    expect((await drawing(page)).alignment).toBeNull()
    expect((await drawing(page)).contacts).toEqual([])
    await clickWorld(page, [-200, 0, 500])
    await hoverWorld(page, [-200, 400, 500])
    expect((await drawing(page)).alignment).toBeNull()
    await expect(page.getByTestId('draw-start-alignment')).toBeHidden()
  })
})
