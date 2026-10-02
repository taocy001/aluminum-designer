import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore, type ProfileData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { buildProfile } from '../utils/profileFactory'
import { computeAllTrims, computeTrims, getProfileDir, setThroughRule, withFixedProfileCuts } from '../utils/jointUtils'
import { arraySelected, commitExactLength, commitExactMove, duplicateSelected, flipProfile, liveParts, mirrorSelected, nudgeSelected, rotateSelected, setProfileLength, setProfilePosition } from '../utils/editOps'
import { parseProjectDocument, serializeProjectDocument } from '../utils/document'
import { encodeShareLink, decodeShare } from '../utils/shareLink'
import { buildBom } from '../utils/bom'
import { describeChange } from '../utils/opLog'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const member = (id: string, start: THREE.Vector3, end: THREE.Vector3): ProfileData =>
  buildProfile(start, end, '4040', id)!
const corner = () => [member('A', V(0, 0, 0), V(0, 800, 0)), member('B', V(0, 800, 0), V(600, 800, 0))]
const empty = { connectors: [], panels: [], fittings: [], selectedIds: [], past: [], future: [] }
const load = (profiles = corner()) => useStore.setState({ ...empty, profiles, throughRule: 'rails' })
const span = (p: ProfileData, all: ProfileData[]) => {
  const t = computeTrims(p, all), dir = getProfileDir(p)
  const start = new THREE.Vector3(...p.position).addScaledVector(dir, t.start.trim)
  const end = start.clone().addScaledVector(dir, t.cutLength)
  return [start, end].map((v) => v.toArray().map((n) => Math.round(n * 1000) / 1000 || 0))
}
const cuts = (all = useStore.getState().profiles) => all.map((p) => computeTrims(p, all).cutLength)

beforeEach(() => {
  load()
  setThroughRule('rails')
  useToolStore.getState().stopDrag()
  useToolStore.getState().stopResize()
})

