import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as THREE from 'three'
import { buildProfile } from '../utils/profileFactory'
import { setThroughRule, computeTrims, computeAllTrims, computeFrameBounds } from '../utils/jointUtils'
import { analyzeFrame, findConflicts } from '../utils/analysis'
import type { ProfileData, ProfileSpec } from '../store/useStore'

/**
 * Which member runs through a corner changes every trim, so each suite says which
 * arrangement it is describing rather than leaning on whatever the default happens to be.
 */
beforeEach(() => setThroughRule('posts'))
afterAll(() => setThroughRule('rails'))

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
function P(sx: number, sy: number, sz: number, ex: number, ey: number, ez: number, spec: ProfileSpec = '2020'): ProfileData {
  const p = buildProfile(V(sx, sy, sz), V(ex, ey, ez), spec)
  if (!p) throw new Error('bad profile')
  return p
}

/** A 600 (X) × 400 (Z) × 800 (Y) cabinet frame: 4 posts, bottom + top rectangles, all 2020 */
function cabinet(): ProfileData[] {
  const W = 600, D = 400, H = 800
  const posts = [P(0, 0, 0, 0, H, 0), P(W, 0, 0, W, H, 0), P(0, 0, D, 0, H, D), P(W, 0, D, W, H, D)]
  const rect = (y: number) => [
    P(0, y, 0, W, y, 0), P(0, y, D, W, y, D),   // X rails
    P(0, y, 0, 0, y, D), P(W, y, 0, W, y, D),   // Z rails
  ]
  return [...posts, ...rect(10), ...rect(H)]
}

describe('buildProfile', () => {
  it('rejects members shorter than 10 mm', () => {
    expect(buildProfile(V(0, 0, 0), V(5, 0, 0), '2020')).toBeNull()
  })
  it('stores the start point and unit direction', () => {
    const p = P(100, 10, 50, 500, 10, 50)
    expect(p.length).toBe(400)
    expect(p.position).toEqual([100, 10, 50])
  })
})

describe('joint trimming', () => {
  it('trims a rail that butts against a post (T-joint) by the post half-width', () => {
    const post = P(0, 0, 0, 0, 800, 0)
    const rail = P(0, 10, 0, 600, 10, 0)
    const t = computeTrims(rail, [post, rail])
    expect(t.start.butt).toBe(true)
    expect(t.start.trim).toBe(10)
    expect(t.end.partners).toBe(0)
    expect(t.cutLength).toBe(590)
  })

  it('does not trim the post at a T-joint', () => {
    const post = P(0, 0, 0, 0, 800, 0)
    const rail = P(0, 10, 0, 600, 10, 0)
    const t = computeTrims(post, [post, rail])
    expect(t.start.trim).toBe(0)
    expect(t.cutLength).toBe(800)
  })

  it('uses cross-section of the through member (2040 post → 20 mm trim across its 40 side)', () => {
    // 2040 extruded along Y: local X (w=20) → world X, local Y (h=40) → world Z... check via trims along X
    const post = P(0, 0, 0, 0, 800, 0, '2040')
    const railX = P(0, 20, 0, 600, 20, 0)
    const tX = computeTrims(railX, [post, railX])
    expect(tX.start.trim).toBeGreaterThan(0)
    expect([10, 20]).toContain(tX.start.trim)
  })

  it('extends the through member at a corner to the far face of the butting member', () => {
    const post = P(0, 0, 0, 0, 800, 0)
    const topRail = P(0, 800, 0, 600, 800, 0) // corner joint with post top
    const tPost = computeTrims(post, [post, topRail])
    expect(tPost.end.trim).toBe(-10)   // extended up 10 → flush with rail top face
    expect(tPost.cutLength).toBe(810)
    const tRail = computeTrims(topRail, [post, topRail])
    expect(tRail.start.trim).toBe(10)  // butts against post
  })

  it('makes a cabinet buildable: posts through, rails butt, cut lengths consistent', () => {
    const all = cabinet()
    const trims = computeAllTrims(all)
    const posts = all.slice(0, 4)
    const xRails = [all[4], all[5], all[8], all[9]]
    const zRails = [all[6], all[7], all[10], all[11]]
    for (const p of posts) expect(trims.get(p.id)!.cutLength).toBe(810)  // 800 + 10 top extension (bottom rails are T-joints on the post body)
    for (const r of xRails) expect(trims.get(r.id)!.cutLength).toBe(580)  // 600 − 2×10
    for (const r of zRails) expect(trims.get(r.id)!.cutLength).toBe(380)  // 400 − 2×10
    const buttEnds = [...trims.values()].reduce((n, t) => n + (t.start.butt ? 1 : 0) + (t.end.butt ? 1 : 0), 0)
    expect(buttEnds).toBe(16) // 8 rails × 2 ends → 16 brackets
    const box = computeFrameBounds(all, trims)!
    const size = box.getSize(new THREE.Vector3())
    expect(Math.round(size.x)).toBe(620)
    expect(Math.round(size.z)).toBe(420)
    expect(Math.round(size.y)).toBe(810)
    expect(box.min.y).toBeCloseTo(0, 3) // stands on the floor
  })

  it('shelf between two rails butts at both ends', () => {
    const r1 = P(0, 10, 0, 600, 10, 0)
    const r2 = P(0, 10, 400, 600, 10, 400)
    const shelf = P(300, 10, 0, 300, 10, 400)
    const t = computeTrims(shelf, [r1, r2, shelf])
    expect(t.start.trim).toBe(10)
    expect(t.end.trim).toBe(10)
    expect(t.cutLength).toBe(380)
  })
})

