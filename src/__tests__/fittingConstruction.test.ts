import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { FittingData, HingeSide, Overlay } from '../store/useStore'
import { fittingParts, fittingSolids, hingeAxis, openTransform, type Board } from '../utils/fittingGeometry'

const EPS = 1e-7
const overlays: Overlay[] = ['full', 'half', 'inset']
const make = (patch: Partial<FittingData> = {}): FittingData => ({
  id: 'fit', kind: 'drawer', width: 580, height: 250, depth: 600, frame: 20,
  material: 'ply', position: [400, 300, 700], quaternion: [0, 0, 0, 1],
  open: 0, overlay: 'full', hinge: 'left', ...patch,
})
const boardBox = (b: Board) => {
  const box = new THREE.Box3()
  const q = new THREE.Quaternion(...b.quaternion)
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
    box.expandByPoint(new THREE.Vector3(x * b.width / 2, y * b.height / 2, z * b.thickness / 2)
      .applyQuaternion(q).add(new THREE.Vector3(...b.position)))
  }
  return box
}
const spanOverlap = (a: THREE.Box3, b: THREE.Box3, axis: 'x' | 'y' | 'z') =>
  Math.min(a.max[axis], b.max[axis]) - Math.max(a.min[axis], b.min[axis])

describe('a drawer front is attached to its box', () => {
  it.each([undefined, 0, 20, 40])('keeps its rear and runner clearance while reaching the front with frame %s', (frame) => {
    for (const overlay of overlays) {
      const f = make({ frame, overlay })
      const boards = fittingParts(f).boards
      const front = boardBox(boards.find((b) => b.role === 'front')!)
      const back = boardBox(boards.find((b) => b.role === 'back')!)
      const inner = boardBox(boards.find((b) => b.role === 'inner-front')!)
      const base = boardBox(boards.find((b) => b.role === 'base')!)
      const sides = boards.filter((b) => b.role === 'side').map(boardBox)
      expect(sides).toHaveLength(2)
      for (const side of sides) {
        // The front is screwed to real timber; opening it cannot reveal a floating gap.
        expect(side.max.z).toBeCloseTo(front.min.z, 7)
        expect(spanOverlap(side, front, 'x')).toBeGreaterThan(0)
        expect(spanOverlap(side, front, 'y')).toBeGreaterThan(0)
        expect(side.min.z + f.depth / 2).toBeCloseTo(20, 7)
      }
      expect(inner.max.z).toBeCloseTo(front.min.z, 7)
      expect(spanOverlap(inner, front, 'x')).toBeGreaterThan(0)
      expect(spanOverlap(inner, front, 'y')).toBeGreaterThan(0)
      expect(back.min.z + f.depth / 2).toBeCloseTo(20, 7)
      expect(sides[0].min.x + f.width / 2).toBeCloseTo(12.5, 7)
      expect(f.width / 2 - sides[1].max.x).toBeCloseTo(12.5, 7)
      // The bottom still meets the four box walls after the depth and centre change.
      expect(base.min.z).toBeCloseTo(back.max.z, 7)
      expect(base.max.z).toBeCloseTo(inner.min.z, 7)
      expect(base.min.x).toBeCloseTo(sides[0].max.x, 7)
      expect(base.max.x).toBeCloseTo(sides[1].min.x, 7)
      for (const b of boards) for (const size of [b.width, b.height, b.thickness]) {
        expect(Number.isFinite(size)).toBe(true)
        expect(size).toBeGreaterThan(0)
      }
    }
  })

  it('preserves the front-to-box joint when a rotated drawer opens', () => {
    const world = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -1.2, 0.1))
    const f = make({ frame: 40, quaternion: world.toArray() as FittingData['quaternion'] })
    const parts = fittingParts(f)
    const innerIndex = parts.boards.findIndex((b) => b.role === 'inner-front')
    const frontIndex = parts.boards.findIndex((b) => b.role === 'front')
    let previous = 0
    const outside = new THREE.Vector3(0, 0, 1).applyQuaternion(world)
    const closedFront = fittingSolids(f, 0)[frontIndex].center
    for (const open of [0, 0.5, 1]) {
      const solids = fittingSolids(f, open)
      const inner = solids[innerIndex], front = solids[frontIndex]
      const attachedFace = inner.center.clone().addScaledVector(inner.axes[2], inner.half.z)
      const frontBack = front.center.clone().addScaledVector(front.axes[2], -front.half.z)
      expect(attachedFace.sub(frontBack).dot(outside)).toBeCloseTo(0, 7)
      const travelled = front.center.clone().sub(closedFront).dot(outside)
      expect(travelled).toBeGreaterThanOrEqual(previous)
      previous = travelled
    }
    expect(previous).toBeGreaterThan(0)
  })
})

