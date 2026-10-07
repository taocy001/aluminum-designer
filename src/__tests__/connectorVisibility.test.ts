import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store/useStore'
import { buildProfile, placeConnector } from '../utils/profileFactory'
import { connectorPlacementCandidates, resolveConnectorPlacement } from '../utils/connectorPlacement'
import { setThroughRule } from '../utils/jointUtils'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const joint = V(0, 100, 0)
const frame = () => [
  buildProfile(joint, V(300, 100, 0), '2020', 'rail-x')!,
  buildProfile(joint, V(0, 400, 0), '2020', 'post-y')!,
  buildProfile(joint, V(0, 100, 300), '2020', 'rail-z')!,
]

beforeEach(() => {
  setThroughRule('rails')
  useStore.setState({ profiles: frame(), connectors: [], panels: [], fittings: [], equipment: [],
    past: [], future: [], selectedIds: [] })
})

describe('connector seat visibility', () => {
  it('filters selectable legs while retaining hidden members in cuts and collision checks', () => {
    const profiles = frame()
    const full = connectorPlacementCandidates('inside-corner', joint, profiles, [])
    expect(full).toHaveLength(6)
    const visible = new Set(['rail-x', 'rail-z'])
    const filtered = connectorPlacementCandidates('inside-corner', joint, profiles, [], undefined, joint,
      { seatFilter: (_seat, ids) => ids.every((id) => visible.has(id)) })
    expect(filtered).toEqual(full.filter((candidate) => candidate.legs.every((id) => visible.has(id))))
    expect(filtered).toHaveLength(2)
    expect(filtered.filter((candidate) => candidate.allowed)).toHaveLength(1)
    expect(filtered.find((candidate) => !candidate.allowed)?.reason).toBe('collision')
  })

  it('keeps an unseated ghost at the pointer when every otherwise valid seat is hidden', () => {
    const profiles = frame(), point = V(4, 108, 6)
    const original = resolveConnectorPlacement('inside-corner', point, profiles, [])
    expect(original.count).toBe(6)
    const filtered = resolveConnectorPlacement('inside-corner', point, profiles, [], undefined, original.key!, joint,
      { seatFilter: () => false })
    expect(filtered).toMatchObject({ count: 0, keys: [], key: null, allowed: false, occupied: false, reason: 'no-joint',
      seat: { seated: false, position: point.toArray() } })
    expect(filtered.legs).toBeUndefined()
  })

  it('checks visibility again at commit and adds no history for a now-hidden choice', () => {
    const original = resolveConnectorPlacement('inside-corner', joint, useStore.getState().profiles, [])
    expect(original.allowed).toBe(true)
    const before = useStore.getState()
    placeConnector(joint, 'inside-corner', undefined, original.key!, joint, () => false)
    expect(useStore.getState().connectors).toBe(before.connectors)
    expect(useStore.getState().past).toBe(before.past)
    const hiddenPair = new Set(original.legs)
    const otherPairs = (_seat: unknown, ids: readonly string[]) => !ids.every((id) => hiddenPair.has(id))
    expect(resolveConnectorPlacement('inside-corner', joint, before.profiles, [], undefined, original.key!, joint,
      { seatFilter: otherPairs }).count).toBeGreaterThan(0)
    placeConnector(joint, 'inside-corner', undefined, original.key!, joint, otherPairs)
    expect(useStore.getState().connectors).toBe(before.connectors)
    expect(useStore.getState().past).toBe(before.past)
    placeConnector(joint, 'inside-corner', undefined, original.key!, joint, () => true)
    expect(useStore.getState().connectors).toHaveLength(1)
    expect(useStore.getState().connectors[0].position).toEqual(original.seat.position)
    expect(useStore.getState().past).toHaveLength(1)
  })

  it('includes the third end member when filtering a three-way corner', () => {
    const profiles = [
      buildProfile(V(-300, 100, 0), V(-20, 100, 0), '4040', 'end-x')!,
      buildProfile(V(0, -200, 0), V(0, 80, 0), '4040', 'end-y')!,
      buildProfile(V(0, 100, -300), V(0, 100, -20), '4040', 'end-z')!,
    ]
    const full = connectorPlacementCandidates('corner-3way', joint, profiles, [])
    expect(full.some((candidate) => candidate.allowed)).toBe(true)
    const supports: string[][] = []
    const visible = connectorPlacementCandidates('corner-3way', joint, profiles, [], undefined, joint,
      { seatFilter: (_seat, ids) => { supports.push([...ids]); return true } })
    expect(visible).toEqual(full)
    expect(supports.length).toBeGreaterThan(0)
    expect(supports.every((ids) => ids.length === 3 && new Set(ids).size === 3)).toBe(true)
    for (const hiddenId of profiles.map((profile) => profile.id)) {
      expect(resolveConnectorPlacement('corner-3way', joint, profiles, [], undefined, 0, joint,
        { seatFilter: (_seat, ids) => !ids.includes(hiddenId) })).toMatchObject({
        count: 0, allowed: false, reason: 'no-joint', seat: { seated: false },
      })
    }
  })

  it.each(['end-cap', 'foot'] as const)('filters the complete %s fallback support at preview and commit', (type) => {
    const point = V(0, 0, 0), normal = type === 'end-cap' ? V(0, 0, -1) : V(0, -1, 0)
    const profile = type === 'end-cap'
      ? buildProfile(point, V(0, 0, 300), '2040', 'host')!
      : buildProfile(point, V(0, 300, 0), '4040', 'host')!
    useStore.setState({ profiles: [profile] })
    const full = resolveConnectorPlacement(type, point, [profile], [], normal)
    expect(full).toMatchObject({ allowed: true, seat: { seated: true } })
    const supports: string[][] = []
    const visible = resolveConnectorPlacement(type, point, [profile], [], normal, 0, point,
      { seatFilter: (_seat, ids) => { supports.push([...ids]); return true } })
    expect(visible).toEqual(full)
    expect(supports).toEqual([['host']])
    const hidden = resolveConnectorPlacement(type, point, [profile], [], normal, 0, point,
      { seatFilter: () => false })
    expect(hidden).toMatchObject({ count: 0, allowed: false, reason: 'no-joint', seat: { seated: false } })
    const before = useStore.getState()
    placeConnector(point, type, normal, 0, point, () => false)
    expect(useStore.getState().connectors).toBe(before.connectors)
    expect(useStore.getState().past).toBe(before.past)
    placeConnector(point, type, normal, 0, point, (_seat, ids) => ids.includes('host'))
    expect(useStore.getState().connectors).toHaveLength(1)
    expect(useStore.getState().connectors[0].profileSpec).toBe(profile.spec)
    expect(useStore.getState().past).toHaveLength(1)
  })
})
