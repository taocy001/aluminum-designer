import { expect, test, type Page } from '@playwright/test'
import { openApp } from './helpers'

async function meshes(page: Page) {
  return page.evaluate(() => {
    const found: Record<string, { geometry: string; material: string; color: string; length: number }> = {}
    ;(window as any).__aluframe.sceneRoot.traverse((o: any) => {
      if (o.isMesh && o.userData.profileId) found[o.userData.profileId] = {
        geometry: o.geometry.uuid, material: o.material.uuid, color: o.material.color.getHexString(), length: o.scale.z,
      }
    })
    return found
  })
}

test('shared profile resources preserve individual highlight, lengths, deletion and undo', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await openApp(page)
  await page.evaluate(() => {
    const api = (window as any).__aluframe
    api.store.getState().loadDocument({ profiles: ['a', 'b', 'c'].map((id, i) => ({
      id, spec: '2040', length: 300 + i * 100, position: [i * 150, 100, 0], quaternion: [0, 0, 0, 1],
      fixedTrims: { start: 0, end: 0 }, holes: [], miterCuts: [],
    })), connectors: [], panels: [], fittings: [] })
    api.tool.getState().putDown()
    api.store.getState().selectItems([])
  })
  await expect.poll(async () => Object.keys(await meshes(page)).length).toBe(3)
  const before = await meshes(page)
  expect(new Set(Object.values(before).map(p => p.geometry)).size).toBe(1)
  expect(new Set(Object.values(before).map(p => p.material)).size).toBe(1)
  expect(Object.values(before).map(p => p.length)).toEqual([300, 400, 500])

  await page.evaluate(() => (window as any).__aluframe.store.getState().selectItems(['a']))
  await expect.poll(async () => (await meshes(page)).a.color).toBe('3b82f6')
  expect((await meshes(page)).b).toEqual(before.b)
  await page.evaluate(() => (window as any).__aluframe.tool.setState({ hoverProfileId: 'b' }))
  await expect.poll(async () => (await meshes(page)).b.color).toBe('e2e8f0')
  expect((await meshes(page)).c).toEqual(before.c)
  await page.evaluate(() => {
    const api = (window as any).__aluframe
    api.tool.setState({ hoverProfileId: null })
    api.store.getState().selectItems([])
  })
  await expect.poll(() => meshes(page)).toEqual(before)

  // Removing one owner must not dispose buffers and materials used by surviving parts.
  await page.evaluate(() => {
    const api = (window as any).__aluframe
    const disposed: string[] = []
    ;(window as any).__resourceDisposals = disposed
    api.sceneRoot.traverse((o: any) => {
      if (o.userData.profileId === 'a') {
        o.geometry.addEventListener('dispose', () => disposed.push('geometry'))
        o.material.addEventListener('dispose', () => disposed.push('material'))
      }
    })
    api.store.getState().selectItems(['a'])
    api.store.getState().removeSelected()
  })
  await expect.poll(async () => Object.keys(await meshes(page)).sort()).toEqual(['b', 'c'])
  await page.waitForTimeout(300)
  expect(await page.evaluate(() => (window as any).__resourceDisposals)).toEqual([])
  expect((await meshes(page)).b).toEqual(before.b)
  await page.keyboard.press('Control+z')
  await expect.poll(async () => Object.keys(await meshes(page)).length).toBe(3)
  expect((await meshes(page)).a.geometry).toBe(before.a.geometry)
  expect(errors).toEqual([])
})

test('board material changes preserve transparent neighbours and independent fitting highlights', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await openApp(page)
  await page.evaluate(() => {
    const api = (window as any).__aluframe
    api.store.getState().loadDocument({ profiles: [], connectors: [],
      panels: ['p1', 'p2'].map((id, i) => ({ id, width: 200, height: 200, thickness: 8,
        position: [i * 250, 200, 0], quaternion: [0, 0, 0, 1], material: 'acrylic' })),
      fittings: ['f1', 'f2'].map((id, i) => ({ id, kind: 'door', width: 200, height: 200, depth: 300,
        position: [i * 250, 500, 0], quaternion: [0, 0, 0, 1], material: 'acrylic', open: 0 })),
    })
    api.tool.getState().putDown()
    api.store.getState().selectItems([])
  })
  const boards = () => page.evaluate(() => {
    const result: Record<string, { material: string; color: string; opacity: number; transparent: boolean }> = {}
    ;(window as any).__aluframe.sceneRoot.traverse((o: any) => {
      const id = o.userData.panelId ?? o.userData.fittingId
      if (!id) return
      o.traverse((child: any) => {
        if (child.isMesh && (o.userData.panelId || child.userData.fittingBoard)) {
          const m = child.material
          result[id] = { material: m.uuid, color: m.color.getHexString(), opacity: m.opacity, transparent: m.transparent }
        }
      })
    })
    return result
  })
  await expect.poll(async () => Object.keys(await boards()).length).toBe(4)
  const before = await boards()
  expect(new Set(Object.values(before).map(b => b.material)).size).toBe(1)
  expect(before.p1.opacity).toBe(.32)
  expect(before.p1.transparent).toBe(true)
  await page.evaluate(() => (window as any).__aluframe.store.getState().selectItems(['f1']))
  await expect.poll(async () => (await boards()).f1.color).toBe('3b82f6')
  for (const id of ['p1', 'p2', 'f2']) expect((await boards())[id]).toEqual(before[id])
  await page.evaluate(() => {
    const store = (window as any).__aluframe.store.getState()
    store.snapshotHistory()
    store.updatePanel('p1', { material: 'mdf' })
  })
  await expect.poll(async () => (await boards()).p1.opacity).toBe(1)
  expect((await boards()).p1.transparent).toBe(false)
  expect((await boards()).p2).toEqual(before.p2)
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await boards()).p1).toEqual(before.p1)
  expect(errors).toEqual([])
})
