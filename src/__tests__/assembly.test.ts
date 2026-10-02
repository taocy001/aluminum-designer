import { afterEach, describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { buildProfile } from '../utils/profileFactory'
import { assemblySteps, shownAt } from '../utils/assembly'
import type { ProfileData, ProfileSpec } from '../store/useStore'
import { getThroughRule, setThroughRule } from '../utils/jointUtils'

afterEach(() => setThroughRule('rails'))

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

/** Assembly suggestions based on contact and height. */
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

  it('does not treat a 9 mm gap as a connection to a previously placed column', () => {
    const post = P(0, 0, 29, 0, 800, 29)
    const rail = P(0, 400, 0, 600, 400, 0)
    const lower = P(3000, 100, 0, 3000, 250, 0)
    const steps = assemblySteps([post, rail, lower])
    const order = steps.flatMap((s) => s.profiles)
    expect(order.indexOf(lower.id)).toBeLessThan(order.indexOf(rail.id))
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
    expect(a).toEqual(b)
  })

  it('uses IDs to order coincident profiles across batches', () => {
    const members = Array.from({ length: 12 }, (_, i) => ({ ...P(0, 0, 0, 0, 500, 0), id: `post-${String(i).padStart(2, '0')}` }))
    expect(assemblySteps(members)).toEqual(assemblySteps([...members].reverse()))
    expect(assemblySteps(members)[0].profiles).toEqual(members.slice(0, 10).map((p) => p.id))
  })

  it('sorts standalone connectors and final boards independently of source order', () => {
    const connectors = ['c2', 'c1'].map((id) => ({ id, type: 'bracket', position: [0, 0, 0], quaternion: [0, 0, 0, 1] })) as never
    const panels = [{ id: 'b2' }, { id: 'b1' }] as never
    const fittings = [{ id: 'f2' }, { id: 'f1' }] as never
    expect(assemblySteps([], connectors, panels, fittings)[0]).toMatchObject({
      connectors: ['c1', 'c2'], panels: ['b1', 'b2'], fittings: ['f1', 'f2'],
    })
    const last = assemblySteps(cabinet(), [], panels, fittings).at(-1)
    expect(last).toMatchObject({ panels: ['b1', 'b2'], fittings: ['f1', 'f2'] })
  })

  it('uses the supplied joint rule without changing the global rule', () => {
    const post = { ...P(0, 10, 0, 0, 810, 0, '4040'), id: 'post' }
    const bottom = { ...P(0, 10, 0, 600, 10, 0, '4040'), id: 'rail' }
    setThroughRule('posts')
    expect(assemblySteps([post, bottom], [], [], [], 'rails')[0].profiles).toEqual(['rail'])
    expect(getThroughRule()).toBe('posts')
    setThroughRule('rails')
    expect(assemblySteps([post, bottom], [], [], [], 'posts')[0].profiles).toEqual(['post'])
    expect(getThroughRule()).toBe('rails')
  })

  it('uses fixed physical cuts when deciding which profiles reach the floor', () => {
    const post = { ...P(0, 0, 0, 0, 500, 0), id: 'post', fixedTrims: { start: 100, end: 0 } }
    const rail = { ...P(1000, 50, 0, 1400, 50, 0), id: 'rail' }
    expect(assemblySteps([post, rail])[0].profiles).toEqual(['rail'])
  })
})