describe('an inset front fits inside the actual frame', () => {
  it.each(['door', 'drawer'] as const)('%s has a 3 mm edge gap and its face is flush with the frame', (kind) => {
    for (const frame of [0, 20, 40]) {
      const f = make({ kind, overlay: 'inset', frame })
      const front = boardBox(fittingParts(f).boards.find((b) => b.role === 'panel' || b.role === 'front')!)
      expect(front.min.x + f.width / 2).toBeCloseTo(3, 7)
      expect(f.width / 2 - front.max.x).toBeCloseTo(3, 7)
      expect(front.min.y + f.height / 2).toBeCloseTo(3, 7)
      expect(f.height / 2 - front.max.y).toBeCloseTo(3, 7)
      expect(front.max.z).toBeCloseTo(f.depth / 2 + frame, 7)
      const overlay = boardBox(fittingParts({ ...f, overlay: 'full' }).boards.find((b) => b.role === 'panel' || b.role === 'front')!)
      expect(overlay.min.z).toBeCloseTo(front.max.z, 7)
    }
  })

  it('leaves one 3 mm gap between stacked inset drawer fronts', () => {
    const lower = make({ overlay: 'inset', stacked: { above: true }, position: [0, 125, 0] })
    const upper = make({ overlay: 'inset', stacked: { below: true }, position: [0, 375, 0] })
    const a = boardBox(fittingParts(lower).boards.find((b) => b.role === 'front')!)
    const b = boardBox(fittingParts(upper).boards.find((b) => b.role === 'front')!)
    expect(b.min.y + upper.position[1] - a.max.y - lower.position[1]).toBeCloseTo(3, 7)
  })

  it.each(['left', 'right', 'top', 'bottom'] as HingeSide[])('uses the real %s edge for every overlay and keeps it fixed during opening', (hinge) => {
    for (const overlay of overlays) {
      const f = make({ kind: 'door', hinge, overlay, frame: 40 })
      const front = boardBox(fittingParts(f).boards.find((b) => b.role === 'panel')!)
      const { origin, axis } = hingeAxis(f)
      const horizontal = hinge === 'top' || hinge === 'bottom'
      const edgeAxis = horizontal ? 'y' : 'x'
      const edge = hinge === 'right' || hinge === 'top' ? front.max : front.min
      expect(origin[edgeAxis]).toBeCloseTo(edge[edgeAxis], 7)
      expect(origin.z).toBeCloseTo(front.max.z, 7)
      const free = front.getCenter(new THREE.Vector3())
      const closeZ = free.z
      for (const open of [0.1, 0.5, 1]) {
        const at = openTransform({ ...f, open })
        for (const p of [origin, origin.clone().addScaledVector(axis, 100)]) {
          expect(p.clone().applyQuaternion(at.quaternion).add(at.position).distanceTo(p)).toBeLessThan(EPS)
        }
        expect(free.clone().applyQuaternion(at.quaternion).add(at.position).z).toBeGreaterThan(closeZ)
      }
    }
  })
})
