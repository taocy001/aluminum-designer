import { expect, test } from '@playwright/test'
import { openApp } from './helpers'

test('dimensions reuse lines on translation and keep labels on their world anchors', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => {
    const api = (window as any).__aluframe
    api.store.getState().loadDocument({ profiles: [{ id: 'rail', spec: '2020', length: 400,
      position: [100, 100, 100], quaternion: [0, 0, 0, 1], fixedTrims: { start: 0, end: 0 }, holes: [], miterCuts: [] }],
      connectors: [], panels: [], fittings: [], equipment: [] })
    api.tool.setState({ showDimensionLabels: true, showPartNumbers: false })
  })
  const dimensions = () => page.evaluate(() => {
    const api = (window as any).__aluframe, T = api.THREE
    const group = api.sceneRoot.getObjectByName('frame-dimensions')
    if (!group) return null
    const lines: any[] = [], labels: any[] = []
    group.traverse((o: any) => { if (o.isLine2) lines.push(o); if (o.isSprite) labels.push(o) })
    if (lines.length !== 9 || labels.length !== 3) return null
    // The first line in each dimension supplies the label's anchor, before its 40 mm camera offset.
    const errors = labels.map((label, i) => {
      const line = lines[i * 3]
      const a = new T.Vector3().fromBufferAttribute(line.geometry.attributes.instanceStart, 0)
      const b = new T.Vector3().fromBufferAttribute(line.geometry.attributes.instanceEnd, 0)
      const anchor = line.localToWorld(a.lerp(b, .5))
      const lean = api.camera.position.clone().sub(anchor)
      const expected = anchor.addScaledVector(lean, Math.min(40, lean.length() * .25) / lean.length())
      return label.getWorldPosition(new T.Vector3()).distanceTo(expected)
    })
    return { ids: lines.map(l => l.geometry.uuid), origin: group.position.toArray(), errors }
  })
  await expect.poll(dimensions).not.toBeNull()
  const before = (await dimensions())!
  await expect.poll(async () => Math.max(...(await dimensions())!.errors)).toBeLessThan(.001)
  await page.evaluate(() => (window as any).__aluframe.store.getState().updateProfile('rail', { position: [300, 250, 400] }))
  await expect.poll(async () => (await dimensions())?.origin).toEqual(before.origin.map((n: number, i: number) => n + [200, 150, 300][i]))
  const moved = (await dimensions())!
  expect(moved.ids).toEqual(before.ids)
  await expect.poll(async () => Math.max(...(await dimensions())!.errors)).toBeLessThan(.001)
  await page.evaluate(() => (window as any).__aluframe.store.getState().updateProfile('rail', { length: 600 }))
  await expect.poll(async () => (await dimensions())?.ids).not.toEqual(before.ids)
  await expect.poll(async () => Math.max(...(await dimensions())!.errors)).toBeLessThan(.001)
})


test('label occlusion waits for transforms to finish, then refreshes', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => {
    const api = (window as any).__aluframe
    api.store.getState().loadDocument({ profiles: [{ id: 'rail', spec: '2020', length: 400,
      position: [100, 100, 100], quaternion: [0, 0, 0, 1], holes: [], miterCuts: [] }],
      connectors: [], panels: [], fittings: [], equipment: [] })
    api.tool.setState({ showDimensionLabels: true, showPartNumbers: false })
  })
  const visibleLabels = () => page.evaluate(() => {
    const group = (window as any).__aluframe.sceneRoot.getObjectByName('frame-dimensions')
    const labels: any[] = []
    group?.traverse((o: any) => { if (o.isSprite && o.visible) labels.push(o) })
    return labels.length
  })
  await expect.poll(visibleLabels).toBeGreaterThan(0)
  for (const gesture of [{ isDragging: true }, { resize: { id: 'rail', end: 'end', origin: [100, 100, 100], length: 400, grabLength: 400, downX: 0, downY: 0 } },
    { rotationGesture: { axis: 'y', degrees: 0, snapped: true, pivot: [0, 0, 0] } }]) {
    await page.evaluate((gesture) => {
      const api = (window as any).__aluframe
      api.tool.setState(gesture)
      api.sceneRoot.getObjectByName('frame-dimensions').traverse((o: any) => { if (o.isSprite) o.visible = false })
    }, gesture)
    await page.waitForTimeout(750)
    expect(await visibleLabels()).toBe(0)
    await page.evaluate(() => (window as any).__aluframe.tool.setState({ isDragging: false, resize: null, rotationGesture: null }))
    await expect.poll(visibleLabels).toBeGreaterThan(0)
  }
})
