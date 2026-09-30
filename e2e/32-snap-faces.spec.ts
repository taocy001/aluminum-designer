import { test, expect, type Page } from '@playwright/test'
import { openApp, setView, enterDraw, hoverWorld, clickWorld, w2c, dragHold, settle, store } from './helpers'

async function faces(page: Page) {
  return page.evaluate(() => {
    const out: any[] = []
    ;(window as any).__aluframe.sceneRoot.traverseVisible((o: any) => {
      if (o.userData.snapFace) out.push(o.userData)
    })
    return out
  })
}

async function seedPost(page: Page, rule: 'rails' | 'posts' = 'rails') {
  await page.evaluate((throughRule) => {
    const w = (window as any).__aluframe
    w.store.getState().loadDocument({ profiles: [{ id: 'post', spec: '4040', length: 800,
      position: [0, 0, 0], quaternion: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], miterCuts: [], holes: [] }],
    connectors: [], panels: [], fittings: [], throughRule })
  }, rule)
  await setView(page, [1400, 1200, 1800], [250, 500, 0])
  await settle(page)
}

test.describe('Drawing reference faces and the final member preview', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); await seedPost(page) })

  test('an end face is shown before clicking, retained as the start reference, and cleared on cancel', async ({ page }) => {
    await enterDraw(page, '2040')
    await hoverWorld(page, [0, 800, 0])
    await expect(page.getByTestId('start-face-kind')).toContainText('末端面')
    expect(await faces(page)).toContainEqual(expect.objectContaining({ faceProfileId: 'post', faceAxis: 2, faceSide: 1, faceRole: 'target' }))
    await clickWorld(page, [0, 800, 0])
    await hoverWorld(page, [600, 800, 0])
    await expect(page.getByTestId('draw-face-hud')).toContainText('起点 · 贴合 · 末端面')
    expect(await faces(page)).toContainEqual(expect.objectContaining({ faceProfileId: 'post', faceAxis: 2, faceSide: 1, faceRole: 'target' }))
    await page.screenshot({ path: test.info().outputPath('drawing-reference-face.png') })
    await page.keyboard.press('Escape')
    await settle(page)
    expect(await faces(page)).toEqual([])
  })

  for (const rule of ['rails', 'posts'] as const) test(`the rolled and trimmed ghost matches the placed member with ${rule} through`, async ({ page }) => {
    await seedPost(page, rule)
    await enterDraw(page, '2040')
    await clickWorld(page, [0, 800, 0])
    await hoverWorld(page, [600, 800, 0])
    const before = await store(page)
    const ghost = await page.evaluate(() => {
      let result: any = null
      ;(window as any).__aluframe.sceneRoot.traverse((o: any) => {
        if (o.userData.drawingPreview) result = { position: o.position.toArray(), quaternion: o.quaternion.toArray(), scale: o.scale.toArray() }
      })
      return result
    })
    expect(ghost).not.toBeNull()
    expect(ghost.position[0]).toBeCloseTo(rule === 'rails' ? -20 : 20)
    expect(ghost.scale[2]).toBeCloseTo(rule === 'rails' ? 620 : 580)
    await hoverWorld(page, [610, 800, 0])
    expect((await store(page)).past).toBe(before.past)
    await clickWorld(page, [600, 800, 0])
    await settle(page)
    const placed = await page.evaluate(() => {
      const w = (window as any).__aluframe
      const id = w.store.getState().profiles.find((p: any) => p.id !== 'post').id
      let result: any = null
      w.sceneRoot.traverse((o: any) => { if (o.userData.profileId === id && o.isMesh) result = {
        position: o.position.toArray(), quaternion: o.quaternion.toArray(), scale: o.scale.toArray(),
      } })
      return result
    })
    for (const field of ['position', 'quaternion', 'scale']) for (let i = 0; i < ghost[field].length; i++) {
      expect(placed[field][i]).toBeCloseTo(ghost[field][i], 5)
    }
    expect((await store(page)).past).toBe(before.past + 1)
    expect(await faces(page)).toEqual([])
    await page.keyboard.press('Control+z')
    expect((await store(page)).profiles).toHaveLength(1)
  })

  test('a visible side face reports its direction instead of just lighting the whole member', async ({ page }) => {
    await enterDraw(page, '2020')
    await hoverWorld(page, [0, 400, 20])
    await expect(page.getByTestId('start-face-kind')).toContainText('侧面')
    const shown = (await faces(page)).filter((f) => f.faceProfileId === 'post')
    expect(shown).toHaveLength(1)
    expect(shown[0].faceAxis).not.toBe(2)
    await page.getByTestId('mode-toggle').click()
    await settle(page)
    expect(await faces(page)).toEqual([])
  })

  test('a finished rail end contacts the post side without changing either cut length', async ({ page }) => {
    await page.evaluate(() => (window as any).__aluframe.store.getState().addProfile({
      id: 'rail', spec: '2020', length: 600, position: [250, 800, 300],
      quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2], miterCuts: [], holes: [],
    }))
    await settle(page)
    await dragHold(page, await w2c(page, [550, 800, 300]), await w2c(page, [307, 800, 5]))
    await expect(page.getByTestId('snap-hud')).toContainText('侧面贴合')
    const shown = await faces(page)
    expect(shown).toContainEqual(expect.objectContaining({ faceProfileId: 'post', faceAxis: 0, faceSide: 1 }))
    expect(shown).toContainEqual(expect.objectContaining({ faceProfileId: 'rail', faceAxis: 2, faceSide: -1 }))
    const result = await page.evaluate(() => {
      const w = (window as any).__aluframe
      const cuts = w.trims()
      const rail = w.store.getState().profiles.find((p: any) => p.id === 'rail')
      return { position: rail.position, cuts: [cuts.post.cutLength, cuts.rail.cutLength], conflicts: w.conflicts().conflicts }
    })
    // A fixed post occupies X=-20..20; the horizontal rail starts on X=20.
    expect(result.position[0]).toBeCloseTo(20)
    expect(result.position[2]).toBeCloseTo(10)
    expect(result.cuts).toEqual([800, 600])
    expect(result.conflicts).toEqual([])
    await page.mouse.up()
    await settle(page)
    expect(await faces(page)).toEqual([])
  })
})

