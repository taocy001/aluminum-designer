import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { analyzeFrame, findConflicts } from '../utils/analysis'
import { buildProfile } from '../utils/profileFactory'
import { computeAllTrims, setThroughRule } from '../utils/jointUtils'
import { findSpecMismatches } from '../utils/specCompat'

const fixture = () => [
  buildProfile(new THREE.Vector3(0, 100, 0), new THREE.Vector3(600, 100, 0), '2020')!,
  buildProfile(new THREE.Vector3(300, 100, -200), new THREE.Vector3(300, 100, 200), '2040')!,
]
const move = (profiles: ReturnType<typeof fixture>, delta: THREE.Vector3) => profiles.map(p => ({
  ...p, position: new THREE.Vector3(...p.position).add(delta).toArray(),
}))

describe('analysis during whole-document translation', () => {
  it('preserves collisions and translates their markers without changing the prior result', () => {
    const profiles = fixture(), before = analyzeFrame(profiles)
    expect(before.conflicts.length).toBeGreaterThan(0)
    const oldBox = before.conflicts[0].region.clone()
    const offset = new THREE.Vector3(177, 35, -83), moved = move(profiles, offset)
    const after = analyzeFrame(moved)
    expect(after.trims).toBe(before.trims)
    expect(after.conflicts).toEqual(findConflicts(moved, computeAllTrims(moved)))
    expect(after.mismatches).toEqual(findSpecMismatches(moved))
    expect(after.conflicts[0].region).toEqual(oldBox.clone().translate(offset))
    expect(before.conflicts[0].region).toEqual(oldBox)
  })

  it('rechecks moving a subset, changed sections, and rotation', () => {
    const profiles = fixture()
    for (const changed of [
      [profiles[0], move([profiles[1]], new THREE.Vector3(0, 500, 0))[0]],
      profiles.map(p => ({ ...p, spec: '4040' as const })),
      profiles.map(p => ({ ...p, quaternion: [0, 0, 0, 1] as [number, number, number, number] })),
    ]) {
      const before = analyzeFrame(profiles), after = analyzeFrame(changed)
      expect(after.trims).not.toBe(before.trims)
      expect(after.conflicts).toEqual(findConflicts(changed, computeAllTrims(changed)))
    }
  })

  it('rechecks added parts and changed through rules', () => {
    const profiles = fixture()
    const before = analyzeFrame(profiles)
    const added = [...profiles, { ...profiles[0], id: 'added' }]
    expect(analyzeFrame(added).conflicts).toEqual(findConflicts(added, computeAllTrims(added)))
    setThroughRule('posts')
    try { expect(analyzeFrame(profiles).trims).not.toBe(before.trims) }
    finally { setThroughRule('rails') }
  })
})
