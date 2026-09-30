import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore, type ProfileData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { buildProfile } from '../utils/profileFactory'
import { computeAllTrims, computeTrims, setThroughRule, withFixedProfileCuts } from '../utils/jointUtils'
import { profileBodyEndpoints } from '../utils/profileFaces'
import { commitExactLength } from '../utils/editOps'
import { parseProjectDocument, serializeProjectDocument } from '../utils/document'
import { analyzeFrame } from '../utils/analysis'

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const member = (id: string, start: THREE.Vector3, end: THREE.Vector3) => buildProfile(start, end, '4040', id)!
const load = (profiles: ProfileData[]) => useStore.setState({ profiles, connectors: [], panels: [], fittings: [],
  selectedIds: [], past: [], future: [], throughRule: 'rails' })

beforeEach(() => {
  load([])
  setThroughRule('rails')
  useToolStore.getState().stopDrag()
  useToolStore.getState().stopResize()
})

describe('determined contacts follow the actual cut faces', () => {
  for (const automaticRail of [false, true]) it(`drops a separated post joint with an ${automaticRail ? 'automatic' : 'fixed'} rail`, () => {
    const post = member('A', v(0, 0, 0), v(0, 800, 0))
    const rail = member('B', v(0, 800, 0), v(600, 800, 0))
    const fixed = withFixedProfileCuts([post, rail])
    expect(computeTrims(fixed[0], fixed).end.partners).toBe(1)
    const profiles = [fixed[0], { ...(automaticRail ? rail : fixed[1]), position: [0, 810, 0] as [number, number, number] }]
    const actual = profileBodyEndpoints(profiles[0])
    expect(actual.end.y).toBeCloseTo(780)
    // The rail's bottom is at Y=790: its body is now 10 mm clear of the post.
    const result = computeTrims(profiles[0], profiles)
    expect(result.end).toMatchObject({ trim: 20, partners: 0, butt: false, continues: false })
    expect(result.cutLength).toBe(780)
    expect(computeAllTrims(profiles).get('A')).toEqual(result)
  })

  it('finds a coaxial contact beyond a long extension in both cached and direct resolution', () => {
    const a = { ...member('A', v(0, 100, 0), v(100, 100, 0)), fixedTrims: { start: 0, end: -300 } }
    const b = { ...member('B', v(400, 100, 0), v(500, 100, 0)), fixedTrims: { start: 0, end: 0 } }
    const profiles = [a, b]
    const result = computeTrims(a, profiles)
    expect(result.end).toMatchObject({ trim: -300, partners: 1, continues: true })
    expect(result.cutLength).toBe(400)
    const cached = computeAllTrims(profiles)
    for (const p of profiles) expect(cached.get(p.id)).toEqual(computeTrims(p, profiles))
  })

  it('does not retain a coaxial connection to material already cut off its neighbour', () => {
    const a = { ...member('A', v(0, 100, 0), v(100, 100, 0)), fixedTrims: { start: 0, end: 0 } }
    const b = { ...member('B', v(100, 100, 0), v(300, 100, 0)), fixedTrims: { start: 100, end: 0 } }
    const result = computeTrims(a, [a, b])
    expect(result.end).toMatchObject({ partners: 0, continues: false })
    expect(computeAllTrims([a, b]).get('A')).toEqual(result)
  })

  it('an automatic rail cannot attach to a locked post segment that has been cut away', () => {
    const post = { ...member('A', v(0, 0, 0), v(0, 800, 0)), locked: true, fixedTrims: { start: 0, end: 200 } }
    const rail = member('B', v(0, 800, 0), v(600, 800, 0))
    const profiles = [post, rail]
    const result = computeTrims(rail, profiles)
    expect(result.start).toMatchObject({ trim: 0, partners: 0, butt: false })
    expect(result.cutLength).toBe(600)
    expect(computeAllTrims(profiles).get('B')).toEqual(result)
  })

  it('an automatic rail can meet the real end of a fixed extension beyond its design segment', () => {
    const post = { ...member('A', v(0, 0, 0), v(0, 100, 0)), fixedTrims: { start: 0, end: -700 } }
    const rail = member('B', v(0, 800, 0), v(600, 800, 0))
    const profiles = [post, rail]
    expect(computeTrims(rail, profiles).start.partners).toBe(1)
    for (const p of profiles) expect(computeAllTrims(profiles).get(p.id)).toEqual(computeTrims(p, profiles))
  })

  it('a higher-priority automatic rail butts against a finished post without entering its body', () => {
    const post = { ...member('A', v(0, 0, 0), v(0, 800, 0)), locked: true, fixedTrims: { start: 0, end: 0 } }
    const rail = member('B', v(0, 800, 0), v(600, 800, 0))
    const profiles = [post, rail]
    const result = computeTrims(rail, profiles)
    expect(result.start).toMatchObject({ trim: 20, partners: 1, butt: true })
    expect(result.cutLength).toBe(580)
    expect(computeTrims(post, profiles).cutLength).toBe(800)
    expect(analyzeFrame(profiles, []).conflictIds.size).toBe(0)
    for (const p of profiles) expect(computeAllTrims(profiles).get(p.id)).toEqual(computeTrims(p, profiles))
  })
})

describe('short physical lengths remain valid after an extended cut', () => {
  for (const end of ['start', 'end'] as const) for (const length of [10, 15]) {
    it(`accepts ${length} mm at the ${end} handle and keeps the opposite physical face`, () => {
      const p = { ...member('A', v(0, 100, 0), v(600, 100, 0)), fixedTrims: { start: -20, end: 0 } }
      load([p])
      const before = profileBodyEndpoints(p)
      useToolStore.getState().startResize({ id: p.id, end, origin: p.position, length: p.length,
        grabLength: p.length, downX: 0, downY: 0 })
      expect(commitExactLength(length)).toBe(true)
      const state = useStore.getState(), edited = state.profiles[0]
      expect(edited.length).toBeGreaterThanOrEqual(10)
      expect(computeTrims(edited, state.profiles).cutLength).toBe(length)
      const after = profileBodyEndpoints(edited)
      const opposite = end === 'start' ? 'end' : 'start'
      expect(after[opposite].distanceTo(before[opposite])).toBeLessThan(1e-6)
      expect(state.past).toHaveLength(1)
      expect(parseProjectDocument(serializeProjectDocument(state)).profiles[0]).toEqual(edited)
      state.undo()
      expect(useStore.getState().profiles).toEqual([p])
      state.redo()
      expect(useStore.getState().profiles).toEqual([edited])
    })
  }

  it('records an edit that changes only the active cut offset on an already minimal model span', () => {
    const p = { ...member('A', v(0, 100, 0), v(10, 100, 0)), fixedTrims: { start: -20, end: 0 } }
    load([p])
    useToolStore.getState().startResize({ id: p.id, end: 'end', origin: p.position, length: p.length,
      grabLength: p.length, downX: 0, downY: 0 })
    expect(commitExactLength(15)).toBe(true)
    const edited = useStore.getState().profiles[0]
    expect(edited.length).toBe(10)
    expect(edited.position).toEqual(p.position)
    expect(edited.fixedTrims).toEqual({ start: -20, end: 15 })
    expect(computeTrims(edited, [edited]).cutLength).toBe(15)
    expect(useStore.getState().past).toHaveLength(1)
    useStore.getState().undo()
    expect(useStore.getState().profiles).toEqual([p])
  })
})
