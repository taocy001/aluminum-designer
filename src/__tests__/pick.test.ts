import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { resolveAxisEnd, pickPoint, toScreen, modelPointFromHit } from '../utils/pickUtils'
import { buildProfile } from '../utils/profileFactory'
import { getProfileShape, type ProfileSpec } from '../utils/profileShapes'

const size = { width: 1000, height: 800 }
function cam(): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(45, size.width / size.height, 1, 100000)
  c.position.set(900, 800, 900); c.lookAt(0, 400, 0); c.updateMatrixWorld(); c.updateProjectionMatrix()
  return c
}
function rayAt(c: THREE.Camera, px: THREE.Vector2): THREE.Ray {
  const ndc = new THREE.Vector2((px.x / size.width) * 2 - 1, -(px.y / size.height) * 2 + 1)
  const rc = new THREE.Raycaster(); rc.setFromCamera(ndc, c)
  return rc.ray
}

describe('resolveAxisEnd', () => {
  it('picks the axis whose screen direction matches the mouse and measures along it', () => {
    const c = cam()
    const start = new THREE.Vector3(0, 0, 0)
    for (const axis of ['x', 'y', 'z'] as const) {
      const target = start.clone(); target[axis] = 400
      const px = toScreen(target, c, size)
      const res = resolveAxisEnd(start, rayAt(c, px), px, c, size, [], null)!
      expect(res.axis).toBe(axis)
      expect(res.length).toBe(400)
      expect(res.end[axis]).toBe(400)
    }
  })
  it('snaps the end to an existing endpoint on the axis line', () => {
    const c = cam()
    const post = buildProfile(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 803, 0), '2020')!
    const target = new THREE.Vector3(0, 800, 0)
    const px = toScreen(target, c, size)
    const res = resolveAxisEnd(new THREE.Vector3(0, 0, 0), rayAt(c, px), px, c, size, [post], null)!
    expect(res.axis).toBe('y')
    expect(res.length).toBe(803)
    expect(res.snapPoint).not.toBeNull()
  })
  it('aligns the length with a remote endpoint and reports a guide', () => {
    const c = cam()
    const post = buildProfile(new THREE.Vector3(600, 0, 0), new THREE.Vector3(600, 803, 0), '2020')!
    const target = new THREE.Vector3(0, 800, 0)
    const px = toScreen(target, c, size)
    const res = resolveAxisEnd(new THREE.Vector3(0, 0, 0), rayAt(c, px), px, c, size, [post], null)!
    expect(res.length).toBe(803)
    expect(res.guide).not.toBeNull()
  })
  it('honours a locked axis', () => {
    const c = cam()
    const target = new THREE.Vector3(400, 0, 0)
    const px = toScreen(target, c, size)
    const res = resolveAxisEnd(new THREE.Vector3(0, 0, 0), rayAt(c, px), px, c, size, [], 'z')!
    expect(res.axis).toBe('z')
  })
})

describe('pickPoint', () => {
  it('prefers an endpoint, then a centerline point, then the floor', () => {
    const c = cam()
    const post = buildProfile(new THREE.Vector3(200, 0, 200), new THREE.Vector3(200, 800, 200), '2020')!
    const top = toScreen(new THREE.Vector3(200, 800, 200), c, size)
    expect(pickPoint(rayAt(c, top), top, c, size, [post]).kind).toBe('endpoint')
    const midPx = toScreen(new THREE.Vector3(200, 402, 200), c, size)
    const mid = pickPoint(rayAt(c, midPx), midPx, c, size, [post])
    expect(mid.kind).toBe('segment')
    expect(mid.point.y % 5).toBe(0)
    const floorPx = toScreen(new THREE.Vector3(-300, 0, 100), c, size)
    const floor = pickPoint(rayAt(c, floorPx), floorPx, c, size, [post])
    expect(floor.kind).toBe('ground')
    expect(floor.point.y).toBe(0)
  })
})

/**
 * Raising the work plane is how you say "I am drawing a shelf rail at 440". A snap is meant
 * to correct where you pointed, not to move you somewhere else, so nothing off that height
 * may win — a vertex in another cabinet can sit under the cursor and in plain view, and
 * before this it took the click and drew the rail two metres away.
 */
