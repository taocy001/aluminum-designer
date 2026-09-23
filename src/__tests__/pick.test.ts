import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { resolveAxisEnd, pickPoint, toScreen } from '../utils/pickUtils'
import { buildProfile } from '../utils/profileFactory'

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