describe('moving keeps physical parts at their existing cut lengths', () => {
  for (const [name, move] of [
    ['updateProfile', () => useStore.getState().updateProfile('B', { position: [0, 800, 60] })],
    ['updateProfiles', () => useStore.getState().updateProfiles([{ id: 'B', updates: { position: [0, 800, 60] } }])],
    ['commitProfileEdit', () => useStore.getState().commitProfileEdit('B', { position: [0, 800, 60] })],
    ['commitProfilesEdit', () => useStore.getState().commitProfilesEdit([{ id: 'B', updates: { position: [0, 800, 60] } }])],
    ['commitTransform', () => useStore.getState().commitTransform({ profiles: [{ id: 'B', updates: { position: [0, 800, 60] } }] })],
    ['updateParts', () => useStore.getState().updateParts({ profiles: [{ id: 'B', updates: { position: [0, 800, 60] } }] })],
  ] as const) it(`${name} protects both the moving part and its stationary neighbour`, () => {
    const before = useStore.getState().profiles
    const beforeSpan = span(before[0], before)
    expect(cuts()).toEqual([780, 620])
    move()
    const after = useStore.getState().profiles
    expect(cuts()).toEqual([780, 620])
    expect(after[0].length).toBe(800)
    expect(span(after[0], after)).toEqual(beforeSpan)
    expect(after[1].position).toEqual([0, 800, 60])
    expect(computeTrims(after[0], after).end.partners).toBe(0)
    expect(computeAllTrims(after).get('A')).toEqual(computeTrims(after[0], after))
    expect(buildBom(after, [], computeAllTrims(after), 'zh').profiles.map((p) => p.length).sort()).toEqual([620, 780])
    expect(before.every((p) => !p.fixedTrims)).toBe(true)
  })

  it('keeps a locked neighbour fixed throughout a live drag, undo and redo', () => {
    const profiles = corner()
    profiles[0].locked = true
    load(profiles)
    const store = useStore.getState()
    store.snapshotHistory()
    store.freezeProfileCuts()
    for (const z of [5, 20, 25, 60]) store.updateParts({ profiles: [{ id: 'B', updates: { position: [0, 800, z] } }] })
    expect(cuts()).toEqual([780, 620])
    expect(useStore.getState().past).toHaveLength(1)
    store.undo()
    expect(useStore.getState().profiles).toEqual(profiles)
    expect(cuts()).toEqual([780, 620])
    store.redo()
    expect(useStore.getState().profiles[1].position[2]).toBe(60)
    expect(cuts()).toEqual([780, 620])
  })

  it('numeric position edits and nudges obey the same rigid-part rule', () => {
    useStore.getState().selectItems(['B'])
    expect(nudgeSelected([0, 0, 60])).toBe(true)
    expect(cuts()).toEqual([780, 620])
    expect(setProfilePosition('B', [0, 800, 100])).toBe(true)
    expect(cuts()).toEqual([780, 620])
    expect(liveParts(['B'], { position: [0, 800, 150] }, true)).toBe(true)
    expect(cuts()).toEqual([780, 620])
    expect(useStore.getState().past).toHaveLength(3)
  })

  it('rotation keeps the moving length and leaves a locked neighbour unchanged', () => {
    const profiles = corner()
    profiles[0].locked = true
    load(profiles)
    useStore.getState().selectItems(['B'])
    const original = span(profiles[0], profiles)
    expect(rotateSelected('y', 90)).toBe(true)
    expect(cuts()).toEqual([780, 620])
    const after = useStore.getState().profiles
    expect(span(after[0], after)).toEqual(original)
  })

  it('exact drag distance retains the first snapshot and physical cuts', () => {
    const b = useStore.getState().profiles[1]
    useToolStore.getState().startDrag({ id: 'B', hit: V(...b.position), origin: V(...b.position),
      groupOrigins: { B: b.position }, plane: new THREE.Plane(V(0, 1, 0), -800), vertical: false, axis: 'z' })
    useStore.getState().snapshotHistory()
    useToolStore.getState().markDragMoved()
    useStore.getState().updateProfile('B', { position: [0, 800, 25] })
    expect(commitExactMove(100)).toBe(true)
    expect(useStore.getState().profiles[1].position).toEqual([0, 800, 100])
    expect(cuts()).toEqual([780, 620])
    expect(useStore.getState().past).toHaveLength(1)
  })

  it('no-op edits neither fix cuts nor create history', () => {
    const before = useStore.getState()
    before.commitProfileEdit('B', { position: [0, 800, 0] })
    before.commitProfilesEdit([{ id: 'B', updates: { ...before.profiles[1] } }])
    before.commitTransform({ profiles: [{ id: 'B', updates: { position: [0, 800, 0] } }] })
    before.updateParts({ profiles: [{ id: 'missing', updates: { position: [0, 800, 60] } }] })
    expect(useStore.getState()).toBe(before)
  })
})

