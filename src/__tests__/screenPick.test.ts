import { afterEach, expect, it } from 'vitest'
import * as THREE from 'three'
import { buildProfile } from '../utils/profileFactory'
import { computeAllTrims, setThroughRule } from '../utils/jointUtils'
import { pickAtScreen, pickCandidatesAtScreen } from '../utils/screenPick'
import { profileBodyEndpoints, profileFace } from '../utils/profileFaces'
import { toScreen } from '../utils/pickUtils'
import type { ConnectorData, FittingData } from '../store/useStore'
import { connectorMeshes } from '../utils/connectorGeometry'
import { connectorScale } from '../utils/connectorCatalog'
import { frontmostId, promoteFrontmost } from '../utils/frontmost'
import { useToolStore } from '../store/useToolStore'

const V = (x: number, y: number, z = 0) => new THREE.Vector3(x, y, z)
const size = { width: 1000, height: 1000 }
const camera = new THREE.OrthographicCamera(-100, 900, 900, -100, 1, 10000)
camera.position.set(0, 0, 1000)
camera.lookAt(0, 0, 0)
camera.updateMatrixWorld()
camera.updateProjectionMatrix()
function pointer(x: number, y: number) {
  const cursor = toScreen(V(x, y), camera, size)
  const ray = new THREE.Raycaster()
  ray.setFromCamera(new THREE.Vector2(cursor.x / size.width * 2 - 1, 1 - cursor.y / size.height * 2), camera)
  return { cursor, ray: ray.ray }
}
afterEach(() => { setThroughRule('rails'); useToolStore.setState({ section: null }) })

it('picks an automatic extension where the visible end actually lies', () => {
  setThroughRule('rails')
  const post = buildProfile(V(0, 0), V(0, 800), '4040')!
  const rail = buildProfile(V(0, 800), V(600, 800), '2020')!
  const { cursor, ray } = pointer(-18, 800)
  const hit = pickCandidatesAtScreen(cursor, ray, camera, size, [post, rail]).find((p) => p.id === rail.id)!
  expect(hit.point.x).toBeCloseTo(-18)
  expect(hit.point.y).toBeCloseTo(800)
})

it('omits a trimmed-away end and accepts the caller shared trim map', () => {
  const post = buildProfile(V(0, 0), V(0, 800), '4040')!
  const rail = buildProfile(V(0, 800), V(600, 800), '2020')!
  setThroughRule('rails')
  const trims = computeAllTrims([post, rail])
  setThroughRule('posts')
  const { cursor, ray } = pointer(-18, 800)
  expect(pickCandidatesAtScreen(cursor, ray, camera, size, [post, rail]).some((p) => p.id === rail.id)).toBe(false)
  const hit = pickAtScreen(cursor, ray, camera, size, [rail], [], [], [], trims)!
  expect(hit.id).toBe(rail.id)
  expect(hit.point.x).toBeCloseTo(-18)
})

it('uses fixed physical ends for picking and face patches without a supplied trim map', () => {
  const rail = buildProfile(V(0, 400), V(600, 400), '2020')!
  rail.fixedTrims = { start: 100, end: 50 }
  const removed = pointer(0, 400)
  expect(pickAtScreen(removed.cursor, removed.ray, camera, size, [rail])).toBeNull()
  const visible = pointer(105, 400)
  expect(pickAtScreen(visible.cursor, visible.ray, camera, size, [rail])?.point.x).toBeCloseTo(105)
  const ends = profileBodyEndpoints(rail)
  for (const side of [-1, 1] as const) {
    const face = profileFace(rail, { profileId: rail.id, axis: 2, side })
    const end = side < 0 ? ends.start : ends.end
    expect(new THREE.Vector3(...face.center).distanceTo(end)).toBeLessThan(1e-6)
  }
})

it('keeps negative extensions beyond the model endpoints in fixed face geometry', () => {
  const rail = buildProfile(V(0, 400), V(100, 400), '2020')!
  rail.fixedTrims = { start: 150, end: -100 }
  const start = profileFace(rail, { profileId: rail.id, axis: 2, side: -1 })
  const end = profileFace(rail, { profileId: rail.id, axis: 2, side: 1 })
  expect(start.center[0]).toBeCloseTo(150)
  expect(end.center[0]).toBeCloseTo(200)
  const { cursor, ray } = pointer(175, 400)
  expect(pickAtScreen(cursor, ray, camera, size, [rail])?.point.x).toBeCloseTo(175)
})

function connector(id: string, type: string, series: 20 | 30 | 40 = 20): ConnectorData {
  return { id, type, series, position: [0, 0, 0], quaternion: [0, 0, 0, 1] }
}

function connectorScene(parts: ConnectorData[]) {
  const scene = new THREE.Scene()
  for (const part of parts) {
    const group = new THREE.Group()
    group.userData.connectorId = part.id
    group.position.set(...part.position)
    group.quaternion.set(...part.quaternion).normalize()
    group.scale.setScalar(connectorScale(part.series ?? 20))
    for (const { geometry } of connectorMeshes(part.type)) group.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()))
    scene.add(group)
  }
  scene.updateMatrixWorld(true)
  return scene
}

