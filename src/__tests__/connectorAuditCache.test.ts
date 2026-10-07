import { expect, it } from 'vitest'
import * as THREE from 'three'
import { buildProfile } from '../utils/profileFactory'
import { seatFor, seatsFor } from '../utils/bracketSeat'
import type { ConnectorData } from '../store/useStore'
import { auditBrackets } from '../utils/bracketSeat'
import { computeAllTrims } from '../utils/jointUtils'

const fixture = () => {
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
  const profiles = [buildProfile(v(0, 100, 0), v(600, 100, 0), '2020')!, buildProfile(v(0, 100, 0), v(0, 600, 0), '2020')!]
  const connector: ConnectorData = { id: 'angle', type: 'bracket', ...seatFor('bracket', profiles[0], profiles[1], v(0, 100, 0))! }
  return { profiles, connector }
}

it('refreshes cached mounting points after an in-place pose, type or series edit', () => {
  const { profiles, connector } = fixture()
  const original = structuredClone(connector)
  expect(auditBrackets(profiles, [connector])).toEqual([])
  const check = () => expect(auditBrackets(profiles, [connector]))
    .toEqual(auditBrackets(profiles, [structuredClone(connector)]))
  connector.position[0] += 5
  check()
  expect(auditBrackets(profiles, [connector])).not.toEqual([])
  Object.assign(connector, structuredClone(original))
  expect(auditBrackets(profiles, [connector])).toEqual([])
  connector.quaternion.splice(0, 4, 0, 0, 0, 1)
  check()
  connector.series = 40
  check()
  connector.type = 't-bracket'
  check()
  Object.assign(connector, original)
  expect(auditBrackets(profiles, [connector])).toEqual([])
})

it('rechecks supporting profiles after pose, section, length and trim changes', () => {
  const { profiles, connector } = fixture()
  const connectors = [connector]
  expect(auditBrackets(profiles, connectors)).toEqual([])
  const original = structuredClone(profiles[0])
  const check = () => expect(auditBrackets(profiles, connectors))
    .toEqual(auditBrackets(structuredClone(profiles), structuredClone(connectors)))
  profiles[0].position[0] += 30
  check()
  profiles[0].quaternion.splice(0, 4, 0, 0, 0, 1)
  check()
  profiles[0].spec = '2020'
  check()
  profiles[0].length /= 2
  check()
  Object.assign(profiles[0], original)
  expect(auditBrackets(profiles, connectors)).toEqual([])
  const trims = computeAllTrims(profiles)
  const trim = trims.get(profiles[0].id)!
  trim.start.trim += 80
  trim.cutLength -= 80
  expect(auditBrackets(profiles, connectors, trims))
    .toEqual(auditBrackets(structuredClone(profiles), structuredClone(connectors), trims))
})

it('finds inset inner mounts through the spatial index with the exact contact tolerances', () => {
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
  for (const specs of [['2020', '2020'], ['3030', '4040'], ['4040', '3030']] as const) {
    const frame = [buildProfile(v(0, 100, 0), v(600, 100, 0), specs[0])!,
      buildProfile(v(0, 100, 0), v(0, 600, 0), specs[1])!]
    const trims = computeAllTrims(frame)
    const seat = seatsFor('inside-corner', frame[0], frame[1], v(0, 100, 0))
      .find((s) => auditBrackets(frame, [{ id: 'inner', type: 'inside-corner', ...s }], trims).length === 0)
    expect(seat).toBeDefined()
    const original: ConnectorData = { id: 'inner', type: 'inside-corner', ...seat! }
    const expected = new Map<string, string[]>()
    expect(auditBrackets(frame, [original], trims, expected)).toEqual([])
    const remote = Array.from({ length: 24 }, (_, i) => buildProfile(v(1000 + i * 200, 100, 0), v(1000 + i * 200, 700, 0), '4040')!)
    const all = [...remote, ...frame]
    for (const [id, trim] of computeAllTrims(remote)) trims.set(id, trim)
    for (const euler of [[0, 0, 0], [.57, .93, 1.29]]) {
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(...euler)), translation = v(51, -93, 30.6)
      const profiles = all.map((p) => ({ ...p,
        position: new THREE.Vector3(...p.position).applyQuaternion(rotation).add(translation).toArray(),
        quaternion: new THREE.Quaternion(...p.quaternion).premultiply(rotation).toArray(),
      }))
      const connector: ConnectorData = { ...original,
        position: new THREE.Vector3(...original.position).applyQuaternion(rotation).add(translation).toArray(),
        quaternion: new THREE.Quaternion(...original.quaternion).premultiply(rotation).toArray(),
      }
      const actual = new Map<string, string[]>()
      expect(auditBrackets(profiles, [connector], trims, actual)).toEqual([])
      expect(actual).toEqual(expected)
      for (const [offset, allowed] of [[.99, true], [1.01, false]] as const) {
        const shifted = { ...connector, position: new THREE.Vector3(0, 0, offset)
          .applyQuaternion(new THREE.Quaternion(...connector.quaternion))
          .add(new THREE.Vector3(...connector.position)).toArray() }
        expect(auditBrackets(profiles, [shifted], trims).length === 0).toBe(allowed)
      }
    }
  }
})

it('retains input order when overlapping members can support an inner mount', () => {
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
  const profiles = [buildProfile(v(0, 100, 0), v(600, 100, 0), '2020')!,
    buildProfile(v(0, 100, 0), v(0, 600, 0), '2020')!]
  const trims = computeAllTrims(profiles)
  const seat = seatsFor('inside-corner', profiles[0], profiles[1], v(0, 100, 0))
    .find((s) => auditBrackets(profiles, [{ id: 'inner', type: 'inside-corner', ...s }], trims).length === 0)!
  const connector: ConnectorData = { id: 'inner', type: 'inside-corner', ...seat }
  const expected = new Map<string, string[]>()
  expect(auditBrackets(profiles, [connector], trims, expected)).toEqual([])
  const copies = profiles.map((p) => ({ ...structuredClone(p), id: `copy-${p.id}` }))
  copies.forEach((p, i) => trims.set(p.id, trims.get(profiles[i].id)!))
  const remote = Array.from({ length: 12 }, (_, i) => buildProfile(v(-1000 - i * 200, 0, 0), v(-1000 - i * 200, 500, 0), '2020')!)
  for (const [id, trim] of computeAllTrims(remote)) trims.set(id, trim)
  for (const copiesFirst of [true, false]) {
    const all = [...remote, ...(copiesFirst ? [...copies, ...profiles] : [...profiles, ...copies])]
    const actual = new Map<string, string[]>()
    expect(auditBrackets(all, [connector], trims, actual)).toEqual([])
    expect(actual.get('inner')).toEqual(expected.get('inner')!.map((id) => copiesFirst ? `copy-${id}` : id))
  }
})
