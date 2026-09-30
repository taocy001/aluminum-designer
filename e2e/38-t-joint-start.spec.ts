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
    const contacts: any[] = []
    w.sceneRoot.traverseVisible((o: any) => {
      if (o.userData.drawingPreview) ghost = { profile: o.userData.previewProfile, position: o.position.toArray(), cut: o.scale.z }
      if (o.userData.drawingContact) contacts.push(o.userData)
    })
    return { ghost, contacts, support: t.drawSnapFace, alignment: t.drawSnapAlignmentFace }
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
    await clickWorld(page, start)
    await page.keyboard.press('y')
    await hoverWorld(page, [500, 900, 0])
    await expect(page.getByTestId('draw-start-contact')).toContainText('贴合')
    await expect(page.getByTestId('draw-start-alignment')).toContainText('接口齐平')
    if (spec === '2020') await page.getByTestId('precise-input').fill('365')
    const preview = await feedback(page)
    expect(preview.ghost.position[0]).toBeCloseTo(500)
    expect(preview.ghost.position[1]).toBeCloseTo(420)
    expect(preview.ghost.position[2]).toBeCloseTo(spec === '2020' ? 10 : 0)
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
    expect((await feedback(page)).support.profileId).toBe('branch')
    await clickWorld(page, [500, 420, 28])
    await page.keyboard.press('y')
    await hoverWorld(page, [500, 900, 30])
    await expect(page.getByTestId('draw-start-contact')).toContainText('贴合')
    const preview = await feedback(page)
    expect(preview.ghost.position[0]).toBeCloseTo(500)
    expect(preview.ghost.position[1]).toBeCloseTo(420)
    expect(preview.ghost.position[2]).toBeCloseTo(30)
    expect(preview.contacts.find((c) => c.kind === 'contact').referenceFace.profileId).toBe('branch')
    await page.screenshot({ path: test.info().outputPath('t-branch.png') })
    await page.keyboard.press('Escape')
    await settle(page)
    expect((await feedback(page)).contacts).toEqual([])
  })
})
