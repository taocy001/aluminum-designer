import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { buildProfile, prepareProfile } from '../utils/profileFactory'
import { suggestNext } from '../utils/suggest'
import { vet, neighbourhood, createVetSearchCache, refreshVetSearchCache, type SuggestDoc, type VetCache } from '../utils/suggestGate'
import type { ProfileData } from '../store/useStore'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { nextSuggestion, acceptSuggestion } from '../utils/suggestOps'
import { computeAllTrims, setThroughRule } from '../utils/jointUtils'
import { findConflicts } from '../utils/analysis'
import * as jointUtils from '../utils/jointUtils'

beforeEach(() => setThroughRule('rails'))
afterEach(() => vi.restoreAllMocks())

function extendingBeam() {
  const profile = (id: string, a: number[], b: number[]) => buildProfile(new THREE.Vector3(...a), new THREE.Vector3(...b), '2020', id)!
  const beam = profile('beam', [0, 100, 0], [200, 100, 0])
  const left = profile('left', [0, 0, 0], [0, 100, 0])
  const right = profile('right', [200, 0, 0], [200, 100, 0])
  return { beam, left, right }
}

it('rebinds cached numeric cuts to fresh candidate IDs and invalidates changed geometry and rules', () => {
  const { beam, left, right } = extendingBeam()
  beam.id = 'trim-cache-beam'; left.id = 'trim-cache-left'; right.id = 'trim-cache-right'
  const doc: SuggestDoc = { profiles: [beam, left], connectors: [], fittings: [], panels: [{
    id: 'trim-cache-panel', width: 2, height: 2, thickness: 2, material: 'ply',
    position: [205, 107, 0], quaternion: [0, 0, 0, 1],
  }] }
  const cache: VetCache = new Map()
  const trims = vi.spyOn(jointUtils, 'computeAllTrims')
  const afterCalls = () => trims.mock.calls.filter(([ps]) => ps.length === 3 && ps.some((p) => p.id === beam.id)).length
  const original = vet(right, { kind: 'close' }, doc, undefined, cache)
  expect(original).toEqual({ ok: false, why: 'clash trim-cache-beam|trim-cache-panel' })
  expect(afterCalls()).toBe(1)
  const first = trims.mock.calls.findIndex(([ps]) => ps.length === 3 && ps.some((p) => p.id === beam.id))
  // A caller changing its returned cut objects must not alter the cached snapshot.
  for (const cut of trims.mock.results[first].value.values()) cut.start.trim += 900
  expect(vet({ ...right, id: 'fresh-trim-candidate' }, { kind: 'close' }, doc, undefined, cache)).toEqual(original)
  expect(afterCalls()).toBe(1)
  right.position[0] = 100
  expect(vet(right, { kind: 'close' }, doc, undefined, cache)).toEqual({ ok: true })
  expect(afterCalls()).toBe(2)
  right.position[0] = 200
  expect(vet(right, { kind: 'close' }, doc, undefined, cache)).toEqual(original)
  expect(afterCalls()).toBe(2)
  setThroughRule('posts')
  vet(right, { kind: 'close' }, doc, undefined, cache)
  expect(afterCalls()).toBe(3)
  beam.fixedTrims = { start: 0, end: 10 }
  vet(right, { kind: 'close' }, doc, undefined, cache)
  expect(afterCalls()).toBe(4)
  setThroughRule('rails')
})

it('checks a changed existing beam when the new column does not hit the board', () => {
  const { beam, left, right } = extendingBeam()
  const doc: SuggestDoc = { profiles: [beam, left], connectors: [], fittings: [], panels: [{
    id: 'panel', width: 2, height: 2, thickness: 2, material: 'ply',
    position: [205, 107, 0], quaternion: [0, 0, 0, 1],
  }] }
  const after = [...doc.profiles, right]
  expect(findConflicts(doc.profiles, computeAllTrims(doc.profiles), [], doc.panels)).toEqual([])
  expect(findConflicts(after, computeAllTrims(after), [], doc.panels).map((c) => [c.a, c.b])).toEqual([['beam', 'panel']])
  const cache: VetCache = new Map()
  // This candidate has the same neighbourhood but leaves the beam's ends unchanged.
  const middle = buildProfile(new THREE.Vector3(100, 0, 0), new THREE.Vector3(100, 100, 0), '2020', 'middle')!
  expect(vet(middle, { kind: 'close' }, doc, undefined, cache).ok).toBe(true)
  expect(vet(right, { kind: 'close' }, doc, undefined, cache)).toEqual({ ok: false, why: 'clash beam|panel' })
  expect(vet({ ...right, id: 'another-right' }, { kind: 'close' }, doc, undefined, cache)).toEqual({ ok: false, why: 'clash beam|panel' })
})

