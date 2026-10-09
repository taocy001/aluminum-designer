import { afterEach, expect, it } from 'vitest'
import * as THREE from 'three'
import type { ProfileData } from '../store/useStore'
import { movingPartsConflict, trimmedOBB } from '../utils/analysis'
import { computeTrims, getThroughRule, setThroughRule } from '../utils/jointUtils'
import { obbPenetration } from '../utils/obb'

const initialRule = getThroughRule()
afterEach(() => setThroughRule(initialRule))

function uncached(profiles: ProfileData[], selected: Set<string>) {
  return profiles.filter(p => selected.has(p.id)).some(p => profiles.filter(q => !selected.has(q.id))
    .some(q => obbPenetration(trimmedOBB(p, computeTrims(p, profiles)), trimmedOBB(q, computeTrims(q, profiles)), 1) > 0))
}

it('preserves collision decisions for moving subsets with fixed, automatic and angled members', () => {
  const profiles: ProfileData[] = Array.from({ length: 24 }, (_, index) => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(index % 3 === 0 ? Math.PI / 2 : 0,
      index % 3 === 1 ? Math.PI / 2 : 0, index % 4 === 0 ? .27 : 0))
    return { id: `p-${index}`, spec: index % 2 ? '2040' : '4040', length: 300,
      position: [(index % 4) * 95, 100 + Math.floor(index / 4) * 55, index % 2 ? 0 : 150],
      quaternion: q.toArray(), holes: [], miterCuts: [],
      ...(index % 2 ? { fixedTrims: { start: index % 5 ? 20 : -150, end: 10 } } : {}) }
  })
  for (const rule of ['posts', 'rails'] as const) {
    setThroughRule(rule)
    for (const ids of [[], ['absent'], profiles.map(p => p.id), ['p-0'], ['p-5'], ['p-0', 'p-2', 'p-7']]) {
      const selected = new Set(ids)
      expect(movingPartsConflict(profiles, selected), `${rule}: ${ids}`).toBe(uncached(profiles, selected))
    }
    const moved = profiles.map(p => ({ ...p, position: p.position.map((n, i) => n + (i === 0 && p.id === 'p-0' ? 2000 : 0)) as [number, number, number] }))
    expect(movingPartsConflict(moved, new Set(['p-0']))).toBe(false)
  }
})
