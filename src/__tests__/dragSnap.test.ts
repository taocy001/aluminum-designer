import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { buildProfile } from '../utils/profileFactory'
import { computeDragSnap, memberBox, alignThreshold, snapProfilePosition } from '../utils/dragSnap'
import { computeTrims, getThroughRule, setThroughRule } from '../utils/jointUtils'
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

describe('visible end planes and stable drag intent', () => {
  it('prefers a nearby end plane over centering rails of different lengths', () => {
    const fixed = P(0, 10, 0, 600, 10, 0)
    const moving = P(0, 10, 100, 590, 10, 100)
    const snap = computeDragSnap([moving], at(moving, [7, 10, 100]), [fixed], 20, [], [0])
    expect(snap.offset.x).toBe(3)
    expect(snap.guides).toEqual([{ axis: 0, kind: 'end', coord: 600, refId: fixed.id,
      movingId: moving.id, movingSide: 1, refSide: 1 }])
  })

  it('defaults to end alignment for a 560 mm rail near a 600 mm rail, while allowing precise centering', () => {
    const fixed = P(0, 10, 0, 600, 10, 0)
    const moving = P(0, 10, 100, 560, 10, 100)
    const snap = computeDragSnap([moving], at(moving, [15, 10, 100]), [fixed], 20, [], [0])
    expect(snap.offset.x).toBe(-15)
    expect(snap.guides[0]).toMatchObject({ kind: 'end', movingSide: -1, refSide: -1, coord: 0 })
    const centered = computeDragSnap([moving], at(moving, [20, 10, 100]), [fixed], 20, snap.guides, [0])
    expect(centered.offset.x).toBe(0)
    expect(centered.guides).toEqual([])
    const deliberate = computeDragSnap([moving], at(moving, [20.4, 10, 100]), [fixed], 20, snap.guides, [0])
    expect(deliberate.offset.x).toBe(-0.4)
    expect(deliberate.guides[0].kind).toBe('center')
  })

  it('describes low/high end planes consistently for members drawn backwards', () => {
    const fixed = P(600, 10, 0, 0, 10, 0)
    const moving = P(407, 10, 100, 7, 10, 100)
    const snap = computeDragSnap([moving], at(moving, moving.position), [fixed], 20, [], [0])
    expect(snap.offset.x).toBe(-7)
    expect(snap.guides[0]).toMatchObject({ kind: 'end', coord: 0, movingSide: -1, refSide: -1 })
  })

  it('reports end-to-end contact, including the two different face sides', () => {
    const fixed = P(0, 10, 0, 600, 10, 0)
    const moving = P(607, 10, 0, 1007, 10, 0)
    const snap = computeDragSnap([moving], at(moving, moving.position), [fixed], 20, [], [0])
    expect(snap.offset.x).toBe(-7)
    expect(snap.guides[0]).toMatchObject({ kind: 'end', coord: 600, movingSide: -1, refSide: 1 })
  })

  it('keeps an engaged end visible at zero and releases it beyond the hold window', () => {
    const fixed = P(0, 10, 0, 600, 10, 0)
    const moving = P(0, 10, 100, 400, 10, 100)
    const initial = computeDragSnap([moving], at(moving, [3, 10, 100]), [fixed], 20, [], [0])
    const exact = computeDragSnap([moving], at(moving, [0, 10, 100]), [fixed], 20, initial.guides, [0])
    expect(exact.offset.x).toBe(0)
    expect(exact.guides).toEqual(initial.guides)
    expect(computeDragSnap([moving], at(moving, [0, 10, 100]), [fixed], 20, [], [0]).guides).toEqual([])
    const held = computeDragSnap([moving], at(moving, [24, 10, 100]), [fixed], 20, initial.guides, [0])
    expect(held.offset.x).toBe(-24)
    expect(held.guides[0]).toMatchObject({ kind: 'end', movingSide: -1, refSide: -1 })
    const released = computeDragSnap([moving], at(moving, [29, 10, 100]), [fixed], 20, held.guides, [0])
    expect(released.guides).toEqual([])
    expect(released.offset.lengthSq()).toBe(0)
  })

  it('holds one end through small pointer jitter, but clearing prior intent restores nearest selection', () => {
    const fixed = P(0, 10, 0, 600, 10, 0)
    const moving = P(0, 10, 100, 590, 10, 100)
    const initial = computeDragSnap([moving], at(moving, [4, 10, 100]), [fixed], 20, [], [0])
    expect(initial.guides[0].movingSide).toBe(-1)
    const held = computeDragSnap([moving], at(moving, [5.6, 10, 100]), [fixed], 20, initial.guides, [0])
    expect(held.offset.x).toBe(-5.6)
    const fresh = computeDragSnap([moving], at(moving, [5.6, 10, 100]), [fixed], 20, [], [0])
    expect(fresh.offset.x).toBe(4.4)
    const changed = computeDragSnap([moving], at(moving, [11, 10, 100]), [fixed], 20, held.guides, [0])
    expect(changed.offset.x).toBe(-1)
    expect(changed.guides[0].movingSide).toBe(1)
  })

  it('uses the rendered cut end instead of the centerline endpoint', () => {
    const rule = getThroughRule()
    try {
      setThroughRule('posts')
      const fixed = P(0, 10, 0, 600, 10, 0)
      const post = P(600, 0, 0, 600, 500, 0)
      const moving = P(-7, 10, 100, 593, 10, 100)
      const snap = computeDragSnap([moving], at(moving, moving.position), [fixed, post], 20, [], [0])
      expect(snap.offset.x).toBe(-3)
      expect(snap.guides[0]).toMatchObject({ kind: 'end', coord: 590, refId: fixed.id })
      const final = { ...moving, position: [moving.position[0] + snap.offset.x, 10, 100] as [number, number, number] }
      const trims = computeTrims(final, [fixed, post, final])
      expect(final.position[0] + final.length - trims.end.trim).toBe(snap.guides[0].coord)
    } finally { setThroughRule(rule) }
  })

  it('names the actual outermost group member that supplies an end face', () => {
    const fixed = P(0, 10, 0, 600, 10, 0)
    const a = P(7, 10, 100, 407, 10, 100)
    const b = P(107, 10, 160, 307, 10, 160)
    const snap = computeDragSnap([a, b], new Map([[a.id, a.position], [b.id, b.position]]), [fixed], 20, [], [0])
    expect(snap.offset.x).toBe(-7)
    expect(snap.guides[0]).toMatchObject({ kind: 'end', movingId: a.id, movingSide: -1 })
  })

  it('withdraws an end-plane claim when the combined lateral snap changes its cut', () => {
    const rule = getThroughRule()
    try {
      setThroughRule('posts')
      const fixed = P(0, 10, 0, 600, 10, 0)
      const post = P(600, 0, 20, 600, 500, 20)
      const moving = P(207, 10, 8.9, 607, 10, 8.9)
      const snap = computeDragSnap([moving], at(moving, moving.position), [fixed, post], 20,
        [{ axis: 2, kind: 'face', coord: 10, refId: fixed.id, movingId: moving.id, movingSide: -1, refSide: 1 }], [0, 2])
      expect(snap.offset.z).toBe(11.1)
      expect(snap.offset.x).toBe(0)
      expect(snap.guides.some((g) => g.kind === 'end')).toBe(false)
      expect(snap.refIds).toEqual([...new Set(snap.guides.map((g) => g.refId))])
    } finally { setThroughRule(rule) }
  })

  it('does not claim side contact when the through rule extends the moving end past it', () => {
    const rule = getThroughRule()
    try {
      setThroughRule('rails')
      const post = P(0, 0, 0, 0, 400, 0)
      const moving = P(15, 400, 0, 615, 400, 0)
      const snap = computeDragSnap([moving], at(moving, moving.position), [post], 20, [], [0, 2])
      expect(snap.offset.x).toBe(0)
      expect(snap.guides.filter((g) => g.axis === 0)).toEqual([])
      expect(snap.refIds).toEqual([])
    } finally { setThroughRule(rule) }
  })

  it('ignores distant cabinets sharing a coordinate and does not call an oblique box an end face', () => {
    const fixed = P(0, 10, 1000, 600, 10, 1000)
    const moving = P(7, 10, 0, 407, 10, 0)
    expect(computeDragSnap([moving], at(moving, moving.position), [fixed]).guides).toEqual([])
    const oblique = P(0, 10, 100, 400, 10, 500)
    const snap = computeDragSnap([oblique], at(oblique, [7, 10, 100]), [P(0, 10, 0, 600, 10, 0)])
    expect(snap.guides.every((g) => g.kind !== 'end')).toBe(true)
    expect(snap.guides.find((g) => g.axis === 0)?.kind).toBe('align')
  })

  it('labels an oblique reference extreme as coordinate alignment rather than a real face', () => {
    const fixed = P(0, 10, 0, 400, 10, 400)
    const moving = P(-6, 10, 100, 394, 10, 100)
    const snap = computeDragSnap([moving], at(moving, moving.position), [fixed], 20, [], [0])
    expect(snap.offset.x).toBeCloseTo(-1.071, 3)
    expect(snap.guides[0]).toMatchObject({ kind: 'align', axis: 0 })
  })

  it('does not describe the box of a rolled cross-section as a real side face', () => {
    for (const rollMoving of [true, false]) {
      const fixed = P(0, 30, 0, 600, 30, 0)
      const moving = P(0, 30, 27, 400, 30, 27)
      const rolled = rollMoving ? moving : fixed
      const q = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), Math.PI / 4)
        .multiply(new THREE.Quaternion(...rolled.quaternion))
      rolled.quaternion = q.toArray()
      const snap = computeDragSnap([moving], at(moving, moving.position), [fixed], 20, [], [2])
      expect(snap.offset.z).toBeCloseTo(-2.858, 3)
      expect(snap.guides[0]).toMatchObject({ kind: 'align', axis: 2 })
      const held = computeDragSnap([moving], at(moving, [0, 30, 27 + snap.offset.z]), [fixed], 20, snap.guides, [2])
      expect(held.guides[0].kind).toBe('align')
    }
  })

  it('solves only permitted axes and reports only their actual reference IDs', () => {
    const xRef = P(0, 10, 0, 600, 10, 0)
    const yRef = P(1000, 12, 0, 1600, 12, 0)
    const moving = P(7, 13, 100, 407, 13, 100)
    const snap = computeDragSnap([moving], at(moving, moving.position), [xRef, yRef], 20, [], [0, 2])
    expect(snap.offset.y).toBe(0)
    expect(snap.axes).not.toContain(1)
    expect(snap.refIds).toEqual([xRef.id])
  })
})