it('checks an opened door against changed old metal after reusing closed-state checks', () => {
  const { beam, left, right } = extendingBeam()
  const doc: SuggestDoc = { profiles: [beam, left], connectors: [], panels: [], fittings: [{
    id: 'door', kind: 'door', width: 40, height: 26, depth: 20, material: 'ply',
    position: [220, 116, -40], quaternion: [0, 0, 0, 1], open: 0,
    hinge: 'left', hingeType: 'slot', swing: 90, overlay: 'inset',
  }] }
  const after = [...doc.profiles, right], open = doc.fittings.map((f) => ({ ...f, open: 1 }))
  expect(findConflicts(after, computeAllTrims(after), [], [], doc.fittings)).toEqual([])
  expect(findConflicts(doc.profiles, computeAllTrims(doc.profiles), [], [], open)).toEqual([])
  expect(findConflicts(after, computeAllTrims(after), [], [], open).map((c) => [c.a, c.b])).toEqual([['beam', 'door']])
  const cache: VetCache = new Map()
  expect(vet(right, { kind: 'close' }, doc, undefined, cache)).toEqual({ ok: false, why: 'clash-open beam|door' })
  expect(vet({ ...right, id: 'another-right' }, { kind: 'close' }, doc, undefined, cache)).toEqual({ ok: false, why: 'clash-open beam|door' })
})

it('invalidates shared collision baselines after in-place board and door edits', () => {
  const { beam, left, right } = extendingBeam()
  const doc: SuggestDoc = { profiles: [beam, left], connectors: [], fittings: [], panels: [{
    id: 'mutable-panel', width: 2, height: 2, thickness: 2, material: 'ply',
    position: [205, 107, 0], quaternion: [0, 0, 0, 1],
  }] }
  const cache: VetCache = new Map()
  expect(vet(right, { kind: 'close' }, doc, undefined, cache).ok).toBe(false)
  doc.panels[0].position[0] = 185
  const before = findConflicts(doc.profiles, computeAllTrims(doc.profiles), [], doc.panels)
  const after = findConflicts([...doc.profiles, right], computeAllTrims([...doc.profiles, right]), [], doc.panels)
  expect(before.map((c) => [c.a, c.b])).toEqual([['beam', 'mutable-panel']])
  expect(after.map((c) => [c.a, c.b])).toEqual([['beam', 'mutable-panel']])
  expect(vet(right, { kind: 'close' }, doc, undefined, cache)).toEqual({ ok: true })
  doc.panels[0].position[0] = 205
  expect(vet(right, { kind: 'close' }, doc, undefined, cache)).toEqual({ ok: false, why: 'clash beam|mutable-panel' })
  doc.panels = []
  doc.fittings.push({ id: 'mutable-door', kind: 'door', width: 40, height: 26, depth: 20, material: 'ply',
    position: [220, 116, -40], quaternion: [0, 0, 0, 1], open: 0,
    hinge: 'left', hingeType: 'slot', swing: 90, overlay: 'inset' })
  expect(vet(right, { kind: 'close' }, doc, undefined, cache)).toEqual({ ok: false, why: 'clash-open beam|mutable-door' })
  doc.fittings[0].position[0] = 260
  expect(vet(right, { kind: 'close' }, doc, undefined, cache)).toEqual({ ok: true })
  doc.fittings[0].position[0] = 220
  expect(vet(right, { kind: 'close' }, doc, undefined, cache)).toEqual({ ok: false, why: 'clash-open beam|mutable-door' })
})

