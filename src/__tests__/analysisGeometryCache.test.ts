import { expect, it } from 'vitest'
import * as THREE from 'three'
import type { ConnectorData, FittingData, PanelData, ProfileData } from '../store/useStore'
import { createConflictFinder, findConflicts } from '../utils/analysis'
import { computeAllTrims } from '../utils/jointUtils'
import { buildProfile } from '../utils/profileFactory'

function scene() {
  const profiles = [buildProfile(new THREE.Vector3(-100, 100, 0), new THREE.Vector3(100, 100, 0), '2020', 'beam')!]
  const connectors: ConnectorData[] = [{ id: 'angle', type: 'bracket', series: 20,
    position: [0, 100, 0], quaternion: [0, 0, 0, 1] }]
  const panels: PanelData[] = [{ id: 'panel', width: 60, height: 60, thickness: 30, material: 'ply',
    position: [0, 100, 0], quaternion: [0, 0, 0, 1] }]
  const fittings: FittingData[] = [{ id: 'drawer', kind: 'drawer', width: 180, height: 140, depth: 160,
    material: 'ply', position: [0, 100, 0], quaternion: [0, 0, 0, 1], open: 0, overlay: 'inset' }]
  return { profiles, connectors, panels, fittings }
}

it('rechecks changed profile poses, sections and actual cut lengths with one finder', () => {
  const { profiles, connectors, panels, fittings } = scene()
  const cached = createConflictFinder(profiles, connectors, panels, fittings)
  const check = () => {
    const trims = computeAllTrims(profiles)
    const full = findConflicts(profiles, trims, connectors, panels, fittings)
    expect(cached(profiles, trims, connectors, panels, fittings)).toEqual(full)
    const affected = new Set(['beam'])
    expect(cached(profiles, trims, connectors, panels, fittings, affected))
      .toEqual(full.filter((c) => affected.has(c.a) || affected.has(c.b)))
    return full
  }
  expect(check().some((c) => c.a === 'beam' && c.b === 'panel')).toBe(true)
  profiles[0].position[1] = 1000
  expect(check().some((c) => c.a === 'beam' && c.b === 'panel')).toBe(false)
  profiles[0].position[1] = 100
  check()
  profiles[0].spec = '4040'
  check()
  profiles[0].quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(.2, .4, .3)).toArray()
  check()
  profiles[0].length = 350
  check()
  const trims = computeAllTrims(profiles)
  cached(profiles, trims, connectors, panels, fittings)
  trims.get('beam')!.start.trim += 20
  trims.get('beam')!.cutLength -= 20
  expect(cached(profiles, trims, connectors, panels, fittings))
    .toEqual(findConflicts(profiles, trims, connectors, panels, fittings))
})

it('uses current connector dimensions, panel geometry and fitting opening states', () => {
  const { profiles, connectors, panels, fittings } = scene()
  const cached = createConflictFinder(profiles, connectors, panels, fittings)
  const trims = computeAllTrims(profiles)
  const check = () => expect(cached(profiles, trims, connectors, panels, fittings))
    .toEqual(findConflicts(profiles, trims, connectors, panels, fittings))
  check()
  connectors[0].position[0] += 45; check()
  connectors[0].quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(.1, .3, .6)).toArray(); check()
  connectors[0].series = 40; check()
  connectors[0].type = 'end-cap'; connectors[0].profileSpec = '2040'; check()
  connectors[0].profileSpec = '4040'; check()
  connectors[0].type = 'inside-corner'; connectors[0].mountSeries = [30, 40]; check()
  connectors[0].mountSeries[0] = 40; check()
  panels[0].width = 130; panels[0].height = 170; panels[0].thickness = 50; check()
  panels[0].position[2] = 100; check()
  panels[0].quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(.3, .1, .4)).toArray(); check()
  for (const open of [1, .5, 0, 1]) { fittings[0].open = open; check() }
  fittings[0].kind = 'door'; fittings[0].hinge = 'right'; fittings[0].swing = 120; check()
  fittings[0].quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(.1, .2, .3)).toArray(); check()
  fittings[0].position[0] = 50; fittings[0].width = 250; check()
})

it('binds value-equal replacements to the current document and follows changed array order', () => {
  const old = scene(), current = structuredClone(old)
  const cached = createConflictFinder(old.profiles, old.connectors, old.panels, old.fittings)
  cached(old.profiles, computeAllTrims(old.profiles), old.connectors, old.panels, old.fittings)
  const check = () => {
    const { profiles, connectors, panels, fittings } = current
    const trims = computeAllTrims(profiles)
    expect(cached(profiles, trims, connectors, panels, fittings))
      .toEqual(findConflicts(profiles, trims, connectors, panels, fittings))
  }
  check()
  old.profiles[0].position[1] = 9999; old.connectors[0].position[1] = 9999
  old.panels[0].position[1] = 9999; old.fittings[0].open = 1
  check()
  current.fittings.push({ ...structuredClone(current.fittings[0]), id: 'door', kind: 'door', hinge: 'left', open: 1 })
  check()
  current.fittings.reverse(); check()
  current.profiles[0].id = 'renamed'; current.panels[0].id = 'renamed-panel'; check()
  current.connectors.splice(0, 1); current.fittings.splice(0, 1); check()
})

it('rebuilds changing candidate geometry even when a caller reuses its candidate ID', () => {
  const { profiles, connectors, panels, fittings } = scene()
  const cached = createConflictFinder(profiles, connectors, panels, fittings)
  const candidate: ProfileData = { ...structuredClone(profiles[0]), id: 'candidate' }
  const check = () => {
    const after = [...profiles, candidate], trims = computeAllTrims(after), affected = new Set(['candidate'])
    const expected = findConflicts(after, trims, connectors, panels, fittings, affected)
    expect(cached(after, trims, connectors, panels, fittings, affected)).toEqual(expected)
  }
  check()
  candidate.position[1] = 1000; check()
  candidate.position[1] = 100; candidate.spec = '3030'; check()
})
