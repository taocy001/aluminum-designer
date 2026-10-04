import { expect, it } from 'vitest'
import * as THREE from 'three'
import type { ConnectorData, FittingData, PanelData } from '../store/useStore'
import { findConflicts } from '../utils/analysis'
import { fittingSolids } from '../utils/fittingGeometry'
import { computeAllTrims } from '../utils/jointUtils'
import { buildProfile } from '../utils/profileFactory'

it('matches full conflicts filtered by affected IDs, including multi-board fittings and connectors', () => {
  const member = (id: string, x: number) => buildProfile(
    new THREE.Vector3(x, 100, -100), new THREE.Vector3(x, 100, 100), '2020', id,
  )!
  const profiles = [member('old-member', 0), member('other-member', 10), member('remote-member', 2000)]
  const connectors: ConnectorData[] = [{
    id: 'angle', type: 'bracket', series: 20, position: [0, 100, 0], quaternion: [0, 0, 0, 1],
  }]
  const panel = (id: string, x: number): PanelData => ({
    id, width: 300, height: 300, thickness: 250, material: 'ply',
    position: [x, 100, 0], quaternion: [0, 0, 0, 1],
  })
  const panels = [panel('panel', 0), panel('remote-panel', 2000)]
  const drawer: FittingData = {
    id: 'drawer', kind: 'drawer', width: 180, height: 140, depth: 160, material: 'ply',
    position: [0, 100, 0], quaternion: [0, 0, 0, 1], open: 0, overlay: 'inset',
  }
  const door: FittingData = { ...drawer, id: 'door', kind: 'door', hinge: 'left', hingeType: 'slot', swing: 90 }
  const trims = computeAllTrims(profiles)
  expect(fittingSolids(drawer).length).toBeGreaterThan(2)
  for (const open of [0, 1]) {
    const fittings = [{ ...drawer, open }, door]
    const full = findConflicts(profiles, trims, connectors, panels, fittings)
    expect(full.some((c) => c.a === 'angle' || c.b === 'angle')).toBe(true)
    expect(full.some((c) => c.a === 'drawer' || c.b === 'drawer')).toBe(true)
    expect(full.some((c) => c.a === 'remote-member' && c.b === 'remote-panel')).toBe(true)
    const groups = [[], ['missing'], ['old-member'], ['angle'], ['drawer'], ['door'],
      ['old-member', 'angle', 'drawer'], [...profiles, ...connectors, ...panels, ...fittings].map((p) => p.id)]
    for (const ids of groups) {
      const affected = new Set(ids)
      // Exact array comparison preserves pair order, deepest fitting overlap and
      // region coordinates, as well as the set of colliding IDs.
      expect(findConflicts(profiles, trims, connectors, panels, fittings, affected))
        .toEqual(full.filter((c) => affected.has(c.a) || affected.has(c.b)))
    }
  }
})