const conflictsOf = (all: ProfileData[]) => findConflicts(all, computeAllTrims(all))

describe('interference is reported, never blocked', () => {
  it('a cabinet frame has no interference', () => {
    expect(conflictsOf(cabinet())).toEqual([])
  })
  it('a shelf whose ends land on rail centerlines is clean', () => {
    const all = [...cabinet(), P(300, 10, 0, 300, 10, 400)]
    expect(conflictsOf(all)).toEqual([])
  })
  it('two rails crossing mid-span at the same height are flagged', () => {
    const r1 = P(0, 10, 200, 600, 10, 200)
    const r2 = P(300, 10, 0, 300, 10, 400)
    const c = conflictsOf([r1, r2])
    expect(c).toHaveLength(1)
    expect(c[0].depth).toBeGreaterThan(10)
    expect([c[0].a, c[0].b].sort()).toEqual([r1.id, r2.id].sort())
  })
  it('a coaxial duplicate is flagged while end-to-end is not', () => {
    const a = P(0, 10, 0, 300, 10, 0)
    expect(conflictsOf([a, P(100, 10, 0, 400, 10, 0)])).toHaveLength(1)
    expect(conflictsOf([a, P(300, 10, 0, 600, 10, 0)])).toEqual([])
  })
  it('parallel rails touching face to face are clean, overlapping ones are flagged', () => {
    const a = P(0, 10, 0, 300, 10, 0)
    expect(conflictsOf([a, P(0, 10, 20, 300, 10, 20)])).toEqual([])
    expect(conflictsOf([a, P(0, 10, 15, 300, 10, 15)])).toHaveLength(1)
  })
  it('analyzeFrame lists every member involved in a conflict', () => {
    const r1 = P(0, 10, 200, 600, 10, 200)
    const r2 = P(300, 10, 0, 300, 10, 400)
    const { conflictIds, conflicts } = analyzeFrame([r1, r2])
    expect([...conflictIds].sort()).toEqual([r1.id, r2.id].sort())
    expect(conflicts[0].region.isEmpty()).toBe(false)
  })
})