it('reusing baseline checks preserves accepted and rejected verdicts across candidates', () => {
  const profiles: ProfileData[] = []
  const add = (a: number[], b: number[]) => profiles.push(prepareProfile(new THREE.Vector3(...a), new THREE.Vector3(...b), '2020', profiles)!)
  add([0, 10, 0], [600, 10, 0])
  add([0, 10, 0], [0, 10, 400])
  add([0, 0, 0], [0, 700, 0])
  add([600, 0, 0], [600, 700, 0])
  const doc: SuggestDoc = { profiles, connectors: [], panels: [], fittings: [] }
  const candidates = [...suggestNext(doc, [])]
  expect(candidates.length).toBeGreaterThan(1)
  const cache: VetCache = new Map()
  for (const c of candidates) {
    expect(vet(c.member, c.claim, doc, undefined, cache)).toEqual(vet(c.member, c.claim, doc))
    expect(vet(c.member, c.claim, doc, undefined, cache).ok).toBe(true)
  }
  // A later candidate overlapping an existing rail still has to pass all after checks.
  const collision = { ...profiles[0], id: 'collision' }
  expect(vet(collision, { kind: 'close' }, doc, undefined, cache)).toEqual(vet(collision, { kind: 'close' }, doc))
  expect(vet(collision, { kind: 'close' }, doc, undefined, cache).ok).toBe(false)
})

it('discarding an offer on a manufacturing-rule change prevents stale acceptance', () => {
  const profiles: ProfileData[] = []
  const add = (a: number[], b: number[]) => profiles.push(prepareProfile(new THREE.Vector3(...a), new THREE.Vector3(...b), '2020', profiles)!)
  add([0, 10, 0], [600, 10, 0])
  add([0, 10, 0], [0, 10, 400])
  add([0, 0, 0], [0, 700, 0])
  add([600, 0, 0], [600, 700, 0])
  useStore.getState().loadDocument({ profiles, connectors: [], panels: [], fittings: [], throughRule: 'rails' })
  expect(nextSuggestion()).not.toBeNull()
  expect(useToolStore.getState().suggestion).not.toBeNull()
  useStore.getState().setThroughRule('posts')
  expect(useToolStore.getState().suggestion).toBeNull()
  expect(acceptSuggestion()).toBe(false)
  expect(useStore.getState().profiles).toHaveLength(4)
  useStore.getState().setThroughRule('rails')
})

it('refreshes public caches after same-array additions, ID edits and value-equal object replacement', () => {
  const { beam, left, right } = extendingBeam()
  const doc: SuggestDoc = { profiles: [beam, left], connectors: [], fittings: [], panels: [] }
  const cache: VetCache = new Map()
  const check = () => expect(vet(right, { kind: 'close' }, doc, undefined, cache))
    .toEqual(vet(right, { kind: 'close' }, doc))
  check()
  doc.panels.push({ id: 'added-panel', width: 2, height: 2, thickness: 2, material: 'ply',
    position: [205, 107, 0], quaternion: [0, 0, 0, 1] })
  check()
  expect(vet(right, { kind: 'close' }, doc, undefined, cache).ok).toBe(false)
  doc.profiles[0].id = 'renamed-beam'
  check()
  expect(vet(right, { kind: 'close' }, doc, undefined, cache).why).toContain('renamed-beam')
  doc.panels.splice(0, 1)
  check()
  expect(vet(right, { kind: 'close' }, doc, undefined, cache).ok).toBe(true)
  const previous = doc.profiles[0]
  doc.profiles[0] = structuredClone(previous)
  const current = neighbourhood(right, doc, cache)
  expect(current.profiles[0]).toBe(doc.profiles[0])
  previous.position[0] += 2000
  expect(neighbourhood(right, doc, cache).profiles[0]).toBe(doc.profiles[0])
  check()
})

it('refreshes a resumed search after geometry and manufacturing-rule changes', () => {
  const { beam, left, right } = extendingBeam()
  const doc: SuggestDoc = { profiles: [beam, left], connectors: [], fittings: [], panels: [] }
  const cache = createVetSearchCache(doc)
  vet(right, { kind: 'close' }, doc, undefined, cache)
  beam.fixedTrims = { start: 0, end: 25 }
  setThroughRule('posts')
  refreshVetSearchCache(cache, doc)
  expect(vet(right, { kind: 'close' }, doc, undefined, cache)).toEqual(vet(right, { kind: 'close' }, doc))
  setThroughRule('rails')
})
