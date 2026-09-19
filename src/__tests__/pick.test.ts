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
