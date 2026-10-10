import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { analyzeFrame, findConflicts } from '../utils/analysis'
import { buildProfile } from '../utils/profileFactory'
import { computeAllTrims, setThroughRule, withFixedProfileCuts } from '../utils/jointUtils'
import { findSpecMismatches } from '../utils/specCompat'

const fixture = () => [
  buildProfile(new THREE.Vector3(0, 100, 0), new THREE.Vector3(600, 100, 0), '2020')!,
  buildProfile(new THREE.Vector3(300, 100, -200), new THREE.Vector3(300, 100, 200), '2040')!,
]
const move = (profiles: ReturnType<typeof fixture>, delta: THREE.Vector3) => profiles.map(p => ({
  ...p, position: new THREE.Vector3(...p.position).add(delta).toArray(),
}))

describe('analysis during whole-document translation', () => {
  it('recomputes automatic floor joints when the whole frame changes height', () => {
    const profiles = [
      buildProfile(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 600, 0), '2020')!,
      buildProfile(new THREE.Vector3(0, 0, 0), new THREE.Vector3(600, 0, 0), '2020')!,
    ]
    const before = analyzeFrame(profiles)
    const moved = move(profiles, new THREE.Vector3(0, 100, 0))
    const after = analyzeFrame(moved), trims = computeAllTrims(moved)
    expect(trims).not.toEqual(before.trims)
    expect(after.trims).toEqual(trims)
    expect(after.conflictIds).not.toBe(before.conflictIds)
    expect(after.conflicts).toEqual(findConflicts(moved, trims))
    expect(after.mismatches).toEqual(findSpecMismatches(moved))
  })

  it('reuses checks when a drag captures unchanged cuts and refreshes contact metadata', () => {
    const profiles = fixture(), before = analyzeFrame(profiles)
    const moved = move(withFixedProfileCuts(profiles), new THREE.Vector3(50, 30, -80))
    const after = analyzeFrame(moved), trims = computeAllTrims(moved)
    expect(after.conflictIds).toBe(before.conflictIds)
    expect(after.mismatchIds).toBe(before.mismatchIds)
    expect(after.trims).toEqual(trims)
    expect(after.conflicts).toEqual(findConflicts(moved, trims))
    expect(after.mismatches).toEqual(findSpecMismatches(moved))
  })

  it('reuses a trimmed corner when the remaining automatic cuts are captured', () => {
    const profiles = [
      buildProfile(new THREE.Vector3(0, 100, 0), new THREE.Vector3(0, 700, 0), '4040')!,
      buildProfile(new THREE.Vector3(0, 700, 0), new THREE.Vector3(600, 700, 0), '2040')!,
      buildProfile(new THREE.Vector3(0, 700, 0), new THREE.Vector3(0, 700, 500), '2040')!,
    ]
    const mixed = withFixedProfileCuts(profiles, new Set([profiles[0].id]))
    const before = analyzeFrame(mixed)
    expect([...before.trims.values()].some(t => t.start.trim !== 0 || t.end.trim !== 0)).toBe(true)
    const moved = move(withFixedProfileCuts(mixed), new THREE.Vector3(200, 40, -80))
    const after = analyzeFrame(moved), trims = computeAllTrims(moved)
    expect(after.conflictIds).toBe(before.conflictIds)
    expect(after.trims).toEqual(trims)
    expect(after.conflicts).toEqual(findConflicts(moved, trims))
    expect(after.mismatches).toEqual(findSpecMismatches(moved))
  })

  it('rechecks actual cut changes and restoring automatic cuts', () => {
    const profiles = fixture(), before = analyzeFrame(profiles)
    const shortened = profiles.map(p => ({ ...p, fixedTrims: { start: 0, end: p.length - 20 } }))
    const after = analyzeFrame(shortened)
    expect(after.conflictIds).not.toBe(before.conflictIds)
    expect(after.conflicts).toEqual(findConflicts(shortened, computeAllTrims(shortened)))
    const restored = move(profiles, new THREE.Vector3(12, 8, 4))
    const result = analyzeFrame(restored)
    expect(result.conflicts).toEqual(findConflicts(restored, computeAllTrims(restored)))
    expect(result.mismatches).toEqual(findSpecMismatches(restored))
  })

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

  it('retains mixed-document analysis when dimension overlays analyze profiles separately', () => {
    const profiles = fixture()
    const panels = [{ id: 'panel', material: 'ply' as const, width: 400, height: 200, thickness: 18,
      position: [100, 100, 0] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number] }]
    const before = analyzeFrame(profiles, [], panels)
    const dimensions = analyzeFrame(profiles)
    expect(analyzeFrame(profiles)).toBe(dimensions)
    const offset = new THREE.Vector3(150, 25, -80), moved = move(profiles, offset)
    const movedPanels = panels.map(p => ({ ...p, position: new THREE.Vector3(...p.position).add(offset).toArray() }))
    const after = analyzeFrame(moved, [], movedPanels)
    expect(after.trims).toBe(before.trims)
    expect(after.conflicts).toEqual(findConflicts(moved, computeAllTrims(moved), [], movedPanels))
    analyzeFrame(moved)
    expect(analyzeFrame(moved, [], movedPanels).trims).toBe(before.trims)
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
