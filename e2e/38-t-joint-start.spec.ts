import { test, expect, type Page } from '@playwright/test'
import { openApp, setView, enterDraw, hoverWorld, clickWorld, store, settle } from './helpers'

async function seed(page: Page) {
  await page.evaluate(() => {
    const w = (window as any).__aluframe
    w.tool.getState().putDown()
    const base = { spec: '4040', holes: [], miterCuts: [], fixedTrims: { start: 0, end: 0 } }
    w.store.getState().loadDocument({ profiles: [
      { ...base, id: 'through', length: 1000, position: [0, 400, 0], quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2] },
      { ...base, id: 'branch', length: 500, position: [500, 400, 0], quaternion: [0, 0, 0, 1], fixedTrims: { start: 20, end: 0 } },
    ], connectors: [], panels: [], fittings: [], throughRule: 'rails' })
    w.store.getState().clearSelection()
  })
  await setView(page, [1300, 1400, 1400], [450, 400, 50])
}
async function feedback(page: Page) {
  return page.evaluate(() => {
    const w = (window as any).__aluframe, t = w.tool.getState()
    let ghost: any = null
    const contacts: any[] = [], startMarkers: any[] = []
    w.sceneRoot.traverseVisible((o: any) => {
      if (o.userData.drawingPreview) ghost = { profile: o.userData.previewProfile, position: o.position.toArray(), cut: o.scale.z }
      if (o.userData.drawingContact) contacts.push(o.userData)
      if (o.userData.drawingStartMarker) startMarkers.push({ phase: o.userData.phase, position: o.getWorldPosition(new w.THREE.Vector3()).toArray() })
    })
    return { ghost, contacts, startMarkers, support: t.drawSnapFace, alignment: t.drawSnapAlignmentFace }
  })
}

