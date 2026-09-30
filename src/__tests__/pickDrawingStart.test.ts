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
function pick(profiles: ProfileData[], hit: MeshHit | null, options: { scale?: number; planeY?: number; cursor?: THREE.Vector2; view?: THREE.Camera } = {}) {
  const c = options.view ?? camera(options.scale)
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

describe('drawing starts above a horizontal T interface', () => {
  const crossbar = () => rail('crossbar', V(-400, 100, 0), V(400, 100, 0))
  const stem = () => rail('stem', V(0, 100, 10), V(0, 100, 410))
  const topHit = (p: ProfileData, point = V(0, 110, 7)): MeshHit => ({ profileId: p.id, point, normal: V(0, 1, 0) })

  it('keeps the through-member top and centers the new column on the real interface', () => {
    const a = crossbar(), b = stem()
    for (const point of [V(0, 110, 7), V(0, 110, 0), V(5, 110, 7)]) {
      const { result } = pick([a, b], topHit(a, point))
      expect(result.face).toEqual({ profileId: a.id, axis: 1, side: 1 })
      expect(result.alignmentFace?.profileId).toBe(a.id)
      expect(result.alignmentFace?.axis).not.toBe(2)
      const alignment = profileFace(a, result.alignmentFace!)
      expect(alignment.normal[2]).toBeCloseTo(1)
      expect(alignment.center[2]).toBeCloseTo(10)
      expect(result.point.distanceTo(V(0, 100, 0))).toBeLessThan(1e-6)
    }
  })

  it('still chooses the stem and its own cap when that top is actually hit', () => {
    const a = crossbar(), b = stem()
    const { result } = pick([a, b], surfaceHit(b, 1, -1))
    expect(result.face?.profileId).toBe(b.id)
    expect(result.alignmentFace).toEqual({ profileId: b.id, axis: 2, side: -1 })
    expect(result.point.distanceTo(V(0, 100, 10))).toBeLessThan(1e-6)
  })

  it.each([0, Math.PI / 2, Math.PI, Math.PI * 3 / 2])('handles a rotated T at yaw %s with either stored stem direction', (angle) => {
    const yaw = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), angle)
    const rotated = (point: THREE.Vector3) => point.clone().applyQuaternion(yaw)
    const a = rail('crossbar', rotated(V(-400, 100, 0)), rotated(V(400, 100, 0)))
    for (const reverse of [false, true]) {
      const near = rotated(V(0, 100, 10)), far = rotated(V(0, 100, 410))
      const b = rail('stem', reverse ? far : near, reverse ? near : far)
      const { result } = pick([a, b], topHit(a, rotated(V(0, 110, 7))))
      expect(result.face?.profileId).toBe(a.id)
      expect(result.alignmentFace).toBeDefined()
      expect(result.point.distanceTo(V(0, 100, 0))).toBeLessThan(1e-6)
      const alignment = profileFace(a, result.alignmentFace!)
      expect(new THREE.Vector3(...alignment.normal).distanceTo(rotated(V(0, 0, 1)))).toBeLessThan(1e-6)
    }
  })

  it('supports the bottom interface when drawing down from the through member', () => {
    const a = crossbar(), b = stem()
    const { result } = pick([a, b], { profileId: a.id, point: V(0, 90, 7), normal: V(0, -1, 0) })
    expect(result.face).toEqual({ profileId: a.id, axis: 1, side: -1 })
    expect(result.alignmentFace?.profileId).toBe(a.id)
    expect(result.point.distanceTo(V(0, 100, 0))).toBeLessThan(1e-6)
  })

  it('uses an automatically cut-back stem instead of its construction endpoint', () => {
    const a = crossbar()
    const b = buildProfile(V(0, 100, 0), V(0, 100, 400), '2020', 'automatic-stem')!
    const profiles = [a, b]
    expect(profileBodyEndpoints(b, computeTrims(b, profiles)).start.z).toBeCloseTo(10)
    const { result } = pick(profiles, topHit(a))
    expect(result.alignmentFace?.profileId).toBe(a.id)
    expect(profileFace(a, result.alignmentFace!).center[2]).toBeCloseTo(10)
    expect(result.point.distanceTo(V(0, 100, 0))).toBeLessThan(1e-6)
  })

  it.each([{ origin: -10, trim: 20 }, { origin: 25, trim: -15 }])('finds a stem with a real start determined by %o', ({ origin, trim }) => {
    const a = crossbar(), b = rail('cut-stem', V(0, 100, origin), V(0, 100, 410))
    b.fixedTrims = { start: trim, end: 0 }
    const { result } = pick([a, b], topHit(a))
    expect(result.alignmentFace?.profileId).toBe(a.id)
    expect(profileFace(a, result.alignmentFace!).center[2]).toBeCloseTo(10)
  })

  it('accepts different sections whose actual top faces meet', () => {
    const a = { ...crossbar(), spec: '4040' as const }
    const b = rail('narrow-stem', V(0, 110, 20), V(0, 110, 410))
    const { result } = pick([a, b], topHit(a, V(3, 120, 17)))
    expect(result.alignmentFace?.profileId).toBe(a.id)
    expect(profileFace(a, result.alignmentFace!).center[2]).toBeCloseTo(20)
    expect(result.point.distanceTo(V(0, 100, 0))).toBeLessThan(1e-6)
  })

  it('captures the junction center on a 4040 top including a recessed slot hit', () => {
    const a = { ...crossbar(), spec: '4040' as const }
    const b = { ...rail('wide-stem', V(0, 100, 20), V(0, 100, 410)), spec: '4040' as const }
    for (const hit of [topHit(a, V(0, 120, 0)),
      { profileId: a.id, point: V(0, 117, 0), normal: V(0, 0, 1) },
      { profileId: a.id, point: V(0, 115, -14), normal: V(0, 0, 1) }]) {
      const { result } = pick([a, b], hit)
      expect(result.face, JSON.stringify(hit.point)).toEqual({ profileId: a.id, axis: 1, side: 1 })
      expect(result.alignmentFace?.profileId).toBe(a.id)
      expect(result.point.distanceTo(V(0, 100, 0))).toBeLessThan(1e-6)
      expect(profileFace(a, result.alignmentFace!).center[2]).toBeCloseTo(20)
      expect(result.normal?.distanceTo(hit.normal)).toBeLessThan(1e-6)
    }
  })

  it('rejects a shorter interface that does not reach the selected top', () => {
    const a = { ...crossbar(), spec: '4040' as const }
    const b = rail('shorter-stem', V(0, 100, 20), V(0, 100, 410))
    const { result, legacy } = pick([a, b], topHit(a, V(0, 120, 17)))
    expect(result.alignmentFace).toBeUndefined()
    expect(result).toEqual(legacy)
  })

  it('rejects gaps, penetrations, height-only edge contact, parallel neighbours and oblique caps', () => {
    const a = crossbar()
    const gapped = rail('gap', V(0, 100, 11), V(0, 100, 410))
    const overlapping = rail('overlap', V(0, 100, 9), V(0, 100, 410))
    const raised = rail('raised', V(0, 120, 10), V(0, 120, 410))
    const parallel = rail('parallel', V(-400, 100, 20), V(400, 100, 20))
    const oblique = rail('oblique', V(0, 100, 10), V(300, 100, 410))
    const rolled = stem()
    rolled.quaternion = new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), Math.PI / 4).toArray()
    for (const b of [gapped, overlapping, raised, parallel, oblique, rolled]) {
      const { result, legacy } = pick([a, b], topHit(a))
      expect(result.alignmentFace, b.id).toBeUndefined()
      expect(result, b.id).toEqual(legacy)
    }
  })

  it('does not extend an interface through empty space along the supporting side', () => {
    const a = crossbar(), b = stem()
    const { result, legacy } = pick([a, b], topHit(a, V(60, 110, 7)), { scale: 0.1 })
    expect(result.alignmentFace).toBeUndefined()
    expect(result).toEqual(legacy)
  })

  it('keeps the work-plane height restriction for T interfaces', () => {
    const a = crossbar(), b = stem()
    expect(pick([a, b], topHit(a), { planeY: 100 }).result.alignmentFace).toBeDefined()
    const { result, legacy } = pick([a, b], topHit(a), { planeY: 250 })
    expect(result.alignmentFace).toBeUndefined()
    expect(result).toEqual(legacy)
  })
})

