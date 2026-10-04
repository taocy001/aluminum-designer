import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import * as bracketSeats from '../utils/bracketSeat'
import { actualTouching, supportsProfileJoint, unsupportedProfileJoint } from '../utils/connectorSupport'
import { auditBrackets, seatFor } from '../utils/bracketSeat'
import { connectorHitsBody } from '../utils/connectorCollision'
import { trimmedOBB } from '../utils/analysis'
import { buildProfile } from '../utils/profileFactory'
import { computeAllTrims, setThroughRule } from '../utils/jointUtils'
import { findSpecMismatches } from '../utils/specCompat'
import { unflushPairs } from '../utils/faceAlign'
import { joints, unbuildable } from '../utils/repairJoints'
import type { ProfileSpec } from '../store/useStore'

beforeEach(() => setThroughRule('rails'))
afterAll(() => setThroughRule('rails'))
afterEach(() => vi.restoreAllMocks())
const V = (x: number, y: number, z = 0) => new THREE.Vector3(x, y, z)
const at = V(0, 100)
const frame = (length = 200, rail: ProfileSpec = '2020', post = rail, offset = 0) => [
  { ...buildProfile(V(0, 100, offset), V(length, 100, offset), rail)!, id: 'rail' },
  { ...buildProfile(V(0, 100), V(0, 100 + length), post)!, id: 'post' },
]