test.describe('Starting an upright above a horizontal T joint', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); await seed(page) })
  for (const spec of ['2020', '4040']) test(`the through member supports ${spec} at its middle, with its side flush to the branch end`, async ({ page }) => {
    await enterDraw(page, spec)
    const start: [number, number, number] = [500, 420, spec === '2020' ? 0 : 14]
    await hoverWorld(page, start)
    await expect(page.getByTestId('start-edge-kind')).toContainText('接口齐平')
    const pending = await feedback(page)
    expect(pending.support.profileId).toBe('through')
    expect(pending.alignment.profileId).toBe('through')
    expect(pending.alignment.axis).not.toBe(2)
    expect(pending.startMarkers).toHaveLength(1)
    const anchor = pending.startMarkers[0].position
    expect(anchor[0]).toBeCloseTo(500)
    expect(anchor[1]).toBeCloseTo(420)
    expect(anchor[2]).toBeCloseTo(spec === '2020' ? 10 : 0)
    await page.screenshot({ path: test.info().outputPath(`t-through-${spec}-candidate.png`) })
    await clickWorld(page, start)
    const selected = (await feedback(page)).startMarkers
    expect(selected).toHaveLength(1)
    expect(selected[0].phase).toBe('start')
    expect(selected[0].position).toEqual(anchor)
    await page.keyboard.press('y')
    await hoverWorld(page, [500, 900, 0])
    await expect(page.getByTestId('draw-start-contact')).toContainText('贴合')
    await expect(page.getByTestId('draw-start-alignment')).toContainText('接口齐平')
    if (spec === '2020') await page.getByTestId('precise-input').fill('365')
    const preview = await feedback(page)
    expect(preview.ghost.position[0]).toBeCloseTo(500)
    expect(preview.ghost.position[1]).toBeCloseTo(420)
    expect(preview.ghost.position[2]).toBeCloseTo(spec === '2020' ? 10 : 0)
    for (let i = 0; i < 3; i++) expect(preview.ghost.position[i]).toBeCloseTo(anchor[i])
    expect(preview.contacts.find((c) => c.kind === 'contact').patch.length).toBeGreaterThanOrEqual(3)
    const flush = preview.contacts.find((c) => c.purpose === 'alignment')
    expect(flush.referenceAnchor[2]).toBeCloseTo(20)
    expect(flush.memberAnchor[2]).toBeCloseTo(20)
    const before = await store(page)
    await page.screenshot({ path: test.info().outputPath(`t-through-${spec}.png`) })
    if (spec === '2020') await page.getByTestId('precise-input').press('Enter')
    else await clickWorld(page, [500, 900, 0])
    const after = await store(page)
    expect(after.profiles).toHaveLength(3)
    expect(after.profiles.slice(0, 2)).toEqual(before.profiles)
    expect(after.profiles[2].position).toEqual(preview.ghost.profile.position)
    expect(after.profiles[2].fixedTrims).toEqual(preview.ghost.profile.fixedTrims)
    expect(after.profiles[2].length).toEqual(preview.ghost.profile.length)
    expect(after.past).toBe(before.past + 1)
    await page.keyboard.press('Control+z')
    expect((await store(page)).profiles).toEqual(before.profiles)
  })

  test('hovering on the branch side of the T joint keeps the foot on that member', async ({ page }) => {
    await enterDraw(page)
    await hoverWorld(page, [500, 420, 28])
    await expect(page.getByTestId('start-edge-kind')).toContainText('端面齐边')
    const pending = await feedback(page)
    expect(pending.support.profileId).toBe('branch')
    expect(pending.startMarkers).toHaveLength(1)
    const anchor = pending.startMarkers[0].position
    expect(anchor[0]).toBeCloseTo(500)
    expect(anchor[1]).toBeCloseTo(420)
    expect(anchor[2]).toBeCloseTo(30)
    await page.screenshot({ path: test.info().outputPath('t-branch-candidate.png') })
    await clickWorld(page, [500, 420, 28])
    expect((await feedback(page)).startMarkers[0].position).toEqual(anchor)
    await page.keyboard.press('y')
    await hoverWorld(page, [500, 900, 30])
    await expect(page.getByTestId('draw-start-contact')).toContainText('贴合')
    const preview = await feedback(page)
    expect(preview.ghost.position[0]).toBeCloseTo(500)
    expect(preview.ghost.position[1]).toBeCloseTo(420)
    expect(preview.ghost.position[2]).toBeCloseTo(30)
    for (let i = 0; i < 3; i++) expect(preview.ghost.position[i]).toBeCloseTo(anchor[i])
    expect(preview.contacts.find((c) => c.kind === 'contact').referenceFace.profileId).toBe('branch')
    await page.screenshot({ path: test.info().outputPath('t-branch.png') })
    await page.keyboard.press('Escape')
    await settle(page)
    expect((await feedback(page)).contacts).toEqual([])
  })

  test('a fully sectioned-away branch cannot supply a start alignment', async ({ page }) => {
    const before = await store(page)
    await page.evaluate(() => (window as any).__aluframe.tool.getState().setSection({ axis: 'z', at: 19, flip: false }))
    await enterDraw(page)
    await hoverWorld(page, [500, 420, 0])
    const pending = await feedback(page)
    expect(pending.support).toMatchObject({ profileId: 'through', axis: 1, side: 1 })
    expect(pending.alignment).toBeNull()
    expect(pending.startMarkers).toHaveLength(1)
    const anchor = pending.startMarkers[0].position
    await clickWorld(page, [500, 420, 0])
    expect((await feedback(page)).startMarkers[0].position).toEqual(anchor)
    await page.keyboard.press('y')
    await hoverWorld(page, [500, 900, 0])
    const preview = await feedback(page)
    expect(preview.alignment).toBeNull()
    for (let i = 0; i < 3; i++) expect(preview.ghost.position[i]).toBeCloseTo(anchor[i])
    expect((await store(page)).profiles).toEqual(before.profiles)
  })

  test('the hidden joint endpoint cannot steal a visible top hit outside the edge capture range', async ({ page }) => {
    await enterDraw(page)
    // The pointer is over the branch top at (516, 420, 47.6); its buried cap is excluded.
    const pointer: [number, number, number] = [500, 400, 20]
    await hoverWorld(page, pointer)
    const pending = await feedback(page)
    expect(pending.support).toMatchObject({ profileId: 'branch', axis: 1, side: 1 })
    expect(pending.alignment).toBeNull()
    const anchor = pending.startMarkers[0].position
    expect(anchor[0]).toBeCloseTo(500)
    expect(anchor[1]).toBeCloseTo(420)
    expect(anchor[2]).toBeCloseTo(50)
    await page.screenshot({ path: test.info().outputPath('t-visible-top-candidate.png') })
    await clickWorld(page, pointer)
    expect((await feedback(page)).startMarkers[0].position).toEqual(anchor)
    await page.keyboard.press('y')
    await hoverWorld(page, [500, 900, 50])
    const preview = await feedback(page)
    for (let i = 0; i < 3; i++) expect(preview.ghost.position[i]).toBeCloseTo(anchor[i])
    await expect(page.getByTestId('draw-start-contact')).toContainText('贴合')
  })

  test('a nearby upper rail cannot move the candidate foot before a longer upright is drawn', async ({ page }) => {
    await page.evaluate(() => (window as any).__aluframe.store.getState().addProfile({
      id: 'upper', spec: '2040', length: 200, position: [500, 500, -100],
      quaternion: [0, 0, Math.SQRT1_2, Math.SQRT1_2], holes: [], miterCuts: [], fixedTrims: { start: 0, end: 0 },
    }))
    await enterDraw(page)
    await hoverWorld(page, [500, 420, 0])
    const anchor = (await feedback(page)).startMarkers[0].position
    expect(anchor[0]).toBeCloseTo(500)
    expect(anchor[1]).toBeCloseTo(420)
    expect(anchor[2]).toBeCloseTo(10)
    await clickWorld(page, [500, 420, 0])
    expect((await feedback(page)).startMarkers[0].position).toEqual(anchor)
    await page.keyboard.press('y')
    await hoverWorld(page, [500, 1000, 10])
    await page.getByTestId('precise-input').fill('365')
    const preview = await feedback(page)
    for (let i = 0; i < 3; i++) expect(preview.ghost.position[i]).toBeCloseTo(anchor[i])
  })
})
