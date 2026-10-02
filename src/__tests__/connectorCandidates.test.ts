import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore, type ProfileData } from '../store/useStore'
import { buildProfile } from '../utils/profileFactory'
import { connectorSeatsAt, auditBrackets, sharedSlotLines } from '../utils/bracketSeat'
import { autoConnect } from '../utils/autoConnect'
import { computeAllTrims, setThroughRule } from '../utils/jointUtils'
import { findConflicts } from '../utils/analysis'
import { fitConnector } from '../utils/connectorFit'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const wideCorner = (): ProfileData[] => [
  buildProfile(V(0, 0, 0), V(0, 800, 0), '2040', 'post')!,
  { ...buildProfile(V(0, 20, 0), V(600, 20, 0), '2040', 'rail')!, quaternion: [0.5, 0.5, 0.5, 0.5] },
]
const threeWay = (): ProfileData[] => [
  buildProfile(V(0, 0, 0), V(0, 800, 0), '2020', 'post')!,
  buildProfile(V(0, 400, 0), V(600, 400, 0), '2020', 'rail-x')!,
  buildProfile(V(0, 400, 0), V(0, 400, 600), '2020', 'rail-z')!,
]
const load = (profiles: ProfileData[]) => useStore.getState().loadDocument({
  version: 9, throughRule: 'rails', profiles, connectors: [], panels: [], fittings: [], equipment: [],
})

beforeEach(() => {
  setThroughRule('rails')
  useStore.setState({ profiles: [], connectors: [], panels: [], fittings: [], equipment: [], past: [], future: [], selectedIds: [] })
})

describe('all physical corner seats', () => {
  it('keeps both common slots of two 40 mm mounting faces', () => {
    expect(sharedSlotLines(0, 40, 0, 40)).toEqual([-10, 10])
    expect(sharedSlotLines(10, 20, 0, 40)).toEqual([10])
    expect(sharedSlotLines(0, 20, 0, 40)).toEqual([])
    const profiles = wideCorner()
    const seats = connectorSeatsAt('inside-corner', V(10, 30, 0), profiles)
    expect(seats.map((s) => s.position).sort()).toEqual([[10, 30, -10], [10, 30, 10]])
    expect(auditBrackets(profiles, seats.map((s, i) => ({ id: `c${i}`, type: 'inside-corner', ...s })))).toEqual([])
  })

  it('puts the pointed slot first and retains the other slot as an explicit candidate', () => {
    for (const z of [-10, 10]) {
      const profiles = wideCorner()
      const seats = connectorSeatsAt('inside-corner', V(10, 30, z), profiles, V(1, 0, 0))
      expect(seats[0].position).toEqual([10, 30, z])
      expect(seats).toHaveLength(2)
      expect(connectorSeatsAt('inside-corner', V(10, 30, z), [...profiles].reverse(), V(1, 0, 0))).toEqual(seats)
    }
  })

  it('offers each perpendicular member pair at a three-direction joint', () => {
    const profiles = threeWay()
    const seats = connectorSeatsAt('inside-corner', V(0, 400, 0), profiles)
    expect(new Set(seats.map((s) => s.legs.join('/')))).toEqual(new Set(['post/rail-x', 'post/rail-z', 'rail-x/rail-z']))
    expect(auditBrackets(profiles, seats.map((s, i) => ({ id: `c${i}`, type: 'inside-corner', ...s })))).toEqual([])
    expect(connectorSeatsAt('inside-corner', V(0, 400, 0), [...profiles].reverse())).toEqual(seats)
  })

  it('rejects a nearby perpendicular member whose cut body does not reach the bolt', () => {
    const profiles = wideCorner()
    profiles[1] = { ...profiles[1], fixedTrims: { start: 100, end: 0 } }
    expect(connectorSeatsAt('inside-corner', V(0, 20, 0), profiles)).toEqual([])
  })

  it('does not let two collinear contacts hide the perpendicular partner from orientation fitting', () => {
    const profiles = [
      buildProfile(V(0, 100, 0), V(300, 100, 0), '2020', 'left')!,
      buildProfile(V(300, 100, 0), V(600, 100, 0), '2020', 'right')!,
      buildProfile(V(300, 100, 0), V(300, 100, 300), '2020', 'cross')!,
    ]
    const fit = fitConnector('inside-corner', V(300, 100, 0), profiles)
    const q = new THREE.Quaternion(...fit.quaternion)
    expect(Math.abs(V(1, 0, 0).applyQuaternion(q).x)).toBeCloseTo(1)
    expect(Math.abs(V(0, 1, 0).applyQuaternion(q).z)).toBeCloseTo(1)
  })
})

describe('automatic corner mounting', () => {
  it('fills both 2040 slots in one undoable action without duplicating them on retry', () => {
    const profiles = wideCorner()
    load(profiles)
    const before = useStore.getState().past.length
    expect(autoConnect('inside-corner').placed).toBe(2)
    const state = useStore.getState()
    expect(state.connectors.map((c) => c.position).sort()).toEqual([[10, 30, -10], [10, 30, 10]])
    expect(state.past).toHaveLength(before + 1)
    expect(findConflicts(profiles, computeAllTrims(profiles), state.connectors)).toEqual([])
    expect(autoConnect('inside-corner').placed).toBe(0)
    expect(useStore.getState().connectors).toHaveLength(2)
    expect(useStore.getState().past).toHaveLength(before + 1)
    useStore.getState().undo()
    expect(useStore.getState().connectors).toEqual([])
  })

  it.each([1, -2])('fills the second slot beside a locked bracket with quaternion scale %s', (scale) => {
    const profiles = wideCorner()
    load(profiles)
    const seat = connectorSeatsAt('inside-corner', V(10, 30, -10), profiles)[0]
    useStore.setState({ connectors: [{ id: 'existing', type: 'inside-corner', locked: true, ...seat,
      quaternion: seat.quaternion.map((v) => v * scale) as [number, number, number, number] }] })
    expect(autoConnect('inside-corner')).toMatchObject({ placed: 1, skipped: 1, unbolted: 0 })
    expect(useStore.getState().connectors).toHaveLength(2)
    expect(useStore.getState().connectors[0].id).toBe('existing')
  })

  it('joins all three member pairs and remains independent of source array order', () => {
    const profiles = threeWay()
    load(profiles)
    expect(autoConnect('inside-corner').placed).toBe(3)
    const first = useStore.getState().connectors
    expect(auditBrackets(profiles, first)).toEqual([])
    expect(findConflicts(profiles, computeAllTrims(profiles), first)).toEqual([])
    load([...profiles].reverse())
    expect(autoConnect('inside-corner').placed).toBe(3)
    expect(useStore.getState().connectors.map(({ position, quaternion }) => ({ position, quaternion })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
      .toEqual(first.map(({ position, quaternion }) => ({ position, quaternion })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
  })
})
