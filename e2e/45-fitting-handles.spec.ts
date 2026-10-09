import { test, expect, type Page } from '@playwright/test'
import { configureFitting, openApp, settle, store } from './helpers'

/** Inspect rendered boxes in the actual front mesh's frame, including its animated transform. */
async function rendered(page: Page, id: string) {
  return page.evaluate((id) => {
    const w = (window as any).__aluframe, T = w.THREE
    const f = w.store.getState().fittings.find((f: any) => f.id === id)
    let root: any, front: any
    w.sceneRoot.traverse((o: any) => { if (o.userData.fittingId === id) root = o })
    root.updateWorldMatrix(true, true)
    root.traverse((o: any) => { if (['front', 'panel'].includes(o.userData.fittingBoard)) front = o })
    const grip = root.getObjectByName('handle-grip')
    const boundsInFront = (mesh: any) => {
      mesh.geometry.computeBoundingBox()
      const b = mesh.geometry.boundingBox, result = new T.Box3()
      for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
        result.expandByPoint(front.worldToLocal(mesh.localToWorld(new T.Vector3(x, y, z))))
      }
      return { min: result.min.toArray(), max: result.max.toArray(), center: result.getCenter(new T.Vector3()).toArray() }
    }
    front.geometry.computeBoundingBox()
    const b = front.geometry.boundingBox, surface = b.max.z
    const localFree = new T.Vector3(0, 0, surface)
    if (f.kind === 'door') {
      if (f.hinge === 'right') localFree.x = b.min.x
      else if (f.hinge === 'top') localFree.y = b.min.y
      else if (f.hinge === 'bottom') localFree.y = b.max.y
      else localFree.x = b.max.x
    }
    const mounts: any[] = []
    root.traverse((o: any) => { if (o.name === 'handle-mount') mounts.push(boundsInFront(o)) })
    const center = front.getWorldPosition(new T.Vector3())
    return { grip: boundsInFront(grip), mounts, surface, frontMin: b.min.toArray(), frontMax: b.max.toArray(),
      free: root.worldToLocal(front.localToWorld(localFree)).toArray(),
      screen: w.worldToClient(center.x, center.y, center.z) }
  }, id)
}

async function checkHandle(page: Page, id: string) {
  const mesh = await rendered(page, id)
  expect(mesh.grip.min[2] - mesh.surface).toBeCloseTo(18, 4)
  expect(mesh.mounts.length).toBeGreaterThan(0)
  for (const mount of mesh.mounts) expect(mount.min[2]).toBeCloseTo(mesh.surface, 4)
  for (const block of [mesh.grip, ...mesh.mounts]) for (const axis of [0, 1]) {
    expect(block.min[axis]).toBeGreaterThanOrEqual(mesh.frontMin[axis] - 0.001)
    expect(block.max[axis]).toBeLessThanOrEqual(mesh.frontMax[axis] + 0.001)
  }
  return mesh
}

async function cabinet(page: Page, template = 'cabinet') {
  await page.getByTestId(`template-${template}`).click()
  await page.getByTestId('template-place').click()
  await page.keyboard.press('Escape')
  await page.getByTestId('fit-view').click()
  await settle(page)
  await page.mouse.click(350, 400)
  await page.keyboard.press('Control+a')
  expect((await store(page)).selectedIds.length).toBeGreaterThan(2)
}

async function selectFront(page: Page, id: string) {
  const { screen } = await rendered(page, id)
  await page.mouse.click(screen.x, screen.y)
  await page.getByTestId('sidebar-tab-properties').click()
  await expect(page.getByTestId('fitting-open')).toBeVisible()
  expect((await store(page)).selectedIds).toEqual([id])
}

async function openThroughUI(page: Page, value: 'half' | 'full' | 'shut') {
  const slider = page.getByTestId('fitting-open')
  await slider.press(value === 'full' ? 'End' : 'Home')
  if (value === 'half') for (let i = 0; i < 5; i++) await slider.press('PageUp')
  await expect(slider).toHaveValue(value === 'half' ? '50' : value === 'full' ? '100' : '0')
  await page.waitForTimeout(650)
}

