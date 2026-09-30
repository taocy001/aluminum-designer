import { test, expect, type Page } from '@playwright/test'
import { openApp, setView, enterDraw, clickWorld, hoverWorld, settle, store } from './helpers'

async function contacts(page: Page) {
  return page.evaluate(() => {
    const results: any[] = []
    ;(window as any).__aluframe.sceneRoot.traverseVisible((o: any) => {
      if (o.userData.drawingContact) {
        const faces: any[] = []
        let markers = 0
        o.traverse((child: any) => {
          if (child.userData.snapFace) faces.push(child.userData)
          if (child.userData.drawingContactMarker) markers++
        })
        results.push({ ...o.userData, faces, markers })
      }
    })
    return results
  })
}
async function ghost(page: Page) {
  return page.evaluate(() => {
    let result: any = null
    ;(window as any).__aluframe.sceneRoot.traverseVisible((o: any) => {
      if (o.userData.drawingPreview) result = { position: o.position.toArray(), cutLength: o.scale.z, profile: o.userData.previewProfile }
    })
    return result
  })
}
async function seedPosts(page: Page, two = true) {
  await page.evaluate((two) => {
    const w = (window as any).__aluframe
    w.tool.getState().putDown()
    w.store.getState().loadDocument({ profiles: (two ? [0, 600] : [0]).map((x) => ({
      id: x === 0 ? 'a' : 'b', spec: '4040', length: 800, position: [x, 0, 0],
      quaternion: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], holes: [], miterCuts: [],
    })), connectors: [], panels: [], fittings: [], throughRule: 'rails' })
    w.store.getState().clearSelection()
    w.tool.getState().setWorkPlaneY(620)
  }, two)
  await setView(page, [1400, 1000, 1600], [300, 500, 0])
  await enterDraw(page, '2020')
}

