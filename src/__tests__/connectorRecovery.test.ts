import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore, type ConnectorData, type ProfileData } from '../store/useStore'
import { buildProfile } from '../utils/profileFactory'
import { setThroughRule } from '../utils/jointUtils'
import { autoConnect } from '../utils/autoConnect'
import { connectorPlacementCandidates, validateConnectorPlacement } from '../utils/connectorPlacement'
import { repairConnectorSeats, snapDraggedConnector } from '../utils/connectorRecovery'
import { connectorTransformUpdates } from '../utils/connectorEdits'
import { connectorSeatAt } from '../utils/bracketSeat'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const point = V(0, 100, 0)
const profiles: ProfileData[] = [
  { ...buildProfile(point, V(300, 100, 0), '2040')!, id: 'rail', quaternion: [.5, .5, .5, .5] },
  { ...buildProfile(point, V(0, 400, 0), '2040')!, id: 'post', quaternion: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] },
]
const seats = () => connectorPlacementCandidates('inside-corner', point, profiles, []).filter((seat) => seat.allowed)
const installed = (): ConnectorData => ({ id: 'first', type: 'inside-corner', ...seats()[0].seat })
const moved = (part: ConnectorData, offset: THREE.Vector3): ConnectorData => ({ ...part,
  position: new THREE.Vector3(...part.position).add(offset).toArray() })

beforeEach(() => {
  setThroughRule('rails')
  useStore.setState({ profiles, connectors: [], panels: [], fittings: [], equipment: [], past: [], future: [], selectedIds: [] })
})

describe('connector installation recovery', () => {
  it('repairs a stale part before filling a blocked slot in a single undo step', () => {
    const good = installed(), stale = moved(good, V(0, 10, 0))
    const kept: ConnectorData = { id: 'kept', type: good.type, locked: true, ...seats()[1].seat }
    useStore.getState().loadDocument({ profiles, connectors: [stale, kept], panels: [], fittings: [], equipment: [], throughRule: 'rails' })
    const before = useStore.getState()
    expect(validateConnectorPlacement(stale, profiles, [kept]).reason).toBe('no-joint')
    expect(autoConnect(good.type)).toMatchObject({ repaired: 1, placed: 0, unresolved: 0, removed: 0 })
    const after = useStore.getState()
    expect(after.connectors).toHaveLength(2)
    expect(after.connectors[0]).toMatchObject(good)
    expect(after.connectors[1]).toEqual(kept)
    expect(after.past).toHaveLength(before.past.length + 1)
    expect(autoConnect(good.type)).toMatchObject({ repaired: 0, placed: 0 })
    expect(useStore.getState()).toBe(after)
    after.undo()
    expect(useStore.getState().connectors).toEqual([stale, kept])
  })

  it('leaves locked, ambiguous and remote installations for explicit review', () => {
    const good = installed()
    const locked = { ...moved(good, V(0, 10, 0)), locked: true }
    expect(repairConnectorSeats(good.type, profiles, [locked])).toMatchObject({ repaired: 0, unresolved: 1, connectors: [locked] })
    const middle = moved(good, V(0, 10, -good.position[2]))
    expect(repairConnectorSeats(good.type, profiles, [middle])).toMatchObject({ repaired: 0, unresolved: 1, connectors: [middle] })
    const remote = moved(good, V(0, 80, 0))
    expect(repairConnectorSeats(good.type, profiles, [remote])).toMatchObject({ repaired: 0, unresolved: 1, connectors: [remote] })
  })

  it('keeps obstruction checks when choosing a repair', () => {
    const good = installed(), stale = moved(good, V(0, 10, 0))
    const panel = { id: 'blocker', position: good.position, quaternion: [0, 0, 0, 1] as ConnectorData['quaternion'],
      width: 100, height: 100, thickness: 100, material: 'ply' as const }
    expect(repairConnectorSeats(good.type, profiles, [stale], { panels: [panel] }))
      .toMatchObject({ repaired: 0, unresolved: 1, connectors: [stale] })
  })

  it('does not replace an existing cap with another cross section of the same series', () => {
    const rail = buildProfile(V(0, 100, 0), V(300, 100, 0), '2040', 'wide')!
    const seat = connectorSeatAt('end-cap', V(0, 100, 0), [rail], V(-1, 0, 0))
    expect(seat.profileSpec).toBe('2040')
    const cap = moved({ id: 'cap', type: 'end-cap', ...seat, profileSpec: '2020' }, V(-5, 0, 0))
    expect(repairConnectorSeats(cap.type, [rail], [cap])).toMatchObject({ repaired: 0, connectors: [cap] })
    const position = new THREE.Vector3(...cap.position)
    expect(snapDraggedConnector(cap, position, position, [rail], [cap], [0, 1, 2], 12)).toBeNull()
    const matching = { ...cap, profileSpec: '2040' as const }
    expect(snapDraggedConnector(matching, position, position, [rail], [matching], [0], 12)?.seat.position).toEqual(seat.position)
    expect(repairConnectorSeats(matching.type, [rail], [matching])).toMatchObject({ repaired: 1 })
  })
})

