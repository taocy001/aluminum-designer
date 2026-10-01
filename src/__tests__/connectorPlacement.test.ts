import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore, type ConnectorData } from '../store/useStore'
import { buildProfile, placeConnector } from '../utils/profileFactory'
import { auditBrackets, connectorSeatAt, seatsFor } from '../utils/bracketSeat'
import { setThroughRule } from '../utils/jointUtils'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const frame = (y = 20) => [
  buildProfile(V(0, 0, 0), V(0, 880, 0), '2020', 'post')!,
  buildProfile(V(0, y, 0), V(600, y, 0), '2020', 'rail')!,
]

beforeEach(() => {
  setThroughRule('rails')
  useStore.setState({ profiles: frame(), connectors: [], panels: [], fittings: [], past: [], future: [], selectedIds: [] })
})

describe('manual connector placement', () => {
  it.each(['bracket', 'inside-corner'])('repeated %s clicks add one real part and one undo step', (type) => {
    placeConnector(V(0, 20, 0), type)
    const first = useStore.getState()
    expect(auditBrackets(first.profiles, first.connectors)).toEqual([])
    expect(first.connectors).toHaveLength(1)
    expect(first.past).toHaveLength(1)
    placeConnector(V(0, 20, 0), type)
    placeConnector(V(2, 21, 0), type) // a nearby pointer still resolves to the same seat
    expect(useStore.getState().connectors).toBe(first.connectors)
    expect(useStore.getState().past).toBe(first.past)
    useStore.getState().undo()
    expect(useStore.getState().connectors).toHaveLength(0)
  })

  it.each([-1, -2])('recognizes equivalent stored quaternion scale %s and keeps a locked part', (scale) => {
    placeConnector(V(0, 20, 0), 'bracket')
    const part = useStore.getState().connectors[0]
    const existing: ConnectorData = { ...part, locked: true,
      quaternion: part.quaternion.map((v) => v * scale) as ConnectorData['quaternion'] }
    useStore.setState({ connectors: [existing], past: [] })
    placeConnector(V(0, 20, 0), 'bracket')
    expect(useStore.getState().connectors).toEqual([existing])
    expect(useStore.getState().past).toHaveLength(0)
  })

  it.each([[0.8, 1], [1.2, 2]])('uses the automatic-placement seat distance tolerance at %s mm', (offset, count) => {
    const seat = connectorSeatAt('bracket', V(0, 20, 0), useStore.getState().profiles)
    useStore.setState({ connectors: [{ id: 'existing', type: 'bracket', ...seat,
      position: [seat.position[0] + offset, seat.position[1], seat.position[2]] }] })
    placeConnector(V(0, 20, 0), 'bracket')
    expect(useStore.getState().connectors).toHaveLength(count)
  })

  it('allows both ends of a rail to receive their own valid brackets', () => {
    const profiles = [...frame(), buildProfile(V(600, 0, 0), V(600, 880, 0), '2020', 'other-post')!]
    useStore.setState({ profiles })
    placeConnector(V(0, 20, 0), 'bracket')
    placeConnector(V(600, 20, 0), 'bracket')
    expect(useStore.getState().connectors).toHaveLength(2)
    expect(auditBrackets(profiles, useStore.getState().connectors)).toEqual([])
  })

  it('keeps a valid bracket on the other side of the same T joint', () => {
    const profiles = frame(400)
    const point = V(0, 400, 0)
    const candidate = connectorSeatAt('bracket', point, profiles)
    const other = seatsFor('bracket', profiles[1], profiles[0], point)
      .find((seat) => new THREE.Vector3(...seat.position).distanceTo(new THREE.Vector3(...candidate.position)) > 1
        && auditBrackets(profiles, [{ id: 'other-face', type: 'bracket', ...seat }]).length === 0)!
    expect(other).toBeDefined()
    useStore.setState({ profiles, connectors: [{ id: 'other-face', type: 'bracket', ...other }] })
    placeConnector(point, 'bracket')
    expect(useStore.getState().connectors).toHaveLength(2)
    expect(auditBrackets(profiles, useStore.getState().connectors)).toEqual([])
  })

  it.each([{ type: 'inside-corner', series: 20 }, { type: 'bracket', series: 40 }] as const)(
    'does not mistake another connector type or series for the held part: %j', (different) => {
      const seat = connectorSeatAt('bracket', V(0, 20, 0), useStore.getState().profiles)
      useStore.setState({ connectors: [{ id: 'different-part', ...seat, ...different }] })
      placeConnector(V(0, 20, 0), 'bracket')
      expect(useStore.getState().connectors).toHaveLength(2)
      expect(useStore.getState().connectors[1]).toMatchObject({ type: 'bracket', series: 20 })
    },
  )
})