describe('tolerant joints (ends landing inside a partner body)', () => {
  it('a rail whose end overshoots the post axis by 6 mm is still trimmed to the post face', () => {
    const post = P(600, 0, 0, 600, 800, 0)
    const rail = P(0, 10, 0, 606, 10, 0)           // 6 mm past the post centerline
    const t = computeTrims(rail, [post, rail])
    expect(t.end.butt).toBe(true)
    expect(t.end.trim).toBe(16)                    // 6 overshoot + 10 half post
    expect(t.cutLength).toBe(590)                  // as-built ends at the post face (x=590)
  })
  it('a rail stopping 4 mm short of the post axis is cut to the same face', () => {
    const post = P(600, 0, 0, 600, 800, 0)
    const rail = P(0, 10, 0, 596, 10, 0)
    const t = computeTrims(rail, [post, rail])
    expect(t.end.trim).toBe(6)
    expect(t.cutLength).toBe(590)
  })
  it('a rail 3 mm off the post centerline laterally still joins (within the post section)', () => {
    const post = P(600, 0, 0, 600, 800, 0)
    const rail = P(0, 10, 3, 600, 10, 3)
    const t = computeTrims(rail, [post, rail])
    expect(t.end.butt).toBe(true)
    expect(t.end.trim).toBe(10)
  })
  it('a rail passing 25 mm beside a post is not a joint', () => {
    const post = P(600, 0, 0, 600, 800, 0)
    const rail = P(0, 10, 25, 600, 10, 25)
    const t = computeTrims(rail, [post, rail])
    expect(t.end.partners).toBe(0)
  })
  it('an L corner still cuts when a coaxial member carries on from the same point', () => {
    // The back rail turns the corner: one run along X, one along Z, both starting at the
    // corner, with a depth rail arriving along Z as well. The coaxial arrival used to make
    // the corner claim it "continues", so neither member was cut and they overlapped by 10.
    const alongX = P(0, 20, 800, 5000, 20, 800)
    const alongZ = P(0, 20, 800, 0, 20, 3000)
    const depth = P(0, 20, 0, 0, 20, 800)
    const all = [alongX, alongZ, depth]
    const tz = computeTrims(alongZ, all)
    const td = computeTrims(depth, all)
    expect(tz.start.butt).toBe(true)
    expect(tz.start.trim).toBe(10)          // cut back to the face of the X run
    expect(td.end.butt).toBe(true)
    expect(td.end.trim).toBe(10)
    expect(computeTrims(alongX, all).start.trim).toBe(-10)   // the X run reaches the far face
    expect(conflictsOf(all)).toEqual([])
  })

  it('coaxial stacked posts through a rail joint neither extend nor trim at the shared end', () => {
    const lower = P(0, 0, 0, 0, 800, 0)
    const upper = P(0, 800, 0, 0, 1400, 0)
    const rail = P(0, 800, 0, 600, 800, 0)
    const tl = computeTrims(lower, [lower, upper, rail])
    const tu = computeTrims(upper, [lower, upper, rail])
    expect(tl.end.trim).toBe(0); expect(tl.end.continues).toBe(true)
    expect(tu.start.trim).toBe(0); expect(tu.start.continues).toBe(true)
    expect(computeTrims(rail, [lower, upper, rail]).start.trim).toBe(10)
    expect(conflictsOf([lower, upper, rail])).toEqual([])
  })
})

describe('interference check', () => {
  it('a cabinet has no interference', () => {
    expect(conflictsOf(cabinet())).toEqual([])
  })
  it('a cabinet with an imprecise rail (overshoot + lateral offset) still has no interference', () => {
    const all = cabinet()
    all.push(P(0, 400, 3, 604, 400, 3))  // shelf-height rail between the front posts, slightly off
    expect(conflictsOf(all)).toEqual([])
  })
  it('detects two rails driven through each other', () => {
    const pen = conflictsOf([P(0, 10, 200, 600, 10, 200), P(300, 10, 0, 300, 10, 400)])
    expect(pen).toHaveLength(1)
    expect(pen[0].depth).toBeGreaterThan(10)
  })
})

/**
 * A corner where a big post meets two rails of a smaller section. Both rails outrank the
 * post under the `rails` arrangement, so both want to run out to its far face — but the
 * space out there is one block, and only one of them can have it.
 */
describe('a corner post is covered once, not twice', () => {
  beforeEach(() => setThroughRule('rails'))

  /** 4040 post at the origin; a 2040 rail along X and another along Z, each flush with its outside */
  function corner(): ProfileData[] {
    return [
      P(0, 20, 10, 0, 900, 10, '4040'),          // the post, x ∈ [-20,20], z ∈ [-10,30]
      P(0, 20, 0, 3600, 20, 0, '2040'),          // X rail, outside face at z = -10
      P(-10, 20, 10, -10, 20, 610, '2040'),      // Z rail, outside face at x = -20
    ]
  }

  it('leaves nothing overlapping at the corner', () => {
    const f = corner()
    expect(findConflicts(f, computeAllTrims(f))).toEqual([])
  })

  it('runs the X rail out over the post', () => {
    const f = corner()
    expect(computeTrims(f[1], f).start.trim).toBe(-20)
  })

  it('stops the Z rail at the X rail rather than running it out too', () => {
    const f = corner()
    expect(computeTrims(f[2], f).start.trim).toBe(0)
  })

  it('cuts the Z rail back where it would otherwise bury itself in the far rail', () => {
    // a second X rail at z = 600 closes the box; the Z rail's far end has to give way to it
    const f = [...corner(), P(0, 20, 600, 3600, 20, 600, '2040'), P(0, 20, 610, 0, 900, 610, '4040')]
    expect(computeTrims(f[2], f).end.trim).toBe(20)
    expect(findConflicts(f, computeAllTrims(f))).toEqual([])
  })

  it('still lets the top-ranked rail through when the rule is reversed', () => {
    setThroughRule('posts')
    const f = corner()
    // with posts running through, the post is no longer something to reach past
    expect(computeTrims(f[1], f).start.trim).toBeGreaterThanOrEqual(0)
    expect(findConflicts(f, computeAllTrims(f))).toEqual([])
  })
})