describe('dragging a connector onto a physical seat', () => {
  it.each(['foot', 'caster-mount'])('snaps an existing %s to a supported downward end', (type) => {
    const post = buildProfile(V(0, 150, 0), V(0, 450, 0), '3030', 'upright')!
    const seat = connectorSeatAt(type, V(0, 150, 0), [post], V(0, -1, 0))
    const part = moved({ id: 'base', type, ...seat }, V(0, -5, 0))
    const origin = new THREE.Vector3(...part.position)
    const snapped = snapDraggedConnector(part, origin, origin, [post], [part], [1], 12)
    expect(snapped?.seat.position).toEqual(seat.position)
    expect(validateConnectorPlacement({ ...part, ...snapped!.seat }, [post], [])).toMatchObject({ allowed: true })
  })

  it('finds the fractional vertical correction without changing the other axes or orientation', () => {
    const good = installed(), stale = moved(good, V(0, -5.6, 0)), origin = new THREE.Vector3(...stale.position)
    const candidate = snapDraggedConnector(stale, origin.clone().add(V(0, 5, 0)), origin, profiles, [stale], [1], 12)
    expect(candidate?.seat).toMatchObject({ position: good.position, quaternion: good.quaternion })
    expect(validateConnectorPlacement({ ...stale, ...candidate!.seat }, profiles, [])).toMatchObject({ allowed: true })
  })

  it('does not jump sideways on an axis drag or snap onto an occupied installation', () => {
    const good = installed(), offAxis = moved(good, V(3, -5.6, 0)), origin = new THREE.Vector3(...offAxis.position)
    expect(snapDraggedConnector(offAxis, origin, origin, profiles, [offAxis], [1], 12)).toBeNull()
    const stale = moved(good, V(0, -5.6, 0)), vertical = new THREE.Vector3(...stale.position)
    expect(snapDraggedConnector(stale, vertical, vertical, profiles, [stale, { ...good, id: 'occupied' }], [1], 12)).toBeNull()
    expect(snapDraggedConnector(stale, vertical.clone().add(V(0, -40, 0)), vertical, profiles, [stale], [1], 12)).toBeNull()
  })

  it('retains board attachment metadata during manual movement and excludes generic seats', () => {
    const part: ConnectorData = { ...installed(), type: 'joining-plate',
      panelMount: { panelId: 'shelf', profileId: 'rail', boardThickness: 18, spacer: 10 } }
    const origin = new THREE.Vector3(...part.position)
    expect(snapDraggedConnector(part, origin, origin, profiles, [part], [0, 1, 2], 20)).toBeNull()
    const position = origin.clone().add(V(0, .1, 0)).toArray()
    const result = { ...part, ...connectorTransformUpdates(part, { position }) }
    expect(result.position).toEqual(position)
    expect(result.panelMount).toEqual(part.panelMount)
    expect(repairConnectorSeats(part.type, profiles, [result])).toMatchObject({ repaired: 0, connectors: [result] })
  })
})
