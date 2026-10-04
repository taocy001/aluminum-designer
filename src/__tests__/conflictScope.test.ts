import { expect, it } from 'vitest'
import * as THREE from 'three'
import type { ConnectorData, PanelData } from '../store/useStore'
import { findConflicts } from '../utils/analysis'
import { computeAllTrims } from '../utils/jointUtils'
import { buildProfile } from '../utils/profileFactory'

it('keeps every affected collision while excluding pairs of unchanged parts', () => {
  const profile = buildProfile(new THREE.Vector3(-50, 0, 0), new THREE.Vector3(50, 0, 0), '2020', 'rail')!
  const connectors: ConnectorData[] = ['a', 'b'].map((id) => ({
    id, type: 'bracket', position: [0, 0, 0], quaternion: [0, 0, 0, 1],
  }))
  const panels: PanelData[] = [{
    id: 'board', width: 100, height: 100, thickness: 20, material: 'ply',
    position: [0, 0, 0], quaternion: [0, 0, 0, 1],
  }]
  const profiles = [profile], trims = computeAllTrims(profiles)
  const full = findConflicts(profiles, trims, connectors, panels)
  expect(full.some((pair) => pair.a === 'a' && pair.b === 'b')).toBe(true)
  expect(full.some((pair) => pair.a === 'rail' && pair.b === 'board')).toBe(true)
  for (const ids of [[], ['rail'], ['board'], ['a', 'board'], ['rail', 'a', 'b', 'board']]) {
    const affected = new Set(ids)
    expect(findConflicts(profiles, trims, connectors, panels, [], affected))
      .toEqual(full.filter((pair) => affected.has(pair.a) || affected.has(pair.b)))
  }
})
