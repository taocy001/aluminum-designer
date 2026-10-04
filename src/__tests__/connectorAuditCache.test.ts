import { expect, it } from 'vitest'
import * as THREE from 'three'
import { buildProfile } from '../utils/profileFactory'
import { seatFor } from '../utils/bracketSeat'
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
