import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as THREE from 'three'
import { buildProfile } from '../utils/profileFactory'
import { setThroughRule, computeAllTrims } from '../utils/jointUtils'
import { findConflicts } from '../utils/analysis'
import { planRepair, unbuildable } from '../utils/repairJoints'
import type { ProfileData, ProfileSpec } from '../store/useStore'

beforeEach(() => setThroughRule('rails'))
afterAll(() => setThroughRule('rails'))

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const P = (sx: number, sy: number, sz: number, ex: number, ey: number, ez: number, spec: ProfileSpec = '2020'): ProfileData =>
  buildProfile(V(sx, sy, sz), V(ex, ey, ez), spec)!

const clashes = (ps: ProfileData[]) => findConflicts(ps, computeAllTrims(ps)).length

/**
 * The tool could say a joint had nowhere to bolt and do nothing about it. This is the doing.
 * What makes a greedy repair safe to put behind a button is that every step is scored, so the
 * worst case is that it stops early rather than that it makes a mess.
 */
describe('putting unbuildable joints right', () => {
  it('a 2040 rail centred on a 4040 post is turned rather than moved', () => {
    const post = P(0, 20, 0, 0, 820, 0, '4040')
    const rail = P(0, 400, 0, 600, 400, 0, '2040')
    const before = unbuildable([post, rail]).length
    expect(before).toBeGreaterThan(0)
    const { profiles, repair } = planRepair([post, rail])
    expect(repair.after).toBe(0)
    // turning keeps it where it is: a shift would have moved the line it sits on
    const after = profiles.find((p) => p.id === rail.id)!
    expect(after.position.map(Math.round)).toEqual(rail.position.map(Math.round))
    expect(after.length).toBe(rail.length)
  })

  it('it never makes the drawing worse', () => {
    const frame = [
      P(0, 0, 0, 0, 800, 0, '4040'), P(900, 0, 0, 900, 800, 0, '4040'),
      P(0, 0, 500, 0, 800, 500, '4040'), P(900, 0, 500, 900, 800, 500, '4040'),
      P(0, 40, 0, 900, 40, 0, '2040'), P(0, 40, 500, 900, 40, 500, '2040'),
      P(0, 780, 0, 900, 780, 0, '2040'), P(0, 780, 500, 900, 780, 500, '2040'),
    ]
    const was = { bad: unbuildable(frame).length, clash: clashes(frame) }
    const { profiles, repair } = planRepair(frame)
    expect(repair.after).toBeLessThanOrEqual(was.bad)
    expect(clashes(profiles)).toBeLessThanOrEqual(was.clash)
  })

  it('it leaves a drawing that is already right alone', () => {
    const fine = [
      P(0, 0, 0, 0, 800, 0), P(600, 0, 0, 600, 800, 0),
      P(0, 10, 0, 600, 10, 0), P(0, 790, 0, 600, 790, 0),
    ]
    expect(unbuildable(fine).length).toBe(0)
    const { repair } = planRepair(fine)
    expect(repair.steps).toEqual([])
  })

  it('it does not try to mend a pair no part is made for', () => {
    // 2020 onto 4040 share no edge, so it is not a fault to fix — it is not a joint
    const post = P(0, 20, 0, 0, 820, 0, '4040')
    const rail = P(0, 400, 0, 600, 400, 0, '2020')
    expect(unbuildable([post, rail])).toEqual([])
    expect(planRepair([post, rail]).repair.steps).toEqual([])
  })

  it('it keeps every member the length it was', () => {
    const frame = [
      P(0, 0, 0, 0, 800, 0, '4040'), P(900, 0, 0, 900, 800, 0, '4040'),
      P(0, 400, 0, 900, 400, 0, '2040'), P(0, 40, 0, 900, 40, 0, '2040'),
    ]
    const { profiles } = planRepair(frame)
    for (const p of profiles) {
      expect(p.length).toBe(frame.find((q) => q.id === p.id)!.length)
    }
  })

  it('it stops rather than wandering: the same drawing twice gives the same answer', () => {
    const frame = [
      P(0, 0, 0, 0, 800, 0, '4040'), P(900, 0, 0, 900, 800, 0, '4040'),
      P(0, 40, 0, 900, 40, 0, '2040'), P(0, 400, 0, 900, 400, 0, '2040'),
    ]
    const a = planRepair(frame.map((p) => ({ ...p })))
    const b = planRepair(frame.map((p) => ({ ...p })))
    expect(a.profiles.map((p) => [p.position, p.quaternion])).toEqual(b.profiles.map((p) => [p.position, p.quaternion]))
  })

  it('it converges: running it again finds nothing more to do', () => {
    const frame = [
      P(0, 0, 0, 0, 800, 0, '4040'), P(900, 0, 0, 900, 800, 0, '4040'),
      P(0, 0, 500, 0, 800, 500, '4040'), P(900, 0, 500, 900, 800, 500, '4040'),
      P(0, 40, 0, 900, 40, 0, '2040'), P(0, 400, 0, 900, 400, 0, '2040'),
    ]
    const once = planRepair(frame)
    const twice = planRepair(once.profiles)
    expect(twice.repair.steps.length).toBe(0)
  })
})
