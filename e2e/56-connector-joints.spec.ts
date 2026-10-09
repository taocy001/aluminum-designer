import { test, expect, type Page } from '@playwright/test'
import { parseProjectDocument } from '../src/utils/document'
import { specDims } from '../src/utils/specUtils'
import { readFileSync } from 'node:fs'
import { chooseConnector, openApp, setView, settle, store, w2c, type V3 } from './helpers'

const JOINT: V3 = [0, 100, 0]
const UP = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]
const ALONG_X = [0, Math.SQRT1_2, 0, Math.SQRT1_2]

async function loadJoint(page: Page, wide: boolean) {
  await page.evaluate(({ wide, up, alongX }) => {
    const profile = (id: string, quaternion: number[]) => ({ id, spec: wide ? '2040' : '2020',
      length: 300, position: [0, 100, 0], quaternion, miterCuts: [], holes: [] })
    const profiles = [profile('rail-x', wide ? [0.5, 0.5, 0.5, 0.5] : alongX), profile('post-y', up)]
    if (!wide) profiles.push(profile('rail-z', [0, 0, 0, 1]))
    ;(window as any).__aluframe.store.getState().loadDocument({
      profiles, connectors: [], panels: [], fittings: [], equipment: [], throughRule: 'rails',
    })
  }, { wide, up: UP, alongX: ALONG_X })
  await setView(page, [230, 290, 310], [35, 135, 35])
  await chooseConnector(page, 'inside-corner')
  const pointer = await w2c(page, JOINT)
  await page.mouse.move(pointer.x, pointer.y)
  await settle(page)
  return pointer
}

async function preview(page: Page) {
  return page.evaluate(() => {
    let result: { position: number[]; quaternion: number[]; legs: string[] } | null = null
    ;(window as any).__aluframe.sceneRoot.traverse((object: any) => {
      if (object.userData.connectorPreview) {
        const part = object.children.find((child: any) => Object.prototype.hasOwnProperty.call(child.userData, 'connectorId'))
        if (part) result = {
          position: part.position.toArray(), quaternion: part.quaternion.toArray(),
          legs: [...(object.userData.seatLegs ?? [])],
        }
      }
    })
    return result
  })
}

async function placePreview(page: Page, pointer: { x: number; y: number }) {
  const ghost = await preview(page)
  expect(ghost).not.toBeNull()
  const before = await store(page)
  await page.mouse.click(pointer.x, pointer.y)
  await settle(page)
  const after = await store(page)
  expect(after.connectors).toHaveLength(before.connectors.length + 1)
  expect(after.past).toBe(before.past + 1)
  const added = after.connectors.at(-1)!
  for (let axis = 0; axis < 3; axis++) expect(added.position[axis]).toBeCloseTo(ghost!.position[axis], 5)
  const alignment = added.quaternion.reduce((sum: number, component: number, i: number) => sum + component * ghost!.quaternion[i], 0)
  expect(Math.abs(alignment)).toBeCloseTo(1, 5)
  return { added, ghost: ghost! }
}

async function assertNoConnectorConflicts(page: Page) {
  const conflicts = await page.evaluate(() => (window as any).__aluframe.conflicts().conflicts)
  expect(conflicts).toEqual([])
}

test.beforeEach(async ({ page }) => { await openApp(page) })

