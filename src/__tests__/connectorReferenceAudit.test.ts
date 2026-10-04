import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { ConnectorData, ProfileSpec } from '../store/useStore'
import { auditBrackets } from '../utils/bracketSeat'
import { validateConnectorPlacement } from '../utils/connectorPlacement'
import { parseProjectDocument } from '../utils/document'
import { buildProfile } from '../utils/profileFactory'
import { setThroughRule } from '../utils/jointUtils'

beforeEach(() => setThroughRule('rails'))
afterAll(() => setThroughRule('rails'))
const V = (x: number, y: number, z = 0) => new THREE.Vector3(x, y, z)
const frame = (rail: ProfileSpec, post = rail) => [
  { ...buildProfile(V(0, 100), V(300, 100), rail)!, id: 'rail' },
  { ...buildProfile(V(0, 100), V(0, 400), post)!, id: 'post' },
]
const read = (profiles: ReturnType<typeof frame>, part: ConnectorData) =>
  parseProjectDocument({ version: 9, profiles, connectors: [part], panels: [], fittings: [], equipment: [] })

describe('auditing imported manufacturer references', () => {
  it.each([20, 30] as const)('reports an unverified gusset %s even when both actual holes have supporting slots', (series) => {
    const profiles = frame(`${series}${series}` as ProfileSpec)
    const part: ConnectorData = { id: 'gusset', type: 'gusset', series,
      position: [series / 2, 100 + series / 2, 0], quaternion: [0, 0, 0, 1] }
    const doc = read(profiles, part)
    // These positions put both perpendicular flange holes on their host slots.
    // Import remains lossless, but a geometric fit cannot certify a missing SKU.
    expect(doc.connectors[0]).toEqual(part)
    const supported = new Map<string, string[]>()
    expect(auditBrackets(doc.profiles, doc.connectors, undefined, supported))
      .toEqual([expect.objectContaining({ id: part.id, reason: 'wrong-series' })])
    expect(supported.has(part.id)).toBe(false)
    expect(validateConnectorPlacement(part, profiles, []))
      .toMatchObject({ allowed: false, reason: 'unverified' })
  })

  it('accepts the sourced 40-series gusset on its two supported flanges', () => {
    const part: ConnectorData = { id: 'gusset', type: 'gusset', series: 40,
      position: [20, 120, 0], quaternion: [0, 0, 0, 1] }
    expect(auditBrackets(frame('4040'), [part])).toEqual([])
  })

  it('requires explicit per-arm hosts for a mixed B8/I8 inner casting and checks in-place edits', () => {
    const profiles = frame('3030', '4040')
    // Local X arm sits in B8: inner face Y=115−0.7. Local Y arm sits
    // in I8: inner face X=20−3.5. These insets differ from a same-slot part.
    const part: ConnectorData = { id: 'inner', type: 'inside-corner', series: 30,
      position: [16.5, 114.3, 0], quaternion: [0, 0, 0, 1], mountSeries: [30, 40] }
    expect(auditBrackets(profiles, [part])).toEqual([])
    const legacy = read(profiles, { ...part, mountSeries: undefined }).connectors[0]
    expect(auditBrackets(profiles, [legacy])).toEqual([expect.objectContaining({ id: part.id, reason: 'no-joint' })])
    expect(validateConnectorPlacement(legacy, profiles, [])).toMatchObject({ allowed: false, reason: 'no-joint' })
    // The casting SKU is shared; the instance series alone must not change its
    // compatibility when both actual arm hosts are recorded.
    part.series = 40
    expect(auditBrackets(profiles, [part])).toEqual([])
    part.mountSeries![0] = 40
    expect(auditBrackets(profiles, [part])).toHaveLength(1)
    part.mountSeries![0] = 30
    expect(auditBrackets(profiles, [part])).toEqual([])
    part.mountSeries = undefined
    expect(auditBrackets(profiles, [part])).toHaveLength(1)
  })

  it.each([
    [20, '2020', [9.5, 109.4, 0]],
    [30, '3030', [13.8, 114.3, 0]],
    [40, '4040', [16.5, 117, 0]],
  ] as const)('keeps same-slot legacy inner references valid for series %s', (series, spec, position) => {
    const doc = read(frame(spec), { id: 'legacy', type: 'inside-corner', series,
      position: [...position], quaternion: [0, 0, 0, 1] })
    expect(doc.connectors[0].mountSeries).toBeUndefined()
    expect(auditBrackets(doc.profiles, doc.connectors)).toEqual([])
  })
})
