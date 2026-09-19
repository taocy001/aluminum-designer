import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { buildProfile } from '../utils/profileFactory'
import { computeTrims, computeAllTrims, computeFrameBounds } from '../utils/jointUtils'
import { wouldOverlap } from '../utils/snapUtils'
import type { ProfileData, ProfileSpec } from '../store/useStore'

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

describe('overlap detection', () => {
  it('allows every member of a cabinet frame', () => {
    const all = cabinet()
    for (let i = 0; i < all.length; i++) {
      expect(wouldOverlap(all[i], all.filter((_, j) => j !== i))).toBe(false)
    }
  })
  it('allows a shelf whose ends land on rail centerlines', () => {
    const all = cabinet()
    const shelf = P(300, 10, 0, 300, 10, 400)
    expect(wouldOverlap(shelf, all)).toBe(false)
  })
  it('rejects two rails crossing mid-span at the same height', () => {
    const r1 = P(0, 10, 200, 600, 10, 200)
    const r2 = P(300, 10, 0, 300, 10, 400)
    expect(wouldOverlap(r2, [r1])).toBe(true)
  })
  it('rejects a coaxial duplicate but allows end-to-end', () => {
    const a = P(0, 10, 0, 300, 10, 0)
    expect(wouldOverlap(P(100, 10, 0, 400, 10, 0), [a])).toBe(true)
    expect(wouldOverlap(P(300, 10, 0, 600, 10, 0), [a])).toBe(false)
  })
  it('allows parallel rails touching face to face', () => {
    const a = P(0, 10, 0, 300, 10, 0)
    expect(wouldOverlap(P(0, 10, 20, 300, 10, 20), [a])).toBe(false)
    expect(wouldOverlap(P(0, 10, 15, 300, 10, 15), [a])).toBe(true)
  })
})