test('the actual B6 desk front-left corner fits five inner brackets across all three member pairs', async ({ page }) => {
  test.setTimeout(120_000)
  const source = JSON.parse(readFileSync('examples/desk-with-pedestal.json', 'utf8'))
  const joint: V3 = [40, 700, 560]
  source.connectors = source.connectors.filter((part: any) => {
    const [x, y, z] = part.position
    return Math.hypot(x - joint[0], y - joint[1], z - joint[2]) > 80
  })
  await page.evaluate(document => (window as any).__aluframe.store.getState().loadDocument(document), parseProjectDocument(source))
  await setView(page, [-200, 870, 840], [25, 700, 575])
  await chooseConnector(page, 'inside-corner')
  const pointer = await w2c(page, joint)
  await page.mouse.move(pointer.x, pointer.y)
  await settle(page)
  const hud = page.getByTestId('connector-seat-hud')
  await expect(hud).toHaveAttribute('data-seat-count', '10')
  const lock = page.getByTestId('connector-joint-lock')
  const lockBox = (await lock.boundingBox())!
  await page.mouse.move(lockBox.x + lockBox.width / 2, lockBox.y + lockBox.height / 2, { steps: 25 })
  await expect(hud).toHaveAttribute('data-seat-count', '10')
  await lock.click()
  const initial = await store(page)
  const filter = page.getByTestId('connector-pair-filter')
  const pairs = await filter.locator('option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value).filter(Boolean))
  expect(pairs).toHaveLength(3)
  const groupCounts: number[] = []
  for (const pair of pairs) {
    await filter.selectOption(pair)
    groupCounts.push(await page.getByTestId('connector-seat-option').count())
  }
  expect(groupCounts.sort()).toEqual([2, 4, 4])
  await filter.selectOption('')
  const positions = [[39.4, 700.5, 570], [39.4, 700.5, 590], [39.4, 710, 560.5], [30, 700.5, 560.6], [10, 700.5, 560.6]]
  for (const position of positions) {
    const option = page.getByTestId('connector-seat-option').and(page.locator(`[data-position="${position.join(',')}"]`))
    await option.click()
    await expect(option).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => (await preview(page))?.position).toEqual(position)
    const ghost = await preview(page)
    expect(ghost).not.toBeNull()
    await page.mouse.move(pointer.x + 100, pointer.y + 80)
    await setView(page, [-100, 840, 800], [25, 700, 575])
    expect(await preview(page)).toEqual(ghost)
    const place = page.getByTestId('connector-seat-place')
    await expect(place).toBeEnabled()
    await place.click()
    await expect(place).toBeDisabled()
  }
  const result = await store(page)
  expect(result.connectors).toHaveLength(initial.connectors.length + 5)
  expect(result.past).toBe(initial.past + 5)
  const seats = result.connectors.filter((part) => Math.hypot(part.position[0] - joint[0], part.position[1] - joint[1], part.position[2] - joint[2]) < 80)
    .map((part) => part.position.map((n: number) => Number(n.toFixed(1))))
  expect(seats).toEqual(positions)
  await assertNoConnectorConflicts(page)
  await page.screenshot({ path: test.info().outputPath('desk-five-inner-brackets.png') })
})

