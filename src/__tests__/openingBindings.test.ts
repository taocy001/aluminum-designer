import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore, type ProfileData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { deriveOpeningFitting, deriveOpeningPanel, openingFaceOptions, reconcileBindings, resolveOpening,
  type OpeningRef, type ResolvedOpening } from '../utils/openingBindings'
import { getThroughRule, setThroughRule } from '../utils/jointUtils'
import { nudgeSelected, rotateSelected, selectionPivot } from '../utils/editOps'
import type { ProjectDocument } from '../utils/document'
import { boundProject, identity, openingRef } from './fixtures/bindings'

const kinds = ['profiles', 'connectors', 'panels', 'fittings'] as const
const empty = (): ProjectDocument => ({ profiles: [], connectors: [], panels: [], fittings: [], throughRule: 'rails' })
const geometry = (): ProjectDocument => {
  const state = useStore.getState()
  return { profiles: state.profiles, connectors: state.connectors, panels: state.panels, fittings: state.fittings, throughRule: state.throughRule }
}
const resolved = (ref = openingRef(), profiles = boundProject().profiles, rule: 'rails' | 'posts' = 'rails'): ResolvedOpening => {
  const result = resolveOpening(ref, profiles, rule)
  expect(result.status).toBe('resolved')
  if (result.status !== 'resolved') throw new Error('Unresolved fixture')
  return result.opening
}
function load(doc = boundProject()) {
  const prepared = reconcileBindings(empty(), doc)
  expect(prepared.status).toBe('resolved')
  if (prepared.status !== 'resolved') throw new Error('Invalid fixture')
  useStore.setState({ ...prepared.document, past: [], future: [], selectedIds: [] })
  return geometry()
}
const expectPoint = (actual: number[], expected: number[]) => expected.forEach((n, i) => expect(actual[i]).toBeCloseTo(n, 5))

beforeEach(() => {
  useStore.setState({ ...empty(), past: [], future: [], selectedIds: [] })
  setThroughRule('rails')
  useToolStore.getState().stopDrag()
  useToolStore.getState().stopResize()
  useToolStore.getState().setPivotMode('center')
})

describe('explicit opening planes', () => {
  it('uses the named faces and ignores unrelated nearby profiles', () => {
    const doc = boundProject()
    const decoy = { ...doc.profiles[0], id: 'decoy', position: [-100, 0, 0] as ProfileData['position'] }
    expect(resolved(openingRef(), [...doc.profiles, decoy])).toMatchObject({ width: 500, height: 560, depth: 480, frame: 20,
      position: [0, 300, -250] })
  })

  it('uses a fixed depth only when there is no rear face', () => {
    const { back: omitted, ...front } = openingRef()
    expect(resolved({ ...front, fixedDepth: 410 })).toMatchObject({ depth: 410, position: [0, 300, -215] })
  })

  it('follows rigidly rotated frames without a world-axis assumption', () => {
    const doc = boundProject(), q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.7, -0.4))
    const delta = new THREE.Vector3(200, 50, -100)
    const profiles = doc.profiles.map((p) => ({ ...p,
      position: new THREE.Vector3(...p.position).applyQuaternion(q).add(delta).toArray() as ProfileData['position'],
      quaternion: q.clone().multiply(new THREE.Quaternion(...p.quaternion)).toArray() as ProfileData['quaternion'],
    }))
    const out = resolved(openingRef(), profiles)
    expect(out).toMatchObject({ width: 500, height: 560, depth: 480, frame: 20 })
    expectPoint(out.position, new THREE.Vector3(0, 300, -250).applyQuaternion(q).add(delta).toArray())
    expect(Math.abs(new THREE.Quaternion(...out.quaternion).dot(q))).toBeCloseTo(1, 8)
  })

  it('distinguishes missing faces, incompatible axes and reversed dimensions', () => {
    const doc = boundProject(), ref = openingRef()
    expect(resolveOpening(ref, doc.profiles.filter((p) => p.id !== 'left'), 'rails'))
      .toEqual({ status: 'missing-source', sourceIds: ['left'] })
    expect(resolveOpening({ ...ref, right: { ...ref.right, side: 1 } }, doc.profiles, 'rails'))
      .toMatchObject({ status: 'invalid', reason: 'axes' })
    const reversed = doc.profiles.map((p) => p.id === 'right' ? { ...p, position: [-300, 0, 0] as ProfileData['position'] } : p)
    expect(resolveOpening(ref, reversed, 'rails')).toMatchObject({ status: 'invalid', reason: 'dimensions' })
  })

  it('resolves candidate joint rules without changing the active rule', () => {
    const { doc, ref } = ruleFixture()
    setThroughRule('posts')
    expect(resolved(ref, doc.profiles, 'rails').height).toBe(590)
    expect(resolved(ref, doc.profiles, 'posts').height).toBe(570)
    const options = openingFaceOptions(doc.profiles, ['cap', 'runner'], identity, 'rails')
    expect(options.top.find((o) => o.ref.profileId === 'cap' && o.ref.axis === 2)?.coordinate).toBeCloseTo(610)
    expect(Object.values(options).flat().some((o) => o.ref.profileId === 'runner')).toBe(false)
    expect(getThroughRule()).toBe('posts')
  })
})

