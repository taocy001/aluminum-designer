import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { FittingData, HingeSide, Overlay } from '../store/useStore'
import { fittingHandle, fittingParts, hingeAxis, openTransform } from '../utils/fittingGeometry'

const EPS = 1e-7
const SIDES: HingeSide[] = ['left', 'right', 'top', 'bottom']
const OVERLAYS: Overlay[] = ['full', 'half', 'inset']
const fitting = (patch: Partial<FittingData> = {}): FittingData => ({
  id: 'front', kind: 'door', width: 560, height: 720, depth: 440, frame: 20,
  position: [120, 430, -250], quaternion: [0, 0, 0, 1], material: 'mdf',
  hinge: 'left', hingeType: 'cup', overlay: 'full', swing: 110, open: 0,
  ...patch,
})
const frontOf = (f: FittingData) => fittingParts(f).boards.find((b) => b.role === 'panel' || b.role === 'front')!
type Block = ReturnType<typeof fittingHandle>['grip']

function expectBlockFitsFront(block: Block, f: FittingData) {
  const front = frontOf(f)
  expect(block.position.every(Number.isFinite)).toBe(true)
  for (const size of block.size) {
    expect(Number.isFinite(size)).toBe(true)
    expect(size).toBeGreaterThan(0)
  }
  for (const [axis, span] of [[0, front.width], [1, front.height]] as const) {
    const low = front.position[axis] - span / 2
    const high = front.position[axis] + span / 2
    expect(block.position[axis] - block.size[axis] / 2).toBeGreaterThanOrEqual(low - EPS)
    expect(block.position[axis] + block.size[axis] / 2).toBeLessThanOrEqual(high + EPS)
  }
}

function expectExteriorHandle(f: FittingData) {
  const front = frontOf(f)
  const { grip, mounts } = fittingHandle(f)
  const surface = front.position[2] + front.thickness / 2
  const gripBack = grip.position[2] - grip.size[2] / 2
  expect(grip.size[2]).toBeCloseTo(14, 7)
  expect(gripBack - surface).toBeCloseTo(18, 7)
  expectBlockFitsFront(grip, f)
  expect(mounts.length).toBeGreaterThan(0)
  for (const mount of mounts) {
    expectBlockFitsFront(mount, f)
    // Each support starts on the actual slab and reaches the grip, with no floating gap.
    expect(mount.position[2] - mount.size[2] / 2).toBeCloseTo(surface, 7)
    expect(mount.position[2] + mount.size[2] / 2).toBeGreaterThanOrEqual(gripBack - EPS)
    expect(mount.position[2] + mount.size[2] / 2).toBeLessThanOrEqual(grip.position[2] + grip.size[2] / 2 + EPS)
    for (const axis of [0, 1] as const) {
      const intersection = Math.min(mount.position[axis] + mount.size[axis] / 2, grip.position[axis] + grip.size[axis] / 2)
        - Math.max(mount.position[axis] - mount.size[axis] / 2, grip.position[axis] - grip.size[axis] / 2)
      expect(intersection).toBeGreaterThan(0)
    }
  }
}

const worldPoint = (p: THREE.Vector3, f: FittingData, open: number) => {
  const at = openTransform({ ...f, open })
  return p.clone().applyQuaternion(at.quaternion).add(at.position)
    .applyQuaternion(new THREE.Quaternion(...f.quaternion).normalize()).add(new THREE.Vector3(...f.position))
}

