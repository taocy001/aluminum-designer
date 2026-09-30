import { afterEach, expect, it } from 'vitest'
import * as THREE from 'three'
import { buildProfile } from '../utils/profileFactory'
import { computeAllTrims, setThroughRule } from '../utils/jointUtils'
import { pickAtScreen, pickCandidatesAtScreen } from '../utils/screenPick'
import { profileBodyEndpoints, profileFace } from '../utils/profileFaces'
import { toScreen } from '../utils/pickUtils'

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
afterEach(() => setThroughRule('rails'))

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