describe('explicit manufacturing edits and locks', () => {
  it('only an explicit recalculation lets an unlocked neighbour regain its length', () => {
    const store = useStore.getState()
    store.commitProfileEdit('B', { position: [0, 800, 60] })
    expect(cuts()).toEqual([780, 620])
    store.recalculateJoints()
    expect(cuts()).toEqual([800, 600])
    expect(useStore.getState().past).toHaveLength(2)
    store.undo()
    expect(cuts()).toEqual([780, 620])
    store.redo()
    expect(cuts()).toEqual([800, 600])
  })

  it('locking preserves the whole existing assembly and rule changes keep locked parts unchanged', () => {
    const store = useStore.getState()
    const original = store.profiles.map((p) => span(p, store.profiles))
    store.selectItems(['A'])
    store.toggleLockSelected()
    expect(useStore.getState().profiles[0].fixedTrims).toEqual({ start: 0, end: 20 })
    expect(useStore.getState().profiles[1].fixedTrims).toEqual({ start: -20, end: 0 })
    const locked = useStore.getState().profiles
    expect(locked.map((p) => span(p, locked))).toEqual(original)
    store.freezeProfileCuts()
    store.setThroughRule('posts')
    // The finished post stops at Y=780. The rail's design end at Y=800 cannot
    // continue attaching to the 20 mm of post material that was already cut off.
    expect(cuts()).toEqual([780, 600])
    expect(useStore.getState().profiles[0].locked).toBe(true)
    store.undo()
    expect(cuts()).toEqual([780, 620])
    store.redo()
    expect(cuts()).toEqual([780, 600])
    store.recalculateJoints()
    expect(cuts()[0]).toBe(780)
  })

  it('same-rule selection and recalculating an automatic scene are no-ops', () => {
    const before = useStore.getState()
    before.setThroughRule('rails')
    before.recalculateJoints()
    expect(useStore.getState()).toBe(before)
  })

  it('adding a member protects legacy locked geometry while keeping unlocked construction automatic', () => {
    const [post, rail] = corner()
    load([{ ...post, locked: true }])
    useStore.getState().addProfile(rail)
    expect(cuts()[0]).toBe(800)
    expect(useStore.getState().profiles[0].fixedTrims).toEqual({ start: 0, end: 0 })
    load([post])
    useStore.getState().addProfile(rail)
    expect(cuts()[0]).toBe(780)
  })

  it('protecting a legacy locked reference before an addition also keeps its existing neighbours unchanged', () => {
    const profiles = corner()
    profiles[0].locked = true
    load(profiles)
    const before = profiles.map((p) => span(p, profiles))
    useStore.getState().addProfile(member('C', V(1000, 100, 0), V(1500, 100, 0)))
    const after = useStore.getState().profiles
    expect(after.slice(0, 2).map((p) => span(p, after))).toEqual(before)
    expect(cuts().slice(0, 2)).toEqual([780, 620])
  })

  it('locking only a board leaves automatic profiles automatic', () => {
    useStore.setState({ panels: [{ id: 'board', width: 100, height: 100, thickness: 10, material: 'ply',
      position: [500, 100, 0], quaternion: [0, 0, 0, 1] }], selectedIds: ['board'] })
    useStore.getState().toggleLockSelected()
    expect(useStore.getState().profiles.every((p) => !p.fixedTrims)).toBe(true)
  })

  for (const remove of ['single', 'selection'] as const) it(`deleting ${remove} keeps the remaining physical ends`, () => {
    const before = useStore.getState().profiles, originalSpan = span(before[0], before)
    const store = useStore.getState()
    if (remove === 'single') store.removeProfile('B')
    else { store.selectItems(['B']); store.removeSelected() }
    expect(cuts()).toEqual([780])
    const remaining = useStore.getState().profiles
    expect(span(remaining[0], remaining)).toEqual(originalSpan)
    store.undo()
    expect(useStore.getState().profiles).toEqual(before)
  })

  it('rejects a size that would consume the complete fixed cut, without history', () => {
    const before = useStore.getState()
    before.commitProfileEdit('A', { length: 10 })
    expect(useStore.getState()).toBe(before)
    expect(liveParts(['A'], { length: 10 }, true)).toBe(false)
    expect(setProfileLength('A', 10)).toBe(false)
    expect(useStore.getState()).toBe(before)
    expect(setProfileLength('A', 21)).toBe(true)
    expect(cuts()).toEqual([1, 620])
  })

  for (const end of ['start', 'end'] as const) it(`typing a physical length at the ${end} handle keeps the opposite cut face fixed`, () => {
    const p = { ...member('A', V(0, 100, 0), V(0, 900, 0)), fixedTrims: { start: 0, end: 20 } }
    load([p])
    const before = span(p, [p])
    useToolStore.getState().startResize({ id: 'A', end, origin: p.position, length: p.length,
      grabLength: p.length, downX: 0, downY: 0 })
    expect(commitExactLength(800)).toBe(true)
    const after = useStore.getState().profiles
    expect(after[0].length).toBe(820)
    expect(cuts()).toEqual([800])
    expect(span(after[0], after)[end === 'start' ? 1 : 0]).toEqual(before[end === 'start' ? 1 : 0])
    expect(useStore.getState().past).toHaveLength(1)
    useStore.getState().undo()
    expect(useStore.getState().profiles[0]).toEqual(p)
  })

  it('typing the existing physical length before movement does not create an undo entry', () => {
    const p = useStore.getState().profiles[0]
    useToolStore.getState().startResize({ id: 'A', end: 'end', origin: p.position, length: p.length,
      grabLength: p.length, downX: 0, downY: 0 })
    expect(commitExactLength(780)).toBe(true)
    expect(useStore.getState().past).toHaveLength(0)
    expect(useStore.getState().profiles[0].fixedTrims).toBeUndefined()
  })
})

