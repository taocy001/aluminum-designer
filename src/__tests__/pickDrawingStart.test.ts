import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { buildProfile } from '../utils/profileFactory'
import { getProfileDir } from '../utils/geometryCore'
import { computeTrims } from '../utils/jointUtils'
import { profileBodyEndpoints, profileFace } from '../utils/profileFaces'
import { pickDrawingStart } from '../utils/pickDrawingStart'
import { pickPoint, toScreen, type MeshHit } from '../utils/pickUtils'
import type { ProfileData } from '../store/useStore'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const size = { width: 1000, height: 800 }
function camera(scale = 1) {
  const c = new THREE.OrthographicCamera(-500 / scale, 500 / scale, 400 / scale, -400 / scale, 1, 10000)
  c.position.set(850, 900, 950); c.lookAt(200, 100, 0); c.updateMatrixWorld(); c.updateProjectionMatrix()
  return c
}
function rail(id = 'rail', start = V(0, 100, 0), end = V(400, 100, 0)): ProfileData {
  return { ...buildProfile(start, end, '2020', id)!, fixedTrims: { start: 0, end: 0 } }
}
function rayAt(c: THREE.Camera, px: THREE.Vector2) {
  const ray = new THREE.Raycaster()
  ray.setFromCamera(new THREE.Vector2(px.x / size.width * 2 - 1, 1 - px.y / size.height * 2), c)
  return ray.ray
}
function pick(profiles: ProfileData[], hit: MeshHit | null, options: { scale?: number; planeY?: number; cursor?: THREE.Vector2 } = {}) {
  const c = camera(options.scale)
  const cursor = options.cursor ?? toScreen(hit?.point ?? V(0, 0, 0), c, size)
  const ray = rayAt(c, cursor)
  return { result: pickDrawingStart(ray, cursor, c, size, profiles, hit, options.planeY),
    legacy: pickPoint(ray, cursor, c, size, profiles, hit, options.planeY) }
}
function surfaceHit(p: ProfileData, side: -1 | 1, cap: -1 | 1, inset = 4): MeshHit {
  const ends = profileBodyEndpoints(p)
  const point = (cap < 0 ? ends.start : ends.end).clone().addScaledVector(getProfileDir(p), -cap * inset)
  point.y += side * 10
  return { profileId: p.id, point, normal: V(0, side, 0) }
}