test('both slots on a 2040 joint can be chosen and placed without duplicate parts', async ({ page }) => {
  const pointer = await loadJoint(page, true)
  const hud = page.getByTestId('connector-seat-hud')
  await expect(hud).toHaveAttribute('data-seat-count', '4')
  const guideErrors = await page.evaluate(({ hw, hh }) => {
    const { THREE, sceneRoot, store } = (window as any).__aluframe
    const errors: number[] = []
    sceneRoot.traverse((object: any) => {
      if (!object.userData.connectorSlotGuide) return
      const profile = store.getState().profiles.find((part: any) => part.id === object.userData.profileId)
      const local = new THREE.Vector3(...object.userData.point).sub(new THREE.Vector3(...profile.position))
        .applyQuaternion(new THREE.Quaternion(...profile.quaternion).normalize().invert())
      errors.push(Math.min(Math.abs(Math.abs(local.x) - hw), Math.abs(Math.abs(local.y) - hh)))
    })
    return errors
  }, specDims('2040'))
  expect(guideErrors).toHaveLength(2)
  for (const error of guideErrors) expect(error).toBeLessThan(1e-5)
  const firstIndex = Number(await hud.getAttribute('data-seat-index'))
  pointer.x += 2
  await page.mouse.move(pointer.x, pointer.y)
  await settle(page)
  await page.keyboard.press('Tab')
  await expect(hud).toHaveAttribute('data-seat-index', String((firstIndex + 1) % 4))
  const cycled = await preview(page)
  pointer.x += 2
  await page.mouse.move(pointer.x, pointer.y)
  await settle(page)
  await expect(hud).toHaveAttribute('data-seat-index', String((firstIndex + 1) % 4))
  expect(await preview(page)).toEqual(cycled)
  await page.keyboard.press('Shift+Tab')
  await expect(hud).toHaveAttribute('data-seat-index', String(firstIndex))
  await placePreview(page, pointer)
  const once = await store(page)
  await page.mouse.click(pointer.x, pointer.y)
  await settle(page)
  expect(await store(page)).toEqual(once)

  await page.keyboard.press('Tab')
  await settle(page)
  await expect(hud).toHaveAttribute('data-seat-index', String((firstIndex + 1) % 4))
  const second = await preview(page)
  await page.keyboard.press('Shift+Tab')
  await expect(hud).toHaveAttribute('data-seat-index', String(firstIndex))
  await page.keyboard.press('Tab')
  await settle(page)
  expect(await preview(page)).toEqual(second)
  await placePreview(page, pointer)

  const parts = (await store(page)).connectors
  expect(parts.map(part => part.position[2]).sort((a, b) => a - b)).toEqual([-10, 10])
  for (const part of parts) {
    expect(part.series).toBe(20)
    expect(part.position.slice(0, 2)).toEqual([9.4, 109.5])
  }
  await assertNoConnectorConflicts(page)
  await page.screenshot({ path: test.info().outputPath('2040-two-slots.png') })
})

test('automatic placement fills the other 2040 slot once and undoes as one edit', async ({ page }) => {
  const pointer = await loadJoint(page, true)
  await expect(page.getByTestId('connector-seat-hud')).toHaveAttribute('data-seat-count', '4')
  const { added } = await placePreview(page, pointer)
  const before = await store(page)
  await page.getByTestId('auto-connect').click()
  await settle(page)
  const filled = await store(page)
  expect(filled.connectors).toHaveLength(2)
  expect(filled.connectors).toContainEqual(added)
  expect(filled.connectors.map(part => part.position[2]).sort((a, b) => a - b)).toEqual([-10, 10])
  expect(filled.past).toBe(before.past + 1)
  await assertNoConnectorConflicts(page)

  await page.getByTestId('auto-connect').click()
  await settle(page)
  expect(await store(page)).toEqual(filled)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+z')
  await settle(page)
  expect((await store(page)).connectors).toEqual(before.connectors)
  await page.keyboard.press('Control+Shift+z')
  await settle(page)
  expect((await store(page)).connectors).toEqual(filled.connectors)
})