describe('copies, direction and persistence keep determined end faces', () => {
  for (const [name, copy] of [
    ['duplicate', duplicateSelected], ['mirror', () => mirrorSelected('z')], ['array', () => arraySelected('z', 2, 150)],
  ] as const) it(`${name} copies the physical source length`, () => {
    useStore.getState().selectItems(['B'])
    expect(copy()).toBe(true)
    expect(cuts().every((cut, i) => cut === (i === 0 ? 780 : 620))).toBe(true)
    expect(useStore.getState().past).toHaveLength(1)
    useStore.getState().undo()
    expect(cuts()).toEqual([780, 620])
  })

  it('flipping swaps the cut offsets and preserves both world end faces', () => {
    const before = useStore.getState().profiles, oldSpan = span(before[1], before)
    expect(flipProfile('B')).toBe(true)
    const after = useStore.getState().profiles
    expect(after[1].fixedTrims).toEqual({ start: 0, end: -20 })
    expect(span(after[1], after)).toEqual([...oldSpan].reverse())
    expect(cuts()).toEqual([780, 620])
  })

  it('survives JSON and real compressed share round trips, including extension and locks', async () => {
    useStore.getState().updateProfile('B', { position: [0, 800, 60] })
    const doc = { profiles: useStore.getState().profiles.map((p) => ({ ...p, locked: true })),
      connectors: [], panels: [], fittings: [], throughRule: 'rails' as const }
    const json = serializeProjectDocument(doc)
    expect(JSON.parse(json).version).toBe(6)
    expect(parseProjectDocument(json)).toEqual(doc)
    const link = await encodeShareLink(doc, 'https://example.com/')
    const back = await decodeShare(new URL(link).hash.slice(3))
    expect(back.profiles.map(({ id: _id, ...p }) => p)).toEqual(doc.profiles.map(({ id: _id, ...p }) => p))
    expect(cuts(back.profiles)).toEqual([780, 620])
  })

  it('fixing twice is immutable and preserves profile identities after the first time', () => {
    const source = corner(), copy = JSON.stringify(source)
    const fixed = withFixedProfileCuts(source)
    expect(JSON.stringify(source)).toBe(copy)
    expect(withFixedProfileCuts(fixed)).toBe(fixed)
    expect(cuts(fixed)).toEqual(cuts(source))
  })

  it('logs the moved part without calling all stationary fixed parts edits', () => {
    const source = { profiles: corner(), connectors: [], panels: [], fittings: [] }
    const fixed = withFixedProfileCuts(source.profiles)
    expect(describeChange(source, { ...source, profiles: fixed })).toBeNull()
    const profiles = fixed.map((p) => p.id === 'B' ? { ...p, position: [0, 800, 60] as [number, number, number] } : p)
    const log = describeChange(source, { ...source, profiles })!
    expect(log.ids).toEqual(['B'])
    expect(log.label).toBe('move')
  })
})