describe('pickPoint with a raised work plane', () => {
  const c = cam()
  const here = buildProfile(new THREE.Vector3(200, 0, 200), new THREE.Vector3(200, 800, 200), '2020')!
  const elsewhere = buildProfile(new THREE.Vector3(1400, 900, 1400), new THREE.Vector3(1400, 1700, 1400), '2020')!

  it('keeps a click on a post at the height being worked at', () => {
    const px = toScreen(new THREE.Vector3(200, 440, 200), c, size)
    const got = pickPoint(rayAt(c, px), px, c, size, [here], null, 440)
    expect(got.point.y).toBe(440)
    expect(got.point.x).toBeCloseTo(200, 3)
    expect(got.point.z).toBeCloseTo(200, 3)
  })

  it('refuses an endpoint that is not on the plane, however near the cursor it is', () => {
    const away = new THREE.Vector3(1400, 1700, 1400)
    const px = toScreen(away, c, size)
    const loose = pickPoint(rayAt(c, px), px, c, size, [here, elsewhere])
    expect(loose.kind).toBe('endpoint')             // at floor level it is fair game
    const held = pickPoint(rayAt(c, px), px, c, size, [here, elsewhere], null, 440)
    expect(held.point.distanceTo(away)).toBeGreaterThan(100)
    expect(held.point.y).toBe(440)
  })

  it('still lands on the plane where there is nothing to snap to', () => {
    const px = toScreen(new THREE.Vector3(-300, 440, 100), c, size)
    const got = pickPoint(rayAt(c, px), px, c, size, [here], null, 440)
    expect(got.kind).toBe('ground')
    expect(got.point.y).toBe(440)
  })
})

describe('visible and stable end-face targets', () => {
  const c = new THREE.PerspectiveCamera(45, size.width / size.height, 1, 100000)
  c.position.set(0, 400, 1600); c.lookAt(0, 400, 0); c.updateMatrixWorld(); c.updateProjectionMatrix()
  const post = buildProfile(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 800, 0), '2020')!
  const top = toScreen(new THREE.Vector3(0, 800, 0), c, size)
  const face = { profileId: post.id, axis: 2 as const, side: 1 as const }

  it('captures an end outside the old 18px target and holds it through small hand movement', () => {
    const at = (dx: number, previous = false) => {
      const px = top.clone().add(new THREE.Vector2(dx, 0))
      return pickPoint(rayAt(c, px), px, c, size, [post], null, 0, previous ? face : null)
    }
    expect(at(22).face).toEqual(face)
    expect(at(28).kind).not.toBe('endpoint')
    expect(at(28, true).face).toEqual(face)
    expect(at(36, true).kind).not.toBe('endpoint')
  })

  it('never retains an end behind the visible body or above a raised work plane', () => {
    const px = top.clone().add(new THREE.Vector2(22, 0))
    const hit = { profileId: 'front', point: new THREE.Vector3(0, 760, 200), normal: new THREE.Vector3(0, 0, 1) }
    expect(pickPoint(rayAt(c, px), px, c, size, [post], hit, 0, face).kind).not.toBe('endpoint')
    const onPlane = pickPoint(rayAt(c, px), px, c, size, [post], null, 440, face)
    expect(onPlane.kind).not.toBe('endpoint')
    expect(onPlane.face).not.toEqual(face)
  })

  it('keeps the design endpoint when the visible end has been cut back', () => {
    const hit = { profileId: post.id, point: new THREE.Vector3(0, 780, 0), normal: new THREE.Vector3(0, 1, 0) }
    const pick = modelPointFromHit(hit, [post])!
    expect(pick.point.y).toBeCloseTo(800)
    expect(pick.face).toEqual(face)
    expect(pick.normal!.toArray()).toEqual([0, 1, 0])
  })

  it('uses the same end-face capture for the second click rather than a nearby body coordinate', () => {
    const px = top.clone().add(new THREE.Vector2(0, 22))
    const hit = { profileId: post.id, point: new THREE.Vector3(0, 760, 10), normal: new THREE.Vector3(0, 0, 1) }
    const result = resolveAxisEnd(new THREE.Vector3(300, 0, 0), rayAt(c, px), px, c, size, [post], 'y', hit)!
    expect(result.end.y).toBe(800)
    expect(result.face).toEqual(face)
    expect(result.targetId).toBe(post.id)
  })

  it.each([0, 300])('retains the second-click end at 28px for an axis offset of %s', (x) => {
    const px = toScreen(new THREE.Vector3(x, 800, 0), c, size).add(new THREE.Vector2(0, 28))
    const origin = new THREE.Vector3(x, 0, 0)
    expect(resolveAxisEnd(origin, rayAt(c, px), px, c, size, [post], 'y', null)!.end.y).not.toBe(800)
    const held = resolveAxisEnd(origin, rayAt(c, px), px, c, size, [post], 'y', null, face)!
    expect(held.end.y).toBe(800)
    expect(held.face).toEqual(face)
    const gone = resolveAxisEnd(origin, rayAt(c, px), px, c, size, [], 'y', null, face)!
    expect(gone.end.y).not.toBe(800)
    expect(gone.face).toBeNull()
  })
})