describe('occupied T faces do not replace usable start surfaces', () => {
  const crossbar = () => rail('crossbar', V(-400, 100, 0), V(400, 100, 0))
  const stem = () => rail('stem', V(0, 100, 10), V(0, 100, 410))

  it.each(['cap', 'side'] as const)('recovers the nearby top when the seam triangle belongs to its occupied %s', (kind) => {
    const a = crossbar(), b = stem()
    const hit = { profileId: kind === 'cap' ? b.id : a.id, point: V(0, 105, 10), normal: V(0, 0, kind === 'cap' ? -1 : 1) }
    const { result } = pick([a, b], hit)
    expect(result.face).toEqual({ profileId: a.id, axis: 1, side: 1 })
    expect(result.alignmentFace?.profileId).toBe(a.id)
    expect(result.point.distanceTo(V(0, 100, 0))).toBeLessThan(1e-6)
    expect(result.normal?.distanceTo(hit.normal)).toBeLessThan(1e-6)
  })

  it('recovers the bottom when the occupied seam is viewed from below', () => {
    const a = crossbar(), b = stem(), view = camera()
    view.position.set(850, -900, 950); view.lookAt(200, 100, 0); view.updateMatrixWorld()
    const { result } = pick([a, b], { profileId: b.id, point: V(0, 95, 10), normal: V(0, 0, -1) }, { view })
    expect(result.face).toEqual({ profileId: a.id, axis: 1, side: -1 })
    expect(result.alignmentFace?.profileId).toBe(a.id)
  })

  it('does not recover toward a surface edge-on to the viewing ray', () => {
    const a = crossbar(), b = stem(), view = camera()
    view.position.set(850, 100, 950); view.lookAt(200, 100, 0); view.updateMatrixWorld()
    const { result, legacy } = pick([a, b], { profileId: b.id, point: V(0, 100, 10), normal: V(0, 0, -1) }, { view })
    expect(result).toEqual(legacy)
  })

  it('keeps the 12-pixel limit when looking directly at an occupied cap away from its outer edge', () => {
    const a = crossbar(), b = stem()
    const { result, legacy } = pick([a, b], { profileId: b.id, point: V(0, 100, 10), normal: V(0, 0, -1) }, { scale: 10 })
    expect(result).toEqual(legacy)
  })

  it('preserves free caps and exposed parts of partially occupied caps', () => {
    const a = crossbar(), b = stem()
    const taller = { ...stem(), spec: '4040' as const }
    const shortA = rail('short-crossbar', V(-5, 100, 0), V(5, 100, 0))
    const cases = [
      { profiles: [b], hit: { profileId: b.id, point: V(0, 105, 10), normal: V(0, 0, -1) } },
      { profiles: [a, taller], hit: { profileId: taller.id, point: V(0, 115, 10), normal: V(0, 0, -1) } },
      { profiles: [shortA, taller], hit: { profileId: taller.id, point: V(15, 105, 10), normal: V(0, 0, -1) } },
    ]
    for (const { profiles, hit } of cases) {
      const { result, legacy } = pick(profiles, hit)
      expect(result).toEqual(legacy)
      expect(result.face?.axis).toBe(2)
    }
  })

  it('does not rescue a detached or oblique neighbouring cap', () => {
    const a = crossbar()
    const gap = rail('gap', V(0, 100, 11), V(0, 100, 410))
    const oblique = rail('oblique', V(0, 100, 10), V(300, 100, 410))
    for (const b of [gap, oblique]) {
      const { result, legacy } = pick([a, b], { profileId: b.id,
        point: new THREE.Vector3(...b.position).add(V(0, 5, 0)), normal: getProfileDir(b).negate() })
      expect(result).toEqual(legacy)
    }
  })

  it('preserves a real top hit beyond the edge zone when legacy endpoint capture chooses an occupied cap', () => {
    const a = { ...rail('through', V(0, 400, 0), V(1000, 400, 0)), spec: '4040' as const }
    const b = { ...rail('branch', V(500, 400, 0), V(500, 400, 500)), spec: '4040' as const, fixedTrims: { start: 20, end: 0 } }
    const view = new THREE.PerspectiveCamera(45, size.width / size.height, 1, 100000)
    view.position.set(1300, 1400, 1400); view.lookAt(450, 400, 50); view.updateMatrixWorld(); view.updateProjectionMatrix()
    // Real browser ray: pointer projected from [500,400,20] hits this top at z=47.6.
    const hit = { profileId: b.id, point: V(516, 420, 47.6), normal: V(0, 1, 0) }
    const { result, legacy } = pick([a, b], hit, { view })
    expect(legacy.face).toEqual({ profileId: b.id, axis: 2, side: -1 })
    expect(result.face).toEqual({ profileId: b.id, axis: 1, side: 1 })
    expect(result.kind).toBe('segment')
    expect(result.alignmentFace).toBeUndefined()
    expect(result.point.distanceTo(V(500, 400, 50))).toBeLessThan(1e-6)
    const free = pick([b], hit, { view })
    expect(free.result).toEqual(free.legacy)
    expect(free.result.face?.axis).toBe(2)
  })

  it('does not redirect a higher top toward an occupied cap below that surface', () => {
    const a = { ...crossbar(), spec: '4040' as const }
    const b = rail('lower-stem', V(0, 100, 20), V(0, 100, 410))
    const { result, legacy } = pick([a, b], { profileId: a.id, point: V(0, 120, 0), normal: V(0, 1, 0) })
    expect(result).toEqual(legacy)
    expect(result.alignmentFace).toBeUndefined()
  })
})