describe('verified pair support', () => {
  it('rejects a raw geometric seat when short members cannot support its mounting holes', () => {
    const [a, b] = frame(20)
    expect(seatFor('inside-corner', a, b, at)).not.toBeNull()
    expect(supportsProfileJoint(a, b, at)).toBe(false)
    expect(findSpecMismatches([a, b])).toHaveLength(1)
    expect(unflushPairs([a, b])).toHaveLength(1)
    expect(unbuildable([a, b]).length).toBeGreaterThan(0)
  })

  it('keeps searching when the first aligned inner casting collides with its host', () => {
    const [a, b] = frame(), profiles = [a, b], trims = computeAllTrims(profiles)
    const first = { id: 'first', type: 'inside-corner', ...seatFor('inside-corner', a, b, at)! }
    expect(auditBrackets(profiles, [first], trims)).toEqual([])
    expect(profiles.some((p) => connectorHitsBody(first, trimmedOBB(p, trims.get(p.id)!)))).toBe(true)
    expect(supportsProfileJoint(a, b, at, trims)).toBe(true)
    expect(findSpecMismatches(profiles)).toEqual([])
  })

  it.each([
    ['2020', '2020', 0], ['2020', '2040', 10], ['3030', '3030', 0],
    ['3030', '4040', 0], ['4040', '3030', 0], ['4040', '4040', 0],
  ] as const)('retains actual compatible %s/%s joints at offset %s', (rail, post, offset) => {
    const [a, b] = frame(200, rail, post, offset)
    expect(supportsProfileJoint(a, b, V(0, 100, offset))).toBe(true)
  })

  it('does not infer B6/I8 compatibility from a shared outside edge', () => {
    const [a, b] = frame(200, '2040', '4040')
    expect(supportsProfileJoint(a, b, at)).toBe(false)
    expect(actualTouching(a, b)).toBe(true)
    expect(unsupportedProfileJoint(a, b, at)).toBe(true)
    expect(findSpecMismatches([a, b])).toHaveLength(1)
  })

  it.each([20, 30])('does not call neighbouring shelf rails with a %s mm physical gap an unsupported joint', (gap) => {
    const a = { ...buildProfile(V(0, 100), V(100, 100), '2020')!, id: 'left-shelf-front',
      fixedTrims: { start: 0, end: 10 } }
    const b = { ...buildProfile(V(100 + gap, 100), V(100 + gap, 100, 100), '2020')!, id: 'right-shelf-side',
      fixedTrims: { start: 10, end: 0 } }
    // Their design endpoint/axis is only 20/30 mm apart, so the old search includes
    // them. Their cut bodies belong to adjacent shelves and do not touch.
    expect(seatFor('bracket', a, b, V(100, 100))).not.toBeNull()
    expect(supportsProfileJoint(a, b, V(100, 100))).toBe(false)
    for (const q of [new THREE.Quaternion(), new THREE.Quaternion().setFromEuler(new THREE.Euler(.2, .4, .3))]) {
      const profiles = [a, b].map((p) => ({ ...p,
        position: new THREE.Vector3(...p.position).applyQuaternion(q).toArray(),
        quaternion: q.clone().multiply(new THREE.Quaternion(...p.quaternion)).toArray(),
      }))
      expect(actualTouching(profiles[0], profiles[1])).toBe(false)
      expect(findSpecMismatches(profiles)).toEqual([])
      expect(unflushPairs(profiles)).toEqual([])
      expect(unbuildable(profiles)).toEqual([])
      expect(joints(profiles)).toEqual([])
    }
  })

  it('retains a real connector bridging a gap between the two cut bodies', () => {
    const [a, b] = frame()
    b.fixedTrims = { start: 15, end: 0 }
    expect(actualTouching(a, b)).toBe(false) // Rail top Y110; post starts Y115.
    expect(supportsProfileJoint(a, b, at)).toBe(true)
    expect(unsupportedProfileJoint(a, b, at)).toBe(false)
    expect(joints([a, b]).length).toBeGreaterThan(0)
    expect(findSpecMismatches([a, b])).toEqual([])
  })

  it('skips hardware enumeration for separated bodies but still audits a real contact', () => {
    const [a, b] = frame(217)
    b.fixedTrims = { start: 15, end: 0 }
    const seats = vi.spyOn(bracketSeats, 'seatsFor')
    const audit = vi.spyOn(bracketSeats, 'auditBrackets')
    expect(actualTouching(a, b)).toBe(false)
    expect(unsupportedProfileJoint(a, b, at)).toBe(false)
    expect(seats).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
    b.fixedTrims.start = 0
    expect(actualTouching(a, b)).toBe(true)
    expect(unsupportedProfileJoint(a, b, at)).toBe(false)
    expect(seats).toHaveBeenCalled()
    expect(audit).toHaveBeenCalled()
  })

  it('applies the contact tolerance to actual cut bodies and invalidates an in-place contact edit', () => {
    const a = { ...buildProfile(V(0, 100), V(100, 100), '2020')!, id: 'a', fixedTrims: { start: 0, end: 0 } }
    const b = { ...buildProfile(V(110.5, 100, 10), V(110.5, 100, 100), '2020')!, id: 'b', fixedTrims: { start: 0, end: 0 } }
    expect(actualTouching(a, b)).toBe(true)
    b.position[0] = 110.6
    expect(actualTouching(a, b)).toBe(false)
    b.position[0] = 110.5
    expect(actualTouching(a, b)).toBe(true)
  })

  it('invalidates cached results after in-place length, pose, section or trim changes', () => {
    const [a, b] = frame(), original = structuredClone(a)
    expect(supportsProfileJoint(a, b, at)).toBe(true)
    a.length = 10
    expect(supportsProfileJoint(a, b, at)).toBe(false)
    Object.assign(a, structuredClone(original))
    a.position[2] = 7
    expect(supportsProfileJoint(a, b, at)).toBe(false)
    Object.assign(a, structuredClone(original))
    a.quaternion.splice(0, 4, ...b.quaternion)
    expect(supportsProfileJoint(a, b, at)).toBe(false)
    Object.assign(a, structuredClone(original))
    a.spec = '4040'
    expect(supportsProfileJoint(a, b, at)).toBe(false)
    Object.assign(a, structuredClone(original))
    const trims = computeAllTrims([a, b]), cut = trims.get(a.id)!
    const before = structuredClone(cut)
    expect(supportsProfileJoint(a, b, at, trims)).toBe(true)
    cut.start.trim = 80
    cut.cutLength -= 80 - before.start.trim
    expect(supportsProfileJoint(a, b, at, trims)).toBe(false)
    Object.assign(cut, before)
    expect(supportsProfileJoint(a, b, at, trims)).toBe(true)
  })
})