test('the connector seat selector stays inside the canvas when the camera turns away from the world origin', async ({ page }) => {
  await loadJoint(page, true)
  await page.evaluate(() => {
    const state = (window as any).__aluframe.store.getState()
    state.loadDocument({
      profiles: state.profiles.map((part: any) => ({ ...part,
        position: [part.position[0] + 1000, part.position[1], part.position[2] + 1000],
      })),
      connectors: [], panels: [], fittings: [], equipment: [], throughRule: 'rails',
    })
  })
  const hud = page.getByTestId('connector-seat-hud')
  const placements: Array<{ center: number; bottom: number }> = []
  const cameras: V3[] = [[770, 290, 690], [1230, 290, 1310]]
  for (const [index, camera] of cameras.entries()) {
    await setView(page, camera, [1035, 135, 1035])
    const pointer = await w2c(page, [1000, 100, 1000])
    await page.mouse.move(pointer.x, pointer.y)
    await settle(page)
    await expect(hud).toHaveAttribute('data-seat-count', '4')
    await expect(hud).toBeVisible()
    await expect(hud).toBeInViewport({ ratio: 1 })
    await expect(page.getByTestId('start-hud')).toHaveCount(0)
    const canvas = await page.locator('canvas').boundingBox()
    const box = await hud.boundingBox()
    expect(canvas).not.toBeNull()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(canvas!.x)
    expect(box!.y).toBeGreaterThanOrEqual(canvas!.y)
    expect(box!.x + box!.width).toBeLessThanOrEqual(canvas!.x + canvas!.width)
    expect(box!.y + box!.height).toBeLessThanOrEqual(canvas!.y + canvas!.height)
    expect(box!.x + box!.width / 2).toBeCloseTo(canvas!.x + canvas!.width / 2, 0)
    placements.push({ center: box!.x + box!.width / 2, bottom: box!.y + box!.height })
    const originBehindCamera = await page.evaluate(() => {
      const { camera, THREE } = (window as any).__aluframe
      return camera.getWorldDirection(new THREE.Vector3()).dot(camera.position.clone().negate()) < 0
    })
    expect(originBehindCamera).toBe(index === 0)
    await page.screenshot({ path: test.info().outputPath(`connector-seat-hud-camera-${index + 1}.png`) })
  }
  expect(placements[1].center).toBeCloseTo(placements[0].center, 1)
  expect(placements[1].bottom).toBeCloseTo(placements[0].bottom, 1)
})

test('a three-axis joint exposes every member pair and prevents the obstructed inner brackets from being placed', async ({ page }) => {
  const pointer = await loadJoint(page, false)
  const hud = page.getByTestId('connector-seat-hud')
  await expect(hud).toHaveAttribute('data-seat-count', '6')
  const pairs = new Set<string>()
  const placedPairs: string[] = []
  const initial = await store(page)
  const keys = await page.getByTestId('connector-seat-option').evaluateAll((options) => options.map((button) => button.getAttribute('data-seat-key')!))
  for (const key of keys) {
    const option = page.getByTestId('connector-seat-option').and(page.locator(`[data-seat-key=${JSON.stringify(key)}]`))
    const position = (await option.getAttribute('data-position'))!.split(',').map(Number)
    await option.click()
    await expect(option).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => (await preview(page))?.position).toEqual(position)
    const ghost = (await preview(page))!
    pairs.add([...ghost.legs].sort().join('/'))
    const allowed = await page.getByTestId('connector-seat-place').isEnabled()
    if (allowed) {
      await placePreview(page, pointer)
      placedPairs.push([...ghost.legs].sort().join('/'))
    } else {
      const before = await store(page)
      await page.mouse.click(pointer.x, pointer.y)
      await settle(page)
      expect((await store(page)).connectors).toEqual(before.connectors)
      expect((await store(page)).past).toBe(before.past)
    }
  }
  expect([...pairs].sort()).toEqual(['post-y/rail-x', 'post-y/rail-z', 'rail-x/rail-z'])
  expect(placedPairs.sort()).toEqual(['post-y/rail-x', 'rail-x/rail-z'])
  const complete = await store(page)
  expect(complete.connectors).toHaveLength(2)
  expect(complete.past).toBe(initial.past + 2)
  await assertNoConnectorConflicts(page)
  await page.getByTestId('auto-connect').click()
  await settle(page)
  expect(await store(page)).toEqual(complete)
  await page.screenshot({ path: test.info().outputPath('three-member-pairs.png') })
})

