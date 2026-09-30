import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as THREE from 'three'
import { buildProfile } from '../utils/profileFactory'
import { setThroughRule, computeAllTrims, withFixedProfileCuts } from '../utils/jointUtils'
import { findConflicts } from '../utils/analysis'
import { planRepair, repairJoints, unbuildable } from '../utils/repairJoints'
import { useStore, type ProfileData, type ProfileSpec } from '../store/useStore'

beforeEach(() => setThroughRule('rails'))
afterAll(() => setThroughRule('rails'))

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const P = (sx: number, sy: number, sz: number, ex: number, ey: number, ez: number, spec: ProfileSpec = '2020'): ProfileData =>
  buildProfile(V(sx, sy, sz), V(ex, ey, ez), spec)!

const clashes = (ps: ProfileData[]) => findConflicts(ps, computeAllTrims(ps)).length

/** Repairs must reduce the joint score and preserve the checked geometric constraints. */
describe('putting unbuildable joints right', () => {
  it('does not report a repair that would require moving a locked member', () => {
    const profiles = [P(0, 0, 0, 0, 800, 0, '4040'), P(0, 400, 0, 600, 400, 0, '2040')]
      .map((p) => ({ ...p, locked: true }))
    useStore.getState().loadDocument({ profiles, connectors: [], panels: [], fittings: [], throughRule: 'rails' })
    const before = useStore.getState()
    const repair = repairJoints()
    expect(repair.before).toBeGreaterThan(0)
    expect(repair.after).toBe(repair.before)
    expect(repair.steps).toEqual([])
    expect(useStore.getState().profiles).toBe(before.profiles)
    expect(useStore.getState().past).toBe(before.past)
  })

  it('commits the geometry it evaluated and preserves actual cut lengths in one undo', () => {
    const profiles = [P(0, 0, 0, 0, 800, 0, '4040'), P(0, 400, 0, 600, 400, 0, '2040')]
    useStore.getState().loadDocument({ profiles, connectors: [], panels: [], fittings: [], throughRule: 'rails' })
    const before = useStore.getState()
    const cuts = computeAllTrims(profiles)
    const planned = planRepair(withFixedProfileCuts(profiles))
    expect(planned.repair.steps.length).toBeGreaterThan(0)
    expect(repairJoints()).toEqual(planned.repair)
    const after = useStore.getState()
    expect(after.profiles).toEqual(planned.profiles)
    for (const [id, t] of computeAllTrims(after.profiles)) expect(t.cutLength).toBe(cuts.get(id)!.cutLength)
    expect(after.past.length).toBe(before.past.length + 1)
    after.undo()
    expect(useStore.getState().profiles).toEqual(before.profiles)
  })

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

/** Repairs must preserve existing contacts, including joints removed from the score by disconnection. */
describe('a repair may not solve a joint by walking away from it', () => {
  const joinedEnds = (ps: ProfileData[]) => {
    let n = 0
    for (const a of ps) {
      const ea = { s: new THREE.Vector3(...a.position) }
      for (const b of ps) {
        if (a.id === b.id) continue
        const bs = new THREE.Vector3(...b.position)
        if (ea.s.distanceTo(bs) < 30) n++
      }
    }
    return n
  }

  it('keeps every member meeting what it met before', () => {
    // a bay: two posts, a rail across the top of each face, and a cross rail between them
    const frame = [
      P(0, 0, 0, 0, 2400, 0, '4040'),
      P(0, 0, 600, 0, 2400, 600, '4040'),
      P(1000, 0, 0, 1000, 2400, 0, '4040'),
      P(1000, 0, 600, 1000, 2400, 600, '4040'),
      P(0, 20, 0, 1000, 20, 0, '2040'),
      P(0, 20, 600, 1000, 20, 600, '2040'),
      P(0, 20, 0, 0, 20, 600, '2040'),
      P(1000, 20, 0, 1000, 20, 600, '2040'),
    ]
    const linkedBefore = joinedEnds(frame)
    const { profiles, repair } = planRepair(frame)
    expect(repair.after).toBe(0)
    expect(clashes(profiles)).toBeLessThanOrEqual(clashes(frame))
    // nothing was solved by moving a member out of reach of its neighbour
    expect(joinedEnds(profiles)).toBeGreaterThanOrEqual(linkedBefore)
    // and no post left its bay line by more than the width of a slot
    for (const [i, p] of profiles.entries()) {
      if (!p.spec.startsWith('40')) continue
      const was = frame[i].position
      expect(Math.hypot(p.position[0] - was[0], p.position[2] - was[2])).toBeLessThanOrEqual(20)
    }
  })
})

import { countUnflush } from '../utils/faceAlign'

/** Mixed sections are accepted when a supported connector can be seated. */
describe('one joint, one answer', () => {
  const wardrobe = (): ProfileData[] => {
    const out: ProfileData[] = []
    for (const x of [0, 600, 1200]) for (const z of [0, 600]) out.push(P(x, 0, z, x, 2200, z, '4040'))
    for (const y of [20, 2180]) {
      for (const [a, b] of [[0, 600], [600, 1200]]) for (const z of [0, 600]) out.push(P(a, y, z, b, y, z, '2040'))
      for (const x of [0, 600, 1200]) out.push(P(x, y, 0, x, y, 600, '2040'))
    }
    return out
  }

  it('what cannot be built, what cannot be repaired and what cannot be bolted agree', () => {
    const frame = wardrobe()
    const { profiles } = planRepair(frame)
    expect(unbuildable(profiles).length).toBe(0)
    expect(countUnflush(profiles)).toBe(0)
  })

  it('and a pairing no part is made for is still counted', () => {
    // 2020 butted onto 4040: no common edge, so nothing in the catalogue joins them
    const odd = [P(0, 0, 0, 0, 800, 0, '4040'), P(0, 400, 0, 600, 400, 0, '2020')]
    expect(countUnflush(odd)).toBeGreaterThan(0)
  })
})