describe('drawing starts at a horizontal physical end edge', () => {
  it.each([-1, 1] as const)('keeps the top face and the actual %s cap as independent references', (side) => {
    const p = rail()
    const { result, legacy } = pick([p], surfaceHit(p, 1, side))
    expect(legacy.face?.axis).toBe(2)
    expect(result.face).toEqual({ profileId: p.id, axis: 1, side: 1 })
    expect(result.alignmentFace).toEqual({ profileId: p.id, axis: 2, side })
    expect(result.point.distanceTo(side < 0 ? V(0, 100, 0) : V(400, 100, 0))).toBeLessThan(1e-6)
    expect(result.normal?.toArray()).toEqual([0, 1, 0])
  })

  it('keeps the bottom face for a downward start', () => {
    const p = rail()
    const { result } = pick([p], surfaceHit(p, -1, 1))
    expect(result.face).toEqual({ profileId: p.id, axis: 1, side: -1 })
    expect(result.alignmentFace?.side).toBe(1)
    expect(result.normal?.toArray()).toEqual([0, -1, 0])
  })

  it('selects either side of a collinear seam according to the body actually hit', () => {
    const a = rail('a'), b = rail('b', V(400, 100, 0), V(800, 100, 0))
    for (const [p, side] of [[a, 1], [b, -1]] as const) {
      const { result } = pick([a, b], surfaceHit(p, 1, side))
      expect(result.point.distanceTo(V(400, 100, 0))).toBeLessThan(1e-6)
      expect(result.face?.profileId).toBe(p.id)
      expect(result.alignmentFace).toEqual({ profileId: p.id, axis: 2, side })
    }
  })

  it.each([V(-400, 100, 0), V(0, 100, 400), V(0, 100, -400)])('handles reversed and Z-directed rails toward %o', (end) => {
    const p = rail('turned', V(0, 100, 0), end)
    for (const side of [-1, 1] as const) {
      const { result } = pick([p], surfaceHit(p, 1, side))
      expect(result.alignmentFace).toEqual({ profileId: p.id, axis: 2, side })
      expect(result.point.distanceTo(side < 0 ? V(0, 100, 0) : end)).toBeLessThan(1e-6)
      const surface = profileFace(p, result.face!)
      expect(surface.normal[1]).toBeCloseTo(1)
    }
  })

  it.each([{ start: 25, end: 30 }, { start: -25, end: -30 }])('uses actual cuts and extensions %o', (fixedTrims) => {
    const p = { ...rail(), fixedTrims }
    for (const side of [-1, 1] as const) {
      const { result } = pick([p], surfaceHit(p, 1, side))
      expect(result.alignmentFace?.side).toBe(side)
      expect(result.point.x).toBeCloseTo(side < 0 ? fixedTrims.start : 400 - fixedTrims.end)
    }
  })

  it('resolves an automatic joint edge from the current real cuts', () => {
    const p = buildProfile(V(0, 100, 0), V(400, 100, 0), '2020', 'automatic')!
    const post = buildProfile(V(400, 0, 0), V(400, 400, 0), '4040', 'post')!
    const profiles = [p, post]
    const ends = profileBodyEndpoints(p, computeTrims(p, profiles))
    const hit = { profileId: p.id, point: ends.end.clone().add(V(-4, 10, 0)), normal: V(0, 1, 0) }
    const { result } = pick(profiles, hit)
    expect(result.alignmentFace).toEqual({ profileId: p.id, axis: 2, side: 1 })
    expect(result.point.distanceTo(ends.end)).toBeLessThan(1e-6)
  })

  it('uses the owning top face of a slot even when its triangle faces sideways', () => {
    const p = rail()
    const rotation = new THREE.Quaternion(...p.quaternion)
    const hit = { profileId: p.id, point: V(3, 7, 396).applyQuaternion(rotation).add(V(...p.position)),
      normal: V(-1, 0, 0).applyQuaternion(rotation) }
    const { result } = pick([p], hit)
    expect(result.face).toEqual({ profileId: p.id, axis: 1, side: 1 })
    expect(result.alignmentFace?.side).toBe(1)
    expect(result.normal?.distanceTo(hit.normal)).toBeLessThan(1e-6)
  })

  it('uses the top face after rolling a rectangular horizontal section', () => {
    const p = rail('rolled', V(0, 100, 0), V(0, 100, 400))
    p.spec = '2040'
    p.quaternion = new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), Math.PI / 2).toArray()
    const top = profileFace(p, { profileId: p.id, axis: 0, side: 1 })
    const { result } = pick([p], { profileId: p.id, point: V(0, top.center[1], 396), normal: V(0, 1, 0) })
    expect(result.face).toEqual({ profileId: p.id, axis: 0, side: 1 })
    expect(result.alignmentFace?.side).toBe(1)
  })

  it('requires the physical edge to be close in both millimetres and pixels', () => {
    const p = rail()
    const farInWorld = pick([p], surfaceHit(p, 1, 1, 21), { scale: 0.1 })
    expect(farInWorld.result.alignmentFace).toBeUndefined()
    expect(farInWorld.result).toEqual(farInWorld.legacy)
    const farOnScreen = pick([p], surfaceHit(p, 1, 1, 10), { scale: 10 })
    expect(farOnScreen.result.alignmentFace).toBeUndefined()
    expect(farOnScreen.result).toEqual(farOnScreen.legacy)
  })

  it('respects a raised work plane instead of stealing a different-height edge', () => {
    const p = rail()
    const hit = surfaceHit(p, 1, 1)
    const samePlane = pick([p], hit, { planeY: 100 })
    expect(samePlane.result.alignmentFace).toBeDefined()
    const otherPlane = pick([p], hit, { planeY: 250 })
    expect(otherPlane.result.alignmentFace).toBeUndefined()
    expect(otherPlane.result).toEqual(otherPlane.legacy)
    expect(otherPlane.result.point.y).toBe(250)
  })

  it('preserves the legacy pick for a horizontal diagonal whose cap cannot match a vertical member side', () => {
    const p = rail('diagonal', V(0, 100, 0), V(400, 100, 400))
    const { result, legacy } = pick([p], surfaceHit(p, 1, 1))
    expect(result.alignmentFace).toBeUndefined()
    expect(result).toEqual(legacy)
  })

  it('preserves ordinary endpoint, side, post and empty-space picking', () => {
    const p = rail()
    const post = buildProfile(V(0, 0, 0), V(0, 400, 0), '2020', 'post')!
    const sloping = rail('sloping', V(0, 100, 0), V(400, 110, 0))
    const cases: Array<{ profiles: ProfileData[]; hit: MeshHit | null }> = [
      { profiles: [p], hit: { profileId: p.id, point: V(400, 100, 0), normal: V(1, 0, 0) } },
      { profiles: [p], hit: { profileId: p.id, point: V(396, 100, 10), normal: V(0, 0, 1) } },
      { profiles: [p], hit: surfaceHit(p, 1, 1, 100) },
      { profiles: [post], hit: { profileId: post.id, point: V(0, 400, 0), normal: V(0, 1, 0) } },
      { profiles: [post], hit: { profileId: post.id, point: V(0, 396, 10), normal: V(0, 0, 1) } },
      { profiles: [sloping], hit: surfaceHit(sloping, 1, 1) },
      { profiles: [], hit: null },
    ]
    for (const { profiles, hit } of cases) {
      const { result, legacy } = pick(profiles, hit)
      expect(result).toEqual(legacy)
    }
  })
})