describe('slot walls identify their owning outer reference face', () => {
  const cases: Array<{ spec: ProfileSpec; point: [number, number, number]; normal: [number, number, number]; axis: 0 | 1; side: -1 | 1 }> = [
    { spec: '2020', point: [3, 7, 300], normal: [-1, 0, 0], axis: 1, side: 1 },
    { spec: '2020', point: [-3, -7, 300], normal: [1, 0, 0], axis: 1, side: -1 },
    { spec: '2020', point: [7, 3, 300], normal: [0, -1, 0], axis: 0, side: 1 },
    { spec: '2020', point: [-7, -3, 300], normal: [0, 1, 0], axis: 0, side: -1 },
    { spec: '2040', point: [5, 13, 300], normal: [0, -1, 0], axis: 0, side: 1 },
    { spec: '2040', point: [-5, 13, 300], normal: [0, -1, 0], axis: 0, side: -1 },
    { spec: '3040', point: [8, 14, 300], normal: [0, -1, 0], axis: 0, side: 1 },
    { spec: '4040', point: [14, 15, 300], normal: [-1, 0, 0], axis: 1, side: 1 },
  ]

  it.each(cases)('$spec wall at $point uses its owning side instead of its triangle normal', ({ spec, point, normal, axis, side }) => {
    const p = buildProfile(new THREE.Vector3(), new THREE.Vector3(0, 0, 600), spec)!
    const hit = { profileId: p.id, point: new THREE.Vector3(...point), normal: new THREE.Vector3(...normal) }
    const picked = modelPointFromHit(hit, [p])!
    expect(picked.face).toEqual({ profileId: p.id, axis, side })
    expect(picked.point.toArray()).toEqual([0, 0, 300])
    expect(picked.normal!.toArray()).toEqual(normal)
    expect(hit.point.toArray()).toEqual(point)
    expect(hit.normal.toArray()).toEqual(normal)
  })

  it('classifies the same rectangular slot after arbitrary direction and section roll', () => {
    const p = buildProfile(new THREE.Vector3(20, 40, 60), new THREE.Vector3(320, 440, 660), '2040')!
    const q = new THREE.Quaternion(...p.quaternion)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 5))
    p.quaternion = q.toArray()
    const origin = new THREE.Vector3(...p.position)
    const hit = { profileId: p.id,
      point: new THREE.Vector3(5, 13, 300).applyQuaternion(q).add(origin),
      normal: new THREE.Vector3(0, -1, 0).applyQuaternion(q) }
    const picked = modelPointFromHit(hit, [p])!
    expect(picked.face).toEqual({ profileId: p.id, axis: 0, side: 1 })
    expect(picked.point.distanceTo(new THREE.Vector3(0, 0, 300).applyQuaternion(q).add(origin))).toBeLessThan(1e-8)
    expect(picked.normal!.toArray()).toEqual(hit.normal.toArray())
  })

  it('uses the hit triangle to disambiguate an outer corner shared by two reference faces', () => {
    const p = buildProfile(new THREE.Vector3(), new THREE.Vector3(0, 0, 600), '2040')!
    for (const axis of [0, 1] as const) {
      const normal = new THREE.Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, 0)
      const picked = modelPointFromHit({ profileId: p.id, point: new THREE.Vector3(10, 20, 300), normal }, [p])!
      expect(picked.face).toEqual({ profileId: p.id, axis, side: 1 })
    }
  })

  it('maps an actual raycast into the upper right slot of an extruded 2040 to the right reference face', () => {
    const p = buildProfile(new THREE.Vector3(), new THREE.Vector3(0, 0, 600), '2040')!
    const geometry = new THREE.ExtrudeGeometry(getProfileShape(p.spec), { depth: p.length, bevelEnabled: false })
    const material = new THREE.MeshBasicMaterial()
    const mesh = new THREE.Mesh(geometry, material)
    mesh.updateMatrixWorld()
    try {
      // Enter the slot through x=10,y=11 and meet its upper inner wall at x=5,y=13.
      const raycaster = new THREE.Raycaster(new THREE.Vector3(30, 3, 300), new THREE.Vector3(-25, 10, 0).normalize())
      const intersection = raycaster.intersectObject(mesh, false)[0]
      expect(intersection).toBeDefined()
      expect(intersection.point.distanceTo(new THREE.Vector3(5, 13, 300))).toBeLessThan(1e-6)
      const normal = intersection.face!.normal.clone().transformDirection(mesh.matrixWorld)
      expect(normal.distanceTo(new THREE.Vector3(0, -1, 0))).toBeLessThan(1e-6)
      const picked = modelPointFromHit({ profileId: p.id, point: intersection.point, normal }, [p], raycaster.ray)!
      expect(picked.face).toEqual({ profileId: p.id, axis: 0, side: 1 })
      expect(picked.point.toArray()).toEqual([0, 0, 300])
      expect(picked.normal!.toArray()).toEqual(normal.toArray())
    } finally { geometry.dispose(); material.dispose() }
  })

  it('keeps the slot owner when a raised work plane replaces the centerline hit height', () => {
    const p = buildProfile(new THREE.Vector3(100, 0, 200), new THREE.Vector3(100, 800, 200), '2040')!
    const q = new THREE.Quaternion(...p.quaternion)
    const hit = { profileId: p.id,
      point: new THREE.Vector3(5, 13, 300).applyQuaternion(q).add(new THREE.Vector3(...p.position)),
      normal: new THREE.Vector3(0, -1, 0).applyQuaternion(q) }
    const camera = cam(), cursor = toScreen(hit.point, camera, size)
    const picked = pickPoint(rayAt(camera, cursor), cursor, camera, size, [p], hit, 440)
    expect(picked.point.y).toBe(440)
    expect(picked.face).toEqual({ profileId: p.id, axis: 0, side: 1 })
    expect(picked.normal!.toArray()).toEqual(hit.normal.toArray())
  })

  it('preserves end-zone and end-cap priority over the owning slot face', () => {
    const p = buildProfile(new THREE.Vector3(), new THREE.Vector3(0, 0, 600), '2020')!
    const zone = modelPointFromHit({ profileId: p.id, point: new THREE.Vector3(3, 7, 10), normal: new THREE.Vector3(-1, 0, 0) }, [p])!
    expect(zone.point.toArray()).toEqual([0, 0, 0])
    expect(zone.face).toEqual({ profileId: p.id, axis: 2, side: -1 })
    const cap = modelPointFromHit({ profileId: p.id, point: new THREE.Vector3(3, 7, 590), normal: new THREE.Vector3(0, 0, 1) }, [p])!
    expect(cap.point.toArray()).toEqual([0, 0, 600])
    expect(cap.face).toEqual({ profileId: p.id, axis: 2, side: 1 })
  })
})

describe('remote drawing alignment uses the visible end plane', () => {
  it.each([100, -50])('aligns to the physical end with a %s mm end cut', (endCut) => {
    const c = cam()
    const reference = buildProfile(new THREE.Vector3(0, 10, 0), new THREE.Vector3(600, 10, 0), '2020')!
    reference.fixedTrims = { start: 0, end: endCut }
    const origin = new THREE.Vector3(0, 10, 300)
    const target = new THREE.Vector3(600 - endCut, 10, 300)
    const px = toScreen(target, c, size)
    const result = resolveAxisEnd(origin, rayAt(c, px), px, c, size, [reference], 'x')!
    expect(result.snapKind).toBe('align')
    expect(result.end.x).toBeCloseTo(target.x)
    expect(result.guide!.from.x).toBeCloseTo(target.x)
    expect(result.face).toEqual({ profileId: reference.id, axis: 2, side: 1 })
  })
})
