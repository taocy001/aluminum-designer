import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { buildProfile } from '../utils/profileFactory'
import { computeDragSnap, memberBox, alignThreshold } from '../utils/dragSnap'
import type { ProfileData, ProfileSpec } from '../store/useStore'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
function P(sx: number, sy: number, sz: number, ex: number, ey: number, ez: number, spec: ProfileSpec = '2020'): ProfileData {
  const p = buildProfile(V(sx, sy, sz), V(ex, ey, ez), spec)
  if (!p) throw new Error('bad profile')
  return p
}
const at = (p: ProfileData, pos: [number, number, number]) => new Map([[p.id, pos]])

describe('alignment snapping while dragging', () => {
  it('pulls a near-miss into face contact', () => {
    const fixed = P(0, 10, 0, 600, 10, 0)          // occupies z −10..10
    const moving = P(0, 10, 100, 600, 10, 100)
    // proposed 3 mm away from touching (z = 23 → faces at 13)
    const snap = computeDragSnap([moving], at(moving, [0, 10, 23]), [fixed])
    expect(snap.axes).toContain(2)
    expect(snap.refIds).toEqual([fixed.id])
    const box = memberBox(moving, [0, 10, 23 + snap.offset.z])
    expect(Math.round(box.min.z)).toBe(10)          // flush against the other face
  })

  it('snaps onto a shared centreline when that is nearer', () => {
    const fixed = P(0, 10, 0, 600, 10, 0)
    const moving = P(0, 10, 0, 600, 10, 0)
    const snap = computeDragSnap([moving], at(moving, [0, 10, 4]), [fixed])
    expect(Math.round(snap.offset.z)).toBe(-4)      // centre to centre
  })

  it('aligns flush edges on the low side', () => {
    const fixed = P(0, 10, 0, 600, 10, 0)           // x from 0 to 600
    const moving = P(0, 10, 200, 400, 10, 200)
    const snap = computeDragSnap([moving], at(moving, [7, 10, 200]), [fixed])
    expect(Math.round(snap.offset.x)).toBe(-7)      // starts line up
  })

  it('leaves a member alone once it is further away than the profile width', () => {
    const fixed = P(0, 10, 0, 600, 10, 0)
    const moving = P(0, 10, 200, 600, 10, 200)
    const snap = computeDragSnap([moving], at(moving, [0, 10, 200]), [fixed])
    expect(snap.axes).toEqual([])
    expect(snap.offset.lengthSq()).toBe(0)
  })

  it('uses the widest member of the group as the pull distance', () => {
    expect(alignThreshold([P(0, 10, 0, 100, 10, 0, '2020')])).toBe(20)
    expect(alignThreshold([P(0, 20, 0, 100, 20, 0, '2040')])).toBe(40)
    expect(alignThreshold([P(0, 10, 0, 100, 10, 0, '2020'), P(0, 20, 0, 100, 20, 0, '4040')])).toBe(40)
  })

  it('moves a whole group by one offset, measured on the group box', () => {
    const fixed = P(0, 10, 0, 600, 10, 0)
    const a = P(0, 10, 100, 600, 10, 100)
    const b = P(0, 10, 160, 600, 10, 160)
    const proposed = new Map<string, [number, number, number]>([
      [a.id, [0, 10, 23]],
      [b.id, [0, 10, 83]],
    ])
    const snap = computeDragSnap([a, b], proposed, [fixed])
    expect(Math.round(snap.offset.z)).toBe(-3)      // the group's near face lands on the fixed face
  })

  it('reports nothing when there is nothing to align to', () => {
    const moving = P(0, 10, 0, 600, 10, 0)
    const snap = computeDragSnap([moving], at(moving, [0, 10, 0]), [])
    expect(snap.refIds).toEqual([])
  })
})

describe('incremental conflict check during a drag', () => {
  it('matches the full analysis for the moving member', async () => {
    const { movingPartsConflict, analyzeFrame } = await import('../utils/analysis')
    const a = P(0, 10, 0, 600, 10, 0)
    const b = P(0, 10, 300, 600, 10, 300)
    const crossing = P(300, 10, 0, 300, 10, 400)
    for (const scene of [[a, b], [a, b, crossing]]) {
      const full = analyzeFrame(scene)
      for (const p of scene) {
        expect(movingPartsConflict(scene, new Set([p.id]))).toBe(full.conflictIds.has(p.id))
      }
    }
  })
  it('is false when nothing is moving', async () => {
    const { movingPartsConflict } = await import('../utils/analysis')
    expect(movingPartsConflict([P(0, 10, 0, 600, 10, 0)], new Set())).toBe(false)
  })
})
