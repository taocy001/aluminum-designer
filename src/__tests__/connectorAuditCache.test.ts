import { expect, it } from 'vitest'
import desk from '../../examples/desk-with-pedestal.json'
import type { ConnectorData, ProfileData } from '../store/useStore'
import { auditBrackets } from '../utils/bracketSeat'
import { computeAllTrims } from '../utils/jointUtils'

it('refreshes cached mounting points after an in-place pose, type or series edit', () => {
  const profiles = desk.profiles as unknown as ProfileData[]
  const connector: ConnectorData = {
    id: 'angle', type: 'inside-corner', series: 20,
    position: [40, 700, 570], quaternion: [0, 0, -Math.SQRT1_2, Math.SQRT1_2],
  }
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
  const profiles = structuredClone(desk.profiles) as unknown as ProfileData[]
  const connectors = structuredClone(desk.connectors) as unknown as ConnectorData[]
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