describe('fitting handles sit on the outside of the actual front', () => {
  it.each([undefined, 0, 20, 40])('clears frame %s for doors and drawers with every overlay', (frame) => {
    for (const kind of ['door', 'drawer'] as const) for (const overlay of OVERLAYS) {
      expectExteriorHandle(fitting({ kind, frame, overlay }))
    }
  })

  it.each(SIDES)('puts a %s-hinged door grip beside its free edge', (hinge) => {
    for (const overlay of OVERLAYS) {
      const f = fitting({ hinge, overlay })
      const front = frontOf(f), { grip } = fittingHandle(f)
      const horizontal = hinge === 'top' || hinge === 'bottom'
      const edgeAxis = horizontal ? 1 : 0
      const longAxis = horizontal ? 0 : 1
      const freeSign = hinge === 'left' || hinge === 'bottom' ? 1 : -1
      const span = horizontal ? front.height : front.width
      const towardEdge = freeSign * (grip.position[edgeAxis] - front.position[edgeAxis])
      expect(towardEdge).toBeGreaterThan(0)
      expect(span / 2 - towardEdge).toBeGreaterThanOrEqual(35)
      expect(span / 2 - towardEdge).toBeLessThanOrEqual(45)
      expect(grip.position[longAxis]).toBeCloseTo(front.position[longAxis], 7)
      expect(grip.size[longAxis]).toBeGreaterThan(grip.size[edgeAxis])
      expectExteriorHandle(f)
    }
  })

  it.each([{}, { above: true }, { below: true }, { above: true, below: true }])(
    'centres a horizontal drawer handle on the actual stacked front %j', (stacked) => {
      for (const overlay of OVERLAYS) {
        const f = fitting({ kind: 'drawer', height: 180, stacked, overlay })
        const front = frontOf(f), { grip } = fittingHandle(f)
        expect(grip.position[0]).toBeCloseTo(front.position[0], 7)
        expect(grip.position[1]).toBeCloseTo(front.position[1], 7)
        expect(grip.size[0]).toBeGreaterThan(grip.size[1])
        expectExteriorHandle(f)
      }
    },
  )

  it('keeps grips and mounts inside small, narrow and short fronts', () => {
    for (const [width, height] of [[20, 20], [20, 100], [100, 20], [60, 60]]) {
      for (const overlay of OVERLAYS) for (const hinge of SIDES) {
        expectExteriorHandle(fitting({ width, height, overlay, hinge }))
      }
      for (const overlay of OVERLAYS) for (const stacked of [{}, { above: true }, { below: true }]) {
        expectExteriorHandle(fitting({ kind: 'drawer', width, height, overlay, stacked }))
      }
    }
  })

  it('keeps its signed clearance while the fitting rotates and opens', () => {
    const rotations = [
      new THREE.Quaternion(),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, -0.7, 0.2)),
    ]
    for (const world of rotations) for (const kind of ['door', 'drawer'] as const) for (const hinge of SIDES) {
      const f = fitting({ kind, hinge, frame: 40, quaternion: world.toArray() as FittingData['quaternion'] })
      const front = frontOf(f), { grip } = fittingHandle(f)
      const surfacePoint = new THREE.Vector3(grip.position[0], grip.position[1], front.position[2] + front.thickness / 2)
      const gripBack = new THREE.Vector3(...grip.position).add(new THREE.Vector3(0, 0, -grip.size[2] / 2))
      for (const open of [0, 0.25, 0.5, 1]) {
        const at = openTransform({ ...f, open })
        const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(at.quaternion).applyQuaternion(world)
        const delta = worldPoint(gripBack, f, open).sub(worldPoint(surfacePoint, f, open))
        expect(delta.dot(normal)).toBeCloseTo(18, 7)
        expect(delta.clone().cross(normal).length()).toBeLessThan(EPS)
      }
    }
  })
})

describe('fitting motion agrees with its exterior handle', () => {
  it.each(SIDES)('opens the %s-hinged free edge outward and leaves the hinge line fixed', (hinge) => {
    const f = fitting({ hinge, swing: 110 })
    const front = frontOf(f), pivot = hingeAxis(f)
    const edge = new THREE.Vector3(...front.position)
    if (hinge === 'left') edge.x += front.width / 2
    if (hinge === 'right') edge.x -= front.width / 2
    if (hinge === 'top') edge.y -= front.height / 2
    if (hinge === 'bottom') edge.y += front.height / 2
    const closed = worldPoint(edge, f, 0)
    for (const open of [0.01, 0.1, 0.5]) {
      expect(worldPoint(edge, f, open).sub(closed).z).toBeGreaterThan(0)
    }
    for (const open of [0, 0.25, 0.5, 1]) {
      for (const axisPoint of [pivot.origin, pivot.origin.clone().addScaledVector(pivot.axis, 100)]) {
        expect(worldPoint(axisPoint, f, open).distanceTo(worldPoint(axisPoint, f, 0))).toBeLessThan(EPS)
      }
    }
  })

  it('slides a drawer outward in its own facing direction without turning', () => {
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const world = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
      const f = fitting({ kind: 'drawer', frame: 40, quaternion: world.toArray() as FittingData['quaternion'] })
      const point = new THREE.Vector3(...frontOf(f).position)
      const outward = new THREE.Vector3(0, 0, 1).applyQuaternion(world)
      const closed = worldPoint(point, f, 0)
      let lastDistance = 0
      for (const open of [0.1, 0.5, 1]) {
        const delta = worldPoint(point, f, open).sub(closed)
        expect(delta.dot(outward)).toBeGreaterThan(lastDistance)
        expect(delta.clone().cross(outward).length()).toBeLessThan(EPS)
        expect(openTransform({ ...f, open }).quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(EPS)
        lastDistance = delta.dot(outward)
      }
    }
  })
})