test.describe('New members show the actual faces and attachment positions', () => {
  test.beforeEach(async ({ page }) => { await openApp(page) })

  test('a side reference produces a paired end contact at the selected height', async ({ page }) => {
    await seedPosts(page, false)
    await hoverWorld(page, [0, 620, 20])
    await expect(page.getByTestId('start-face-kind')).toContainText('侧面')
    await clickWorld(page, [0, 620, 20])
    await page.keyboard.press('x')
    await hoverWorld(page, [600, 620, 0])
    await expect(page.getByTestId('draw-start-contact')).toContainText('贴合')
    const relations = await contacts(page)
    expect(relations).toHaveLength(1)
    expect(relations[0].kind).toBe('contact')
    expect(relations[0].referenceAnchor[0]).toBeCloseTo(20)
    expect(relations[0].referenceAnchor[1]).toBeCloseTo(620)
    for (let i = 0; i < 3; i++) expect(relations[0].memberAnchor[i]).toBeCloseTo(relations[0].referenceAnchor[i], 6)
    expect(relations[0].faces.map((f: any) => f.faceRole).sort()).toEqual(['moving', 'target'])
    expect(relations[0].markers).toBe(1)
    await page.screenshot({ path: test.info().outputPath('start-contact.png') })
    await page.keyboard.press('Escape')
    await settle(page)
    expect(await contacts(page)).toEqual([])
  })

  test('bridging two posts shows two physical contacts and commits the exact preview in one undo', async ({ page }) => {
    await seedPosts(page)
    await clickWorld(page, [0, 620, 20])
    await page.keyboard.press('x')
    await hoverWorld(page, [600, 620, 20])
    await expect(page.getByTestId('draw-start-contact')).toContainText('贴合')
    await expect(page.getByTestId('draw-end-contact')).toContainText('贴合')
    const relations = await contacts(page)
    expect(relations).toHaveLength(2)
    expect(relations.every((r) => r.kind === 'contact')).toBe(true)
    expect(relations.find((r) => r.end === 'start').referenceAnchor[0]).toBeCloseTo(20)
    expect(relations.find((r) => r.end === 'end').referenceAnchor[0]).toBeCloseTo(580)
    const preview = await ghost(page)
    expect(preview.cutLength).toBeCloseTo(560)
    const before = await store(page)
    await page.screenshot({ path: test.info().outputPath('two-end-contacts.png') })
    await clickWorld(page, [600, 620, 20])
    const after = await store(page)
    expect(after.profiles).toHaveLength(3)
    expect(after.past).toBe(before.past + 1)
    const member = after.profiles.find((p) => !['a', 'b'].includes(p.id))
    expect(member.position).toEqual(preview.profile.position)
    expect(member.fixedTrims).toEqual(preview.profile.fixedTrims)
    expect(member.length).toEqual(preview.profile.length)
    expect(await contacts(page)).toEqual([])
    await page.keyboard.press('Control+z')
    expect((await store(page)).profiles).toEqual(before.profiles)
  })

  test('a typed length that leaves a gap shows only the remaining side alignment', async ({ page }) => {
    await seedPosts(page)
    await clickWorld(page, [0, 620, 20])
    await page.keyboard.press('x')
    await hoverWorld(page, [600, 620, 20])
    await page.getByTestId('precise-input').fill('500')
    await expect(page.getByTestId('draw-start-contact')).toContainText('贴合')
    await expect(page.getByTestId('draw-end-contact')).toContainText('对齐')
    const end = (await contacts(page)).find((r) => r.end === 'end')
    expect(end.kind).toBe('align')
    expect(end.patch).toBeNull()
    expect(end.markers).toBe(0)
    expect((await ghost(page)).cutLength).toBeCloseTo(500)
    await page.getByTestId('precise-input').fill('560')
    await expect(page.getByTestId('draw-end-contact')).toContainText('贴合')
    expect((await ghost(page)).cutLength).toBeCloseTo(560)
  })

  test('an exact length conflicting with the mating end face rejects only that end', async ({ page }) => {
    await seedPosts(page)
    await setView(page, [300, 1000, 1600], [300, 500, 0])
    await clickWorld(page, [0, 620, 20])
    await page.keyboard.press('x')
    await hoverWorld(page, [580, 620, 0])
    await expect(page.getByTestId('draw-end-contact')).toContainText('贴合')
    await page.getByTestId('precise-input').fill('500')
    await expect(page.getByTestId('draw-start-contact')).toContainText('贴合')
    await expect(page.getByTestId('draw-end-contact')).toContainText('未贴合')
    const end = (await contacts(page)).find((r) => r.end === 'end')
    expect(end.kind).toBe('rejected')
    expect(end.patch).toBeNull()
    expect(end.markers).toBe(0)
    await page.getByTestId('precise-input').fill('560')
    await expect(page.getByTestId('draw-end-contact')).toContainText('贴合')
    expect((await ghost(page)).cutLength).toBeCloseTo(560)
  })

  test('coaxial members show two paired end caps at their actual contact planes', async ({ page }) => {
    await page.evaluate(() => {
      const w = (window as any).__aluframe
      w.tool.getState().putDown()
      w.store.getState().loadDocument({ profiles: [0, 800].map((x) => ({
        id: x === 0 ? 'a' : 'b', spec: '2020', length: 400, position: [x, 200, 0],
        quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2], holes: [], miterCuts: [],
      })), connectors: [], panels: [], fittings: [], throughRule: 'rails' })
      w.store.getState().clearSelection()
      w.tool.getState().setWorkPlaneY(200)
    })
    await setView(page, [600, 900, 1600], [600, 200, 0])
    await enterDraw(page, '2020')
    await clickWorld(page, [400, 200, 0])
    await page.keyboard.press('x')
    await hoverWorld(page, [800, 200, 0])
    await expect(page.getByTestId('draw-start-contact')).toContainText('贴合')
    await expect(page.getByTestId('draw-end-contact')).toContainText('贴合')
    const relations = await contacts(page)
    expect(relations).toHaveLength(2)
    for (const relation of relations) {
      expect(relation.referenceFace.axis).toBe(2)
      expect(relation.memberFace.axis).toBe(2)
      expect(relation.patch.length).toBeGreaterThanOrEqual(4)
      expect(relation.referenceAnchor[0]).toBeCloseTo(relation.end === 'start' ? 400 : 800)
    }
    expect((await ghost(page)).cutLength).toBeCloseTo(400)
  })

  test('a remote end aligns with the trimmed physical end without claiming contact', async ({ page }) => {
    await page.evaluate(() => {
      const w = (window as any).__aluframe
      w.tool.getState().putDown()
      w.store.getState().loadDocument({ profiles: [{ id: 'reference', spec: '2020', length: 600,
        position: [0, 10, 0], quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
        fixedTrims: { start: 0, end: 100 }, holes: [], miterCuts: [] }],
      connectors: [], panels: [], fittings: [], throughRule: 'rails' })
      w.store.getState().clearSelection()
    })
    await setView(page, [1400, 1000, 1800], [300, 100, 150])
    await enterDraw(page, '2020')
    await clickWorld(page, [0, 0, 300])
    await page.keyboard.press('x')
    await hoverWorld(page, [498, 10, 300])
    await expect(page.getByTestId('draw-end-contact')).toContainText('对齐')
    const relation = (await contacts(page)).find((r) => r.end === 'end')
    expect(relation.kind).toBe('align')
    expect(relation.markers).toBe(0)
    expect(relation.referenceAnchor[0]).toBeCloseTo(500)
    expect(relation.memberAnchor[0]).toBeCloseTo(500)
    expect((await ghost(page)).cutLength).toBeCloseTo(500)
    await page.screenshot({ path: test.info().outputPath('remote-trimmed-end.png') })
  })
})