describe('opening-derived dimensions', () => {
  it('fits whole and split doors using their saved intervals', () => {
    const door = boundProject().fittings[1], opening = resolved()
    expect(deriveOpeningFitting({ ...door, openingBinding: { opening: openingRef(), mode: 'door', start: 0, end: 1 } }, opening))
      .toMatchObject({ width: 500, height: 560, depth: 480, frame: 20, position: [0, 300, -250] })
    expect(deriveOpeningFitting(door, { ...opening, width: 600, height: 700 }))
      .toMatchObject({ width: 180, height: 700, position: [-150, 300, -250], meeting: 'right' })
  })

  it('keeps stacked drawer heights and bottom offsets while their width changes', () => {
    const lower = boundProject().fittings[0], opening = { ...resolved(), width: 650 }
    const upper = { ...lower, id: 'upper', height: 220,
      openingBinding: { opening: openingRef(), mode: 'drawer' as const, bottomOffset: 240 } }
    expect(deriveOpeningFitting(lower, opening)).toMatchObject({ width: 650, height: 200, position: [0, 120, -250] })
    expect(deriveOpeningFitting(upper, opening)).toMatchObject({ width: 650, height: 220, position: [0, 370, -250] })
    expect(deriveOpeningFitting(upper, { ...opening, height: 450 })).toBeNull()
    expect(deriveOpeningFitting(lower, { ...opening, width: 60 })).toBeNull()
  })

  it.each([
    ['front', 493, 557, [-1.5, 300.5, -12], [0, 0, 1]],
    ['back', 493, 557, [1.5, 300.5, -488], [0, 0, -1]],
    ['left', 473, 557, [-248, 300.5, -251.5], [-1, 0, 0]],
    ['right', 473, 557, [248, 300.5, -248.5], [1, 0, 0]],
    ['top', 493, 477, [-1.5, 578, -250.5], [0, 1, 0]],
    ['bottom', 493, 477, [-1.5, 22, -249.5], [0, -1, 0]],
  ] as const)('fits the %s board with asymmetric edge margins', (mode, width, height, position, normal) => {
    const panel = boundProject().panels[0]
    const out = deriveOpeningPanel({ ...panel, openingBinding: { ...panel.openingBinding!, mode } }, resolved())!
    expect(out).toMatchObject({ width, height, thickness: 18 })
    expectPoint(out.position, [...position])
    expectPoint(new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(...out.quaternion)).toArray(), [...normal])
  })

  it('rejects a board that no longer has its minimum usable span', () => {
    const panel = boundProject().panels[0]
    expect(deriveOpeningPanel(panel, { ...resolved(), width: 26 })).toBeNull()
  })
})

