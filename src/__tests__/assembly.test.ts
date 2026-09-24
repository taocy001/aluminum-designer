import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { buildProfile } from '../utils/profileFactory'
import { assemblySteps, shownAt } from '../utils/assembly'
import type { ProfileData, ProfileSpec } from '../store/useStore'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const P = (sx: number, sy: number, sz: number, ex: number, ey: number, ez: number, spec: ProfileSpec = '2020'): ProfileData =>
  buildProfile(V(sx, sy, sz), V(ex, ey, ez), spec)!

/** a plain cabinet: four posts, rails round the bottom and the top */
function cabinet(x0 = 0, z0 = 0): ProfileData[] {
  const out: ProfileData[] = []
  for (const x of [x0, x0 + 600]) for (const z of [z0, z0 + 400]) out.push(P(x, 0, z, x, 800, z))
  for (const y of [20, 780]) {
    for (const z of [z0, z0 + 400]) out.push(P(x0, y, z, x0 + 600, y, z))
    for (const x of [x0, x0 + 600]) out.push(P(x, y, z0, x, y, z0 + 400))
  }
  return out
}

/**
 * The drawing says what the thing is and says nothing about the order it goes together in,
 * which is the question everybody actually has in front of a pile of extrusion. The order is
 * not a preference: you cannot bolt a rail to a post that is not standing yet.
 */
describe('what to build first', () => {
  it('every part appears exactly once', () => {
    const frame = cabinet()
    const steps = assemblySteps(frame)
    const ids = steps.flatMap((s) => s.profiles)
    expect(new Set(ids).size).toBe(frame.length)
    expect(ids.length).toBe(frame.length)
  })

  it('the posts go up before the rails that hang off them', () => {
    const frame = cabinet()
    const steps = assemblySteps(frame)
    const stepOf = new Map<string, number>()
    for (const s of steps) for (const id of s.profiles) stepOf.set(id, s.n)
    const posts = frame.filter((p) => p.length === 800)
    const rails = frame.filter((p) => p.length !== 800)
    const lastPost = Math.max(...posts.map((p) => stepOf.get(p.id)!))
    const firstRail = Math.min(...rails.map((p) => stepOf.get(p.id)!))
    expect(lastPost).toBeLessThanOrEqual(firstRail)
  })

  it('it works from the floor up', () => {
    const steps = assemblySteps(cabinet()).filter((s) => s.profiles.length > 0)
    for (let i = 1; i < steps.length; i++) expect(steps[i].atHeight).toBeGreaterThanOrEqual(steps[i - 1].atHeight - 1)
  })

  it('a second cabinet that touches nothing still gets built', () => {
    const both = [...cabinet(), ...cabinet(3000, 3000)]
    const ids = assemblySteps(both).flatMap((s) => s.profiles)
    expect(new Set(ids).size).toBe(both.length)
  })

  it('the boards and the doors go in after the frame is standing', () => {
    const frame = cabinet()
    const board = { id: 'b1', width: 560, height: 760, thickness: 18, position: [300, 400, -20], quaternion: [0, 0, 0, 1], material: 'mdf' } as never
    const door = { id: 'd1', kind: 'door', width: 560, height: 760, depth: 400, position: [300, 400, 0], quaternion: [0, 0, 0, 1], open: 0 } as never
    const steps = assemblySteps(frame, [], [board], [door])
    const last = steps[steps.length - 1]
    expect(last.panels).toContain('b1')
    expect(last.fittings).toContain('d1')
    expect(last.profiles).toEqual([])
  })

  it('what is on by step n is everything from the steps up to it', () => {
    const frame = cabinet()
    const steps = assemblySteps(frame)
    expect(shownAt(steps, 0).profiles.size).toBe(0)
    expect(shownAt(steps, 1).profiles.size).toBe(steps[0].profiles.length)
    expect(shownAt(steps, steps.length).profiles.size).toBe(frame.length)
  })

  it('the same drawing always gives the same instructions', () => {
    const frame = cabinet()
    const a = assemblySteps(frame).map((s) => s.profiles.join(','))
    const b = assemblySteps([...frame].reverse()).map((s) => s.profiles.join(','))
    expect(a.length).toBe(b.length)
  })
})