describe('endpoint snaps preserve the drag plane or axis', () => {
  const size = { width: 1000, height: 800 }
  const camera = new THREE.PerspectiveCamera(45, size.width / size.height, 1, 100000)
  camera.position.set(900, 800, 900); camera.lookAt(0, 100, 0); camera.updateMatrixWorld(); camera.updateProjectionMatrix()
  const moving = P(0, 10, 0, 100, 10, 0)

  it('rejects a nearby endpoint requiring movement off the locked axis', () => {
    const offAxis = P(107, 15, 0, 107, 500, 0)
    expect(snapProfilePosition(moving, V(0, 10, 0), [offAxis], camera, size).refId).toBe(offAxis.id)
    const constrained = snapProfilePosition(moving, V(0, 10, 0), [offAxis], camera, size, 0)
    expect(constrained.refId).toBeNull()
    expect(constrained.position.toArray()).toEqual([0, 10, 0])
  })

  it('keeps horizontal placement at its existing height while accepting a true X-only join', () => {
    const high = P(107, 15, 0, 107, 500, 0)
    expect(snapProfilePosition(moving, V(0, 10, 0), [high], camera, size, null, [0, 2]).refId).toBeNull()
    const level = P(107, 10, 0, 107, 500, 0)
    expect(snapProfilePosition(moving, V(0, 10, 0), [level], camera, size, 0).position.toArray()).toEqual([7, 10, 0])
  })

  it('does not pull a vertical-only adjustment sideways', () => {
    const offPlane = P(100, 17, 5, 100, 500, 5)
    expect(snapProfilePosition(moving, V(0, 10, 0), [offPlane], camera, size, null, [1]).refId).toBeNull()
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