test('the visible end of a magnified inner bracket can be hovered, selected, deleted and restored', async ({ page }) => {
  await page.evaluate(() => (window as any).__aluframe.store.getState().loadDocument({
    profiles: [], panels: [], fittings: [], equipment: [], throughRule: 'rails',
    connectors: [{ id: 'inner-bracket', type: 'inside-corner', series: 20,
      position: [0, 100, 0], quaternion: [0, 0, 0, 1] }],
  }))
  await setView(page, [0, 100, 160], [0, 100, 0])
  const origin = await w2c(page, [0, 100, 0])
  const arm = await w2c(page, [18, 97, 3])
  expect(Math.hypot(arm.x - origin.x, arm.y - origin.y)).toBeGreaterThan(20)
  expect(await page.evaluate(({ x, y }) => (window as any).__aluframe.frontmostAt(x, y)?.id, arm)).toBe('inner-bracket')
  await page.mouse.move(arm.x, arm.y)
  await settle(page)
  expect(await page.evaluate(() => (window as any).__aluframe.tool.getState().hoverPartId)).toBe('inner-bracket')
  await page.mouse.click(arm.x, arm.y)
  await settle(page)
  expect((await store(page)).selectedIds).toEqual(['inner-bracket'])
  await expect(page.getByTestId('connector-series')).toHaveValue('20')
  await page.keyboard.press('Delete')
  await settle(page)
  expect((await store(page)).connectors).toEqual([])
  await page.keyboard.press('Control+z')
  await settle(page)
  expect((await store(page)).connectors.map(part => part.id)).toEqual(['inner-bracket'])
})

test('an installed inner bracket remains reachable at its slot-facing arm with matching highlight', async ({ page }) => {
  const pointer = await loadJoint(page, true)
  await expect(page.getByTestId('connector-seat-hud')).toHaveAttribute('data-seat-count', '4')
  const { added } = await placePreview(page, pointer)
  await page.keyboard.press('Escape')
  await settle(page)
  const installed = await store(page)
  const view = await page.evaluate(id => {
    const w = (window as any).__aluframe, matrix = new w.THREE.Matrix4()
    let found = false
    w.sceneRoot.updateMatrixWorld(true)
    w.sceneRoot.traverse((object: any) => {
      const index = object.userData.partIds?.indexOf(id) ?? -1
      if (found || !object.isInstancedMesh || index < 0) return
      object.getMatrixAt(index, matrix)
      matrix.premultiply(object.matrixWorld)
      found = true
    })
    if (!found) throw new Error('Installed connector is missing from the scene')
    const world = (x: number, y: number, z: number) => new w.THREE.Vector3(x, y, z).applyMatrix4(matrix).toArray()
    return { target: world(18, 0, 0), camera: world(18, 160, 16), origin: world(0, 0, 0) }
  }, added.id)
  await page.getByTestId('labels-toggle').click()
  await setView(page, view.camera as V3, view.target as V3)
  const arm = await w2c(page, view.target as V3)
  const origin = await w2c(page, view.origin as V3)
  expect(Math.hypot(arm.x - origin.x, arm.y - origin.y)).toBeGreaterThan(20)
  await page.mouse.move(arm.x, arm.y)
  await settle(page)
  const hovered = () => page.evaluate(() => (window as any).__aluframe.tool.getState().hoverPartId)
  const count = await page.evaluate(() => (window as any).__aluframe.tool.getState().hoverCandidates.count as number)
  expect(count).toBeGreaterThan(0)
  // A slot wall may be the direct hit; cycling must still reach the installed connector.
  for (let i = 0; i < count && await hovered() !== added.id; i++) {
    await page.keyboard.press('Tab')
    await settle(page)
  }
  expect(await hovered()).toBe(added.id)
  const bodyColor = () => page.evaluate(id => {
    let color: string | null = null
    ;(window as any).__aluframe.sceneRoot.traverse((object: any) => {
      if (object.isInstancedMesh && object.userData.partIds?.includes(id)) color = object.material.color.getHexString()
    })
    return color
  }, added.id)
  expect(await bodyColor()).toBe('fbbf24')
  await page.mouse.click(arm.x, arm.y)
  await settle(page)
  const selected = await store(page)
  expect(selected.selectedIds).toEqual([added.id])
  expect(await bodyColor()).toBe('60a5fa')
  expect(selected.profiles).toEqual(installed.profiles)
  expect(selected.connectors).toEqual(installed.connectors)
  expect(selected.past).toBe(installed.past)
  await page.screenshot({ path: test.info().outputPath('installed-inner-bracket-selected.png') })
})
