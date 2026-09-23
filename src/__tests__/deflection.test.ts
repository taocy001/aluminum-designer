import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { buildProfile } from '../utils/profileFactory'
import { deflect, saggingMembers, sectionProps, massPerMetre, SLENDER } from '../utils/deflection'
import type { ProfileData, ProfileSpec } from '../store/useStore'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const P = (sx: number, sy: number, sz: number, ex: number, ey: number, ez: number, spec: ProfileSpec = '2020'): ProfileData =>
  buildProfile(V(sx, sy, sz), V(ex, ey, ez), spec)!

/** a shelf rail of the given span, held up at both ends */
function shelf(span: number, spec: ProfileSpec = '2020'): ProfileData[] {
  return [
    P(0, 0, 0, 0, 800, 0),
    P(span, 0, 0, span, 800, 0),
    P(0, 400, 0, span, 400, 0, spec),
  ]
}

/**
 * The tool could tell you a frame was buildable and never that it would sag. A 1.8 m 2020
 * carrying a box of books drops nearly a centimetre, which you find out by building it.
 */
describe('how far a span bends', () => {
  it('a longer span sags far more than proportionally', () => {
    const one = deflect(shelf(600)[2], shelf(600), 20)!
    const two = deflect(shelf(1200)[2], shelf(1200), 20)!
    // a point load goes as L³, so doubling the span is roughly eight times the sag
    expect(two.sag / one.sag).toBeGreaterThan(6)
    expect(two.sag / one.sag).toBeLessThan(10)
  })

  it('a 2040 on edge is far stiffer than the same rail lying flat', () => {
    const on = sectionProps('2040')
    expect(on.strong / on.weak).toBeGreaterThan(3)
    const flat = shelf(1200, '2040')
    const upright = deflect(flat[2], flat, 20)!
    expect(upright.sag).toBeLessThan(deflect(shelf(1200)[2], shelf(1200), 20)!.sag)
  })

  it('a post is not a beam and is left alone', () => {
    const frame = shelf(900)
    expect(deflect(frame[0], frame, 20)).toBeNull()
  })

  it('a rail with nothing under either end is not spanning anything', () => {
    const lonely = P(0, 400, 0, 900, 400, 0)
    expect(deflect(lonely, [lonely], 20)).toBeNull()
  })

  it('held at one end only, it is a cantilever and bends much further', () => {
    const arm = P(0, 400, 0, 600, 400, 0)
    const post = P(0, 0, 0, 0, 800, 0)
    const out = deflect(arm, [arm, post], 10)!
    expect(out.support).toBe('cantilever')
    const both = deflect(shelf(600)[2], shelf(600), 10)!
    expect(out.sag).toBeGreaterThan(both.sag * 8)
  })

  it('counts its own weight when nothing is put on it', () => {
    const bare = deflect(shelf(2000)[2], shelf(2000), 0)!
    expect(bare.sag).toBeGreaterThan(0)
    expect(massPerMetre('2020')).toBeCloseTo(0.432, 2)
  })

  it('names the spans that would look bent, worst first', () => {
    const frame = [...shelf(1800), ...shelf(400)]
    const bad = saggingMembers(frame, 25)
    expect(bad.length).toBeGreaterThan(0)
    expect(bad[0].d.ratio).toBeLessThan(SLENDER)
    for (let i = 1; i < bad.length; i++) expect(bad[i].d.ratio).toBeGreaterThanOrEqual(bad[i - 1].d.ratio)
  })

  it('says when turning the section would fix it', () => {
    const frame = shelf(1200, '2040')
    const d = deflect(frame[2], frame, 20)!
    // buildProfile stands a 2040 the stiff way up, so there is nothing to suggest
    expect(d.turnHelps).toBe(false)
  })
})