test.beforeEach(async ({ page }) => openApp(page))

for (const [hinge, template] of [['left', 'cabinet'], ['right', 'rack'], ['top', 'cabinet'], ['bottom', 'rack']] as const) {
  test(`${hinge}-hung door has an exterior pull and opens toward it`, async ({ page }) => {
    await cabinet(page, template)
    await configureFitting(page, 'door')
    await page.getByTestId(`hinge-${hinge}`).click()
    await page.getByTestId('add-door').click()
    await settle(page)
    const f = (await store(page)).fittings[0]
    expect(f.frame).toBe(template === 'rack' ? 40 : 20)
    const closed = await checkHandle(page, f.id)
    const axis = hinge === 'top' || hinge === 'bottom' ? 1 : 0
    const sign = hinge === 'left' || hinge === 'bottom' ? 1 : -1
    expect(closed.grip.center[axis] * sign).toBeGreaterThan(0)
    await selectFront(page, f.id)
    const before = await store(page)
    await openThroughUI(page, 'half')
    expect((await checkHandle(page, f.id)).free[2]).toBeGreaterThan(closed.free[2] + 10)
    await openThroughUI(page, 'full')
    await checkHandle(page, f.id)
    await page.screenshot({ path: test.info().outputPath(`${hinge}-open.png`) })
    await openThroughUI(page, 'shut')
    await expect.poll(async () => Math.abs((await rendered(page, f.id)).free[2] - closed.free[2])).toBeLessThan(0.1)
    await checkHandle(page, f.id)
    const after = await store(page)
    expect(after.past).toBe(before.past)
    expect(after.profiles).toEqual(before.profiles)
    expect(after.fittings).toEqual(before.fittings)
  })
}

test('two drawers keep centred exterior pulls while each slides out and back', async ({ page }) => {
  await cabinet(page, 'bench')
  await configureFitting(page, 'drawer')
  await page.getByTestId('drawer-count').fill('2')
  await page.getByTestId('add-drawer').click()
  await settle(page)
  const fittings = (await store(page)).fittings
  expect(fittings).toHaveLength(2)
  for (const f of fittings) {
    expect(f.frame).toBe(40)
    const closed = await checkHandle(page, f.id)
    expect(closed.grip.center[0]).toBeCloseTo(0, 5)
    expect(closed.grip.center[1]).toBeCloseTo(0, 5)
    await selectFront(page, f.id)
    const before = await store(page)
    await openThroughUI(page, 'full')
    expect((await checkHandle(page, f.id)).free[2]).toBeGreaterThan(closed.free[2] + f.depth * 0.8)
    await page.screenshot({ path: test.info().outputPath(`drawer-${f.id}-open.png`) })
    await openThroughUI(page, 'shut')
    await expect.poll(async () => Math.abs((await rendered(page, f.id)).free[2] - closed.free[2])).toBeLessThan(0.1)
    expect((await store(page)).past).toBe(before.past)
    expect((await store(page)).fittings).toEqual(before.fittings)
  }
})

test('saved fittings without frame and rotated doors retain exterior rendered handles', async ({ page }) => {
  // Imported fixtures cover legacy data and orientations independent of the camera.
  await page.evaluate(() => {
    const w = (window as any).__aluframe, T = w.THREE
    const fittings = [0, Math.PI / 2, Math.PI, -Math.PI / 2].flatMap((yaw, index) => ['door', 'drawer'].map((kind, k) => ({
      id: `${kind}-${index}`, kind, width: 420, height: 250, depth: 360, material: 'ply',
      position: [index * 1200, 500 + k * 800, 0], quaternion: new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), yaw).toArray(),
      open: 0.5, hinge: 'right', hingeType: 'cup', overlay: 'inset',
    })))
    w.store.getState().loadDocument({ profiles: [], connectors: [], panels: [], fittings })
  })
  await settle(page)
  for (const f of (await store(page)).fittings) await checkHandle(page, f.id)
})
