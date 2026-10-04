import { expect, it } from 'vitest'
import * as THREE from 'three'
import { buildProfile } from '../utils/profileFactory'
import { selectedSolidTop } from '../utils/selectionBounds'
import type { ProjectGeometry } from '../utils/document'
import type { PanelData, FittingData, ConnectorData } from '../store/useStore'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const document = (parts: Partial<ProjectGeometry>): ProjectGeometry => ({ profiles: [], connectors: [], panels: [], fittings: [], ...parts })

it('takes the upper outer face of a horizontal section rather than its centreline', () => {
  const p = buildProfile(V(0, 20, 0), V(600, 20, 0), '4040', 'rail')!
  expect(selectedSolidTop(document({ profiles: [p] }), ['rail'])).toBe(40)
})

it('includes the rotated rectangular section and retains submillimetre precision', () => {
  const p = buildProfile(V(0, 50, 0), V(600, 50, 0), '2040', 'rail')!
  p.quaternion = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), Math.PI / 4)
    .multiply(new THREE.Quaternion(...p.quaternion)).toArray()
  expect(selectedSolidTop(document({ profiles: [p] }), ['rail'])).toBeCloseTo(50 + 30 / Math.sqrt(2), 3)
})

it('uses the shortened physical starting end of a downward-drawn upright', () => {
  const p = { ...buildProfile(V(0, 800, 0), V(0, 0, 0), '4040', 'post')!, fixedTrims: { start: 30, end: 70 } }
  expect(selectedSolidTop(document({ profiles: [p] }), ['post'])).toBe(770)
})

it('computes automatic cuts using neighbours outside the selection', () => {
  const post = buildProfile(V(0, 0, 0), V(0, 800, 0), '4040', 'post')!
  const rail = buildProfile(V(0, 800, 0), V(600, 800, 0), '4040', 'rail')!
  expect(selectedSolidTop(document({ profiles: [post, rail] }), ['post'])).toBe(780)
  expect(selectedSolidTop(document({ profiles: [post, rail] }), ['post', 'rail'])).toBe(820)
})

it('uses a tilted board solid rather than half its unrotated height', () => {
  const board: PanelData = { id: 'panel', width: 600, height: 300, thickness: 20, material: 'mdf',
    position: [0, 100, 0], quaternion: new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), Math.PI / 2).toArray() }
  expect(selectedSolidTop(document({ panels: [board] }), ['panel'])).toBe(110)
})

it('includes the overlay of a selected door and scaled connectors while ignoring other parts', () => {
  const door: FittingData = { id: 'door', kind: 'door', width: 400, height: 600, depth: 400, frame: 20,
    material: 'mdf', position: [0, 500, 0], quaternion: [0, 0, 0, 1], open: 0 }
  const connector: ConnectorData = { id: 'bracket', type: 'bracket', series: 40, position: [0, 100, 0], quaternion: [0, 0, 0, 1] }
  const scene = document({ connectors: [connector], fittings: [door] })
  expect(selectedSolidTop(scene, ['door'])).toBe(815) // the default leaf extends beyond its opening
  expect(selectedSolidTop(scene, ['bracket'])).toBeGreaterThan(100)
  expect(selectedSolidTop(scene, ['bracket'])).toBeLessThan(800)
})

it('returns no target for an empty or no longer existing selection', () => {
  expect(selectedSolidTop(document({}), [])).toBeNull()
  expect(selectedSolidTop(document({}), ['gone'])).toBeNull()
})

it.each([
  ['foot', 128], ['gusset', 130], ['inside-corner', 120], ['t-bracket', 140],
  ['bracket', 130], ['flat-plate', 105.5], ['joining-plate', 108], ['end-cap', 110],
  ['caster-mount', 102], ['cross-bracket', 124], ['hinge', 115], ['pivot', 113],
  ['corner-3way', 120], ['t-nut', 110],
])('uses the actual %s solids instead of a collision envelope', (type, expected) => {
  const part: ConnectorData = { id: 'part', type, series: 20, position: [0, 100, 0], quaternion: [0, 0, 0, 1] }
  expect(selectedSolidTop(document({ connectors: [part] }), ['part'])).toBe(expected)
})

it('does not invent the missing upper corner of a rotated triangular gusset', () => {
  const part: ConnectorData = { id: 'part', type: 'gusset', series: 30, position: [0, 100, 0],
    quaternion: new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), Math.PI / 4).toArray() }
  // The diagonal edge x+y=22 becomes horizontal; the enclosing square's upper corner is empty.
  expect(selectedSolidTop(document({ connectors: [part] }), ['part'])).toBeCloseTo(100 + 22 / Math.SQRT2 * 1.5, 2)
})

it('includes a sideways 40-series foot disc, which is wider than its stem and top plate', () => {
  const part: ConnectorData = { id: 'part', type: 'foot', series: 40, position: [0, 100, 0],
    quaternion: new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), Math.PI / 2).toArray() }
  expect(selectedSolidTop(document({ connectors: [part] }), ['part'])).toBe(136)
})

it('scales the rotated top plate of a 30-series foot before taking the world maximum', () => {
  const part: ConnectorData = { id: 'part', type: 'foot', series: 30, position: [0, 100, 0],
    quaternion: new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), Math.PI / 4).toArray() }
  expect(selectedSolidTop(document({ connectors: [part] }), ['part'])).toBeCloseTo(100 + 38 * 1.5 / Math.sqrt(2), 3)
})