test.describe('Choosing and holding an end alignment while dragging', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await page.evaluate(() => {
      const q = [0, Math.SQRT1_2, 0, Math.SQRT1_2]
      ;(window as any).__aluframe.store.getState().loadDocument({ profiles: [
        { id: 'fixed', spec: '2020', length: 600, position: [0, 10, 0], quaternion: q, miterCuts: [], holes: [] },
        { id: 'moving', spec: '2020', length: 560, position: [15, 10, 300], quaternion: q, miterCuts: [], holes: [] },
      ], connectors: [], panels: [], fittings: [] })
    })
    await setView(page, [1600, 1200, 1900], [300, 100, 150])
    await settle(page)
  })

  test('prefers end planes to a nearer centre, shows both faces, and keeps feedback at exact alignment', async ({ page }) => {
    const before = await store(page)
    await dragHold(page, await w2c(page, [295, 10, 300]), await w2c(page, [295, 10, 35]))
    await expect(page.getByTestId('snap-hud')).toContainText('端面对齐')
    const moved = (await store(page)).profiles.find((p: any) => p.id === 'moving')
    expect(moved.position[0]).toBeCloseTo(0)
    expect(moved.position[2]).toBeCloseTo(20)
    for (const id of ['fixed', 'moving']) expect(await faces(page)).toContainEqual(expect.objectContaining({ faceProfileId: id, faceAxis: 2 }))
    await page.screenshot({ path: test.info().outputPath('end-face-alignment.png') })
    const exact = await w2c(page, [280, 10, 35])
    await page.mouse.move(exact.x, exact.y)
    await settle(page)
    await expect(page.getByTestId('snap-hud')).toContainText('端面对齐')
    expect((await store(page)).profiles.find((p: any) => p.id === 'moving').position[0]).toBeCloseTo(0)
    await page.mouse.up()
    await settle(page)
    expect(await faces(page)).toEqual([])
    expect((await store(page)).past).toBe(before.past + 1)
    await page.keyboard.press('Control+z')
    expect((await store(page)).profiles.find((p: any) => p.id === 'moving').position).toEqual([15, 10, 300])
  })

  test('Shift clears the attached faces immediately and freely follows the pointer', async ({ page }) => {
    await dragHold(page, await w2c(page, [295, 10, 300]), await w2c(page, [295, 10, 35]))
    await expect(page.getByTestId('snap-hud')).toBeVisible()
    await page.keyboard.down('Shift')
    await settle(page)
    await expect(page.getByTestId('snap-hud')).toBeHidden()
    expect(await faces(page)).toEqual([])
    const free = await w2c(page, [300, 10, 40])
    await page.mouse.move(free.x, free.y)
    await settle(page)
    expect((await store(page)).profiles.find((p: any) => p.id === 'moving').position[2]).toBeCloseTo(40)
    await page.keyboard.up('Shift')
    const back = await w2c(page, [295, 10, 35])
    await page.mouse.move(back.x, back.y)
    await settle(page)
    await expect(page.getByTestId('snap-hud')).toBeVisible()
    await page.mouse.up()
  })
})