describe('atomic binding edits', () => {
  it('updates frame, door, drawer, board and support in one undo step', () => {
    const before = load()
    const result = useStore.getState().updateParts({ profiles: [{ id: 'left', updates: { position: [-300, 0, 0] } }] }, { history: true })
    expect(result.status).toBe('applied')
    const state = useStore.getState()
    expect(state.fittings[0]).toMatchObject({ width: 540, height: 200, position: [-20, 120, -250] })
    expect(state.fittings[1]).toMatchObject({ width: 162, position: [-155, 300, -250] })
    expect(state.panels[0]).toMatchObject({ width: 533, position: [-21.5, 300.5, -12] })
    expect(state.profiles.at(-1)!.position[0]).toBe(-300)
    expect(state.connectors[0].position[0]).toBe(-298)
    expect(state.past).toHaveLength(1)
    const after = geometry()
    state.undo()
    expect(geometry()).toEqual(before)
    useStore.getState().redo()
    expect(geometry()).toEqual(after)
  })

  it.each(['drawer', 'door', 'panel', 'runner', 'support'])('rejects a frame change when dependent %s is locked', (id) => {
    const doc = boundProject()
    doc.profiles.push({ ...doc.profiles[0], id: 'free', position: [1000, 0, 0], fixedTrims: undefined })
    load(doc)
    useStore.setState((state) => Object.fromEntries(kinds.map((kind) => [kind, state[kind].map((p) => p.id === id ? { ...p, locked: true } : p)])))
    const before = useStore.getState()
    expect(before.profiles.at(-1)!.fixedTrims).toBeUndefined()
    expect(before.updateParts({ profiles: [{ id: 'left', updates: { position: [-300, 0, 0] } }] }, { history: true }))
      .toEqual({ status: 'rejected', reason: 'locked-dependent', partIds: [id] })
    expect(useStore.getState()).toBe(before)
    expect(useStore.getState().past).toHaveLength(0)
    expect(useStore.getState().future).toHaveLength(0)
    expect(useStore.getState().profiles.at(-1)!.fixedTrims).toBeUndefined()
  })

  it.each([
    { profiles: [{ id: 'left', updates: { length: -1 } }], fittings: [{ id: 'drawer', updates: { material: 'mdf' as const } }] },
    { profiles: [{ id: 'left', updates: { position: [-300, 0, 0] as [number, number, number] } }], fittings: [{ id: 'drawer', updates: { width: 1 } }] },
  ])('rejects invalid mixed edits without partial changes', (updates) => {
    load()
    const before = useStore.getState()
    expect(before.updateParts(updates, { history: true }).status).toBe('rejected')
    expect(useStore.getState()).toBe(before)
  })

  it('rejects an impossible opening before changing geometry or history', () => {
    load()
    const before = useStore.getState()
    expect(before.commitProfileEdit('left', { position: [240, 0, 0] }).status).toBe('rejected')
    expect(useStore.getState()).toBe(before)
  })

  it('retains the last accepted preview and its single undo snapshot after rejection', () => {
    const before = load()
    expect(useStore.getState().updateParts({ profiles: [{ id: 'left', updates: { position: [-300, 0, 0] } }] }, { history: true }).status).toBe('applied')
    const accepted = useStore.getState()
    expect(accepted.updateParts({ profiles: [{ id: 'left', updates: { position: [240, 0, 0] } }] }).status).toBe('rejected')
    expect(useStore.getState()).toBe(accepted)
    expect(accepted.past).toHaveLength(1)
    accepted.undo()
    expect(geometry()).toEqual(before)
  })

  it.each([
    { fittings: [{ id: 'drawer', updates: { width: 550 } }] },
    { fittings: [{ id: 'door', updates: { position: [0, 0, 0] as [number, number, number] } }] },
    { panels: [{ id: 'panel', updates: { width: 510 } }] },
    { profiles: [{ id: 'runner', updates: { length: 300 } }] },
    { connectors: [{ id: 'support', updates: { position: [0, 0, 0] as [number, number, number] } }] },
  ])('requires detaching a driven dimension or position before editing it directly', (updates) => {
    load()
    const before = useStore.getState()
    expect(before.updateParts(updates, { history: true })).toMatchObject({ status: 'rejected', reason: 'driven-part' })
    expect(useStore.getState()).toBe(before)
  })

  it('detaches a drawer without moving it, then accepts its independent width', () => {
    load()
    const before = useStore.getState().fittings[0]
    expect(useStore.getState().updateFitting('drawer', { openingBinding: undefined }).status).toBe('applied')
    const { openingBinding: omitted, ...independent } = before
    expect(useStore.getState().fittings[0]).toEqual({ ...independent, openingBinding: undefined })
    expect(useStore.getState().updateFitting('drawer', { width: 550 }).status).toBe('applied')
    expect(useStore.getState().fittings[0].width).toBe(550)
    expect(useStore.getState().past).toHaveLength(2)
    useStore.getState().undo()
    useStore.getState().undo()
    expect(useStore.getState().fittings[0]).toEqual(before)
  })

  it('retains dependent geometry after a source is deleted and restores links on undo', () => {
    const before = load()
    const result = useStore.getState().removeProfile('back')
    expect(result).toMatchObject({ status: 'applied', orphanedIds: ['drawer', 'door', 'panel'] })
    expect(useStore.getState().fittings).toEqual(before.fittings)
    expect(useStore.getState().panels).toEqual(before.panels)
    expect(useStore.getState().connectors).toEqual(before.connectors)
    expect(resolveOpening(openingRef(), useStore.getState().profiles, 'rails').status).toBe('missing-source')
    const missing = useStore.getState()
    expect(missing.updateFitting('drawer', { width: 520 })).toMatchObject({ status: 'rejected', reason: 'driven-part' })
    expect(useStore.getState()).toBe(missing)
    missing.undo()
    expect(geometry()).toEqual(before)
    expect(resolveOpening(openingRef(), useStore.getState().profiles, 'rails').status).toBe('resolved')
  })

  it.each(['drawer', 'runner'])('retains downstream geometry when %s is deleted', (id) => {
    const before = load()
    useStore.getState().selectItems([id])
    const result = useStore.getState().removeSelected()
    expect(result).toMatchObject({ status: 'applied', orphanedIds: id === 'drawer' ? ['runner'] : ['support'] })
    expect(useStore.getState().connectors).toEqual(before.connectors)
    useStore.getState().undo()
    expect(geometry()).toEqual(before)
  })

  it('moves and rotates the entire selected assembly exactly once', () => {
    const before = load()
    useStore.getState().selectItems(kinds.flatMap((kind) => before[kind].map((p) => p.id)))
    expect(nudgeSelected([100, 20, -30])).toBe(true)
    for (const kind of kinds) for (const [i, p] of before[kind].entries())
      expectPoint(useStore.getState()[kind][i].position, [p.position[0] + 100, p.position[1] + 20, p.position[2] - 30])
    const moved = geometry(), q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
    const pivot = selectionPivot(moved.profiles, moved.connectors, 'center', moved.panels, moved.fittings)
    expect(rotateSelected('y', 90)).toBe(true)
    for (const kind of kinds) for (const [i, p] of moved[kind].entries()) {
      const expected = new THREE.Vector3(...p.position).sub(pivot).applyQuaternion(q).add(pivot)
      expect(new THREE.Vector3(...useStore.getState()[kind][i].position).distanceTo(expected)).toBeLessThan(0.002)
    }
    expect(useStore.getState().past).toHaveLength(2)
  })

  it('updates runner and brackets when drawer construction changes their height', () => {
    const before = load()
    expect(useStore.getState().updateFitting('drawer', { height: 60 }).status).toBe('applied')
    const state = useStore.getState(), rail = state.profiles.find((p) => p.id === 'runner')!
    expect(state.fittings[0].position).toEqual([0, 50, -250])
    expect(rail.position[1]).toBe(40)
    expect(state.connectors[0].position[1]).toBe(43)
    expect(rail.length).toBe(480)
    expect(state.past).toHaveLength(1)
    state.undo()
    expect(geometry()).toEqual(before)
  })

  it('keeps the frame-connected supports in place when drawer runner specifications change', () => {
    const before = load()
    const drawer = before.fittings[0].drawer!
    expect(useStore.getState().updateFitting('drawer', { drawer: { ...drawer, sideClearance: 20, runnerLength: 350, runnerTravel: 300 } }).status)
      .toBe('applied')
    const state = useStore.getState()
    expect(state.fittings[0].drawer).toMatchObject({ sideClearance: 20, runnerLength: 350, runnerTravel: 300 })
    expect(state.profiles).toEqual(before.profiles)
    expect(state.connectors).toEqual(before.connectors)
    expect(state.past).toHaveLength(1)
    state.undo()
    expect(geometry()).toEqual(before)
  })

  it('rejects invalid drawer construction without changing any linked part or history', () => {
    load()
    const before = useStore.getState()
    expect(before.updateFitting('drawer', { drawer: { ...before.fittings[0].drawer, sideClearance: 240 } }).status)
      .toBe('rejected')
    expect(useStore.getState()).toBe(before)
  })

  it.each(['runner', 'support', 'panel'])('rejects finite %s parameters whose derived geometry overflows', (kind) => {
    load()
    const before = useStore.getState()
    const updates = kind === 'runner'
      ? { profiles: [{ id: 'runner', updates: { runnerBinding: { ...before.profiles.at(-1)!.runnerBinding!, backOffset: -1e308, frontOffset: 1e308 } } }] }
      : kind === 'support'
        ? { connectors: [{ id: 'support', updates: { supportBinding: { ...before.connectors[0].supportBinding!, localPosition: [1e308, 0, 0] as [number, number, number] } } }] }
        : { panels: [{ id: 'panel', updates: { openingBinding: { ...before.panels[0].openingBinding!, normalOffset: 1e308 } } }] }
    expect(before.updateParts(updates, { history: true }).status).toBe('rejected')
    expect(useStore.getState()).toBe(before)
  })

  it('previews a joint-rule change and rejects it if a locked door would change', () => {
    const { doc } = ruleFixture()
    load(doc)
    const before = geometry()
    expect(useStore.getState().setThroughRule('posts').status).toBe('applied')
    expect(useStore.getState().fittings[0].height).toBe(570)
    expect(getThroughRule()).toBe('posts')
    useStore.getState().undo()
    expect(geometry()).toEqual(before)
    expect(getThroughRule()).toBe('rails')
    useStore.setState((s) => ({ fittings: s.fittings.map((f) => ({ ...f, locked: true })) }))
    const locked = useStore.getState()
    expect(locked.setThroughRule('posts')).toMatchObject({ status: 'rejected', reason: 'locked-dependent' })
    expect(useStore.getState()).toBe(locked)
    expect(getThroughRule()).toBe('rails')
  })
})

function ruleFixture(): { doc: ProjectDocument; ref: OpeningRef } {
  const doc = boundProject()
  doc.profiles = doc.profiles.filter((p) => p.id !== 'top')
  const post = doc.profiles[0]
  doc.profiles.push({ ...post, id: 'cap', position: [100, 600, 0], length: 200, fixedTrims: undefined },
    { ...doc.profiles.find((p) => p.id === 'bottom')!, id: 'cap-rail', position: [100, 600, 0], length: 200, fixedTrims: undefined })
  const ref = { ...openingRef(), top: { profileId: 'cap', axis: 2 as const, side: -1 as const } }
  doc.fittings = [{ ...doc.fittings[1], openingBinding: { opening: ref, mode: 'door', start: 0, end: 1 } }]
  doc.panels = []; doc.connectors = []
  doc.profiles = doc.profiles.filter((p) => !p.runnerBinding)
  return { doc, ref }
}
