import { expect, it } from 'vitest'
import * as THREE from 'three'
import { prepareProfile } from '../utils/profileFactory'
import { suggestNext } from '../utils/suggest'
import { vet, type SuggestDoc, type VetCache } from '../utils/suggestGate'
import type { ProfileData } from '../store/useStore'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { nextSuggestion, acceptSuggestion } from '../utils/suggestOps'

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