function closePointer(point: THREE.Vector3, zoom = 4) {
  const view = camera.clone()
  view.zoom = zoom
  view.updateProjectionMatrix()
  view.updateMatrixWorld()
  const cursor = toScreen(point, view, size)
  const rc = new THREE.Raycaster()
  rc.setFromCamera(new THREE.Vector2(cursor.x / size.width * 2 - 1, 1 - cursor.y / size.height * 2), view)
  return { view, cursor, ray: rc.ray }
}

it.each([
  { type: 'inside-corner', point: V(18, -3) },
  { type: 'bracket', point: V(28, 2) },
  { type: 't-bracket', point: V(32, 0) },
  { type: 'joining-plate', point: V(0, 0, 23), turned: true },
])('includes directly visible $type ends far from the installation origin', ({ type, point, turned }) => {
  const part = connector('visible', type, 40)
  if (turned) part.quaternion = new THREE.Quaternion().setFromAxisAngle(V(0, 1), Math.PI / 2).toArray()
  const aim = point.clone().multiplyScalar(2).applyQuaternion(new THREE.Quaternion(...part.quaternion))
  const { view, cursor, ray } = closePointer(aim)
  expect(cursor.distanceTo(toScreen(V(0, 0), view, size))).toBeGreaterThan(20)
  const list = pickCandidatesAtScreen(cursor, ray, view, size, [], [part])
  expect(frontmostId(connectorScene([part]), ray, view)).toBe(part.id)
  expect(promoteFrontmost(list, part.id)[0]?.id).toBe(part.id)
})

it('keeps small inner brackets selectable with pixel slack outside their narrow arms', () => {
  const part = connector('small', 'inside-corner')
  const { view, cursor, ray } = closePointer(V(18, -3))
  cursor.y += 16
  const list = pickCandidatesAtScreen(cursor, ray, view, size, [], [part])
  expect(list.map(p => p.id)).toEqual(['small'])
})

it('does not fill the gap between magnified bracket arms with a pickable box', () => {
  const part = connector('corner', 'inside-corner')
  const { view, cursor, ray } = closePointer(V(12, 12))
  expect(pickCandidatesAtScreen(cursor, ray, view, size, [], [part])).toEqual([])
})

it('aiming at an arm prefers it to another connector whose origin is closer', () => {
  const a = connector('arm', 't-bracket')
  const b = connector('near-origin', 'inside-corner')
  b.position = [32, -24, 1]
  const { view, cursor, ray } = closePointer(V(32, 5), 1)
  const list = pickCandidatesAtScreen(cursor, ray, view, size, [], [b, a])
  expect(list.map(p => p.id)).toEqual(['arm', 'near-origin'])
})

it('preserves true door occlusion and retains the bracket for overlap cycling', () => {
  const part = connector('bracket', 'inside-corner')
  const door: FittingData = { id: 'door', kind: 'door', material: 'ply', width: 100, height: 100, depth: 20,
    position: [0, 0, 40], quaternion: [0, 0, 0, 1], open: 0 }
  const { view, cursor, ray } = closePointer(V(18, -3))
  const scene = connectorScene([part])
  const cover = new THREE.Mesh(new THREE.BoxGeometry(100, 100, 10), new THREE.MeshBasicMaterial())
  cover.position.set(0, 0, 50)
  cover.userData.fittingId = door.id
  scene.add(cover)
  scene.updateMatrixWorld(true)
  const list = pickCandidatesAtScreen(cursor, ray, view, size, [], [part], [], [door])
  expect(list[0].id).toBe(part.id)
  expect(promoteFrontmost(list, frontmostId(scene, ray, view)).map(p => p.id)).toEqual(['door', 'bracket'])
})

it('picks a rotated plate end in perspective without depending on camera scale', () => {
  const part = connector('plate', 'joining-plate', 30)
  part.position = [100, 200, -40]
  part.quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.9, 0.3)).toArray()
  const centre = new THREE.Vector3(...part.position)
  const point = V(0, 0, 23).multiplyScalar(1.5).applyQuaternion(new THREE.Quaternion(...part.quaternion)).add(centre)
  const view = new THREE.PerspectiveCamera(45, 1, 1, 10000)
  view.position.copy(centre).add(V(90, 80, 220))
  view.lookAt(centre); view.updateProjectionMatrix(); view.updateMatrixWorld()
  const cursor = toScreen(point, view, size)
  const rc = new THREE.Raycaster()
  rc.setFromCamera(new THREE.Vector2(cursor.x / size.width * 2 - 1, 1 - cursor.y / size.height * 2), view)
  expect(cursor.distanceTo(toScreen(centre, view, size))).toBeGreaterThan(20)
  expect(frontmostId(connectorScene([part]), rc.ray, view)).toBe(part.id)
  expect(pickAtScreen(cursor, rc.ray, view, size, [], [part])?.id).toBe(part.id)
})

it('excludes connectors behind the camera or removed by the section plane', () => {
  const part = connector('hidden', 'bracket')
  const { view, cursor, ray } = closePointer(V(18, 2))
  part.position = [0, 0, 1500]
  expect(pickCandidatesAtScreen(cursor, ray, view, size, [], [part])).toEqual([])
  part.position = [0, 0, 0]
  useToolStore.setState({ section: { axis: 'z', at: -20, flip: false } })
  expect(pickCandidatesAtScreen(cursor, ray, view, size, [], [part])).toEqual([])
  expect(frontmostId(connectorScene([part]), ray, view)).toBeNull()
})
