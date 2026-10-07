import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import connectorDemo from '../../examples/connector-demo.json'
import deskExample from '../../examples/desk-with-pedestal.json'
import { useStore, type ConnectorData, type FittingData, type ProfileData } from '../store/useStore'
import { autoConnect } from '../utils/autoConnect'
import { auditBrackets, seatsFor } from '../utils/bracketSeat'
import { CONNECTOR_CATALOG, connectorMounts } from '../utils/connectorCatalog'
import { connectorHitsBody, connectorsCollide } from '../utils/connectorCollision'
import { connectorPlacementCandidates, sameConnectorInstallation, validateConnectorPlacement } from '../utils/connectorPlacement'
import { fittingSolids } from '../utils/fittingGeometry'
import { analyzeFrame } from '../utils/analysis'
import { computeAllTrims, setThroughRule } from '../utils/jointUtils'
import { makeOBB } from '../utils/obb'
import { buildProfile } from '../utils/profileFactory'
import { noClearance } from './fixtures/equipment'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const corner = V(0, 100, 0)
const profiles: ProfileData[] = [
  { ...buildProfile(corner, V(300, 100, 0), '2040')!, id: 'rail', quaternion: [.5, .5, .5, .5] },
  { ...buildProfile(corner, V(0, 400, 0), '2040')!, id: 'post', quaternion: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] },
]
const atCorner = (parts: ConnectorData[] = []) => connectorPlacementCandidates('inside-corner', corner, profiles, parts)
const installed = (): ConnectorData => ({ id: 'existing', type: 'inside-corner', locked: true, ...atCorner().find((seat) => seat.allowed)!.seat })
const endFrame = (): ProfileData[] => [
  { ...buildProfile(V(-300, 100, 0), V(-20, 100, 0), '4040')!, id: 'rail' },
  { ...buildProfile(V(0, -200, 0), V(0, 80, 0), '4040')!, id: 'post' },
  { ...buildProfile(V(0, 100, -300), V(0, 100, -20), '4040')!, id: 'cross' },
]

beforeEach(() => {
  setThroughRule('rails')
  useStore.setState({ profiles: [], connectors: [], panels: [], fittings: [], equipment: [], past: [], future: [], selectedIds: [] })
})

describe('two-slot 2040 corner', () => {
  it('exposes both slots and both arm assignments while blocking the colliding assignment', () => {
    const seats = atCorner()
    expect(seats).toHaveLength(4)
    expect(seats.filter((seat) => seat.allowed)).toHaveLength(2)
    expect(seats.filter((seat) => !seat.allowed).every((seat) => seat.reason === 'collision')).toBe(true)
    expect(seats.filter((seat) => seat.allowed).map((seat) => seat.seat.position[2]).sort((a, b) => a - b)).toEqual([-10, 10])
    expect(new Set(seats.map((seat) => seat.legs.join('/')))).toEqual(new Set(['rail/post', 'post/rail']))
    expect(connectorPlacementCandidates('inside-corner', corner, [...profiles].reverse(), []).map((seat) => seat.key))
      .toEqual(seats.map((seat) => seat.key))
  })

  it('recognizes equivalent quaternion signs and excludes itself when reinstalling', () => {
    const existing = installed(), seats = atCorner([existing])
    expect(seats.filter((seat) => seat.occupied)).toHaveLength(1)
    expect(seats.filter((seat) => seat.allowed)).toHaveLength(1)
    const equivalent = { ...existing, id: 'new', quaternion: existing.quaternion.map((n) => -n) as ConnectorData['quaternion'] }
    expect(sameConnectorInstallation(equivalent, existing)).toBe(true)
    const alternate = atCorner().find((seat) => seat.seat.position[2] === existing.position[2] && !seat.allowed)!
    expect(sameConnectorInstallation({ id: 'opposite-arm', type: 'inside-corner', ...alternate.seat }, existing)).toBe(false)
    expect(validateConnectorPlacement(existing, profiles, [existing], { excludeConnectorId: existing.id }))
      .toEqual({ allowed: true, occupied: false })
  })

  it('fills the second slot without replacing a locked part or adding history on retry', () => {
    const existing = installed()
    useStore.getState().loadDocument({ profiles, connectors: [existing], panels: [], fittings: [], equipment: [], throughRule: 'rails' })
    const before = useStore.getState()
    expect(autoConnect('inside-corner')).toMatchObject({ placed: 1, removed: 0 })
    const after = useStore.getState()
    expect(after.connectors[0]).toEqual(existing)
    expect(after.past.length).toBe(before.past.length + 1)
    expect(after.connectors).toHaveLength(2)
    expect(after.connectors.map((part) => part.position[2]).sort((a, b) => a - b)).toEqual([-10, 10])
    expect(auditBrackets(profiles, after.connectors)).toEqual([])
    expect(analyzeFrame(profiles, after.connectors).conflicts).toEqual([])
    expect(autoConnect('inside-corner')).toMatchObject({ placed: 0, removed: 0 })
    expect(useStore.getState()).toBe(after)
  })

  it('places every T-plate hole on the through member or branch and checks the opposite face separately', () => {
    const frame = [
      { ...buildProfile(V(-200, 100, 0), V(200, 100, 0), '2020')!, id: 'rail' },
      { ...buildProfile(V(0, 100, 0), V(0, 400, 0), '2020')!, id: 'post' },
    ]
    const seats = connectorPlacementCandidates('t-bracket', corner, frame, [])
    expect(seats).toHaveLength(2)
    expect(seats.every((seat) => seat.allowed)).toBe(true)
    const top = seats.find((seat) => seat.seat.position[2] > 0)!
    expect(top.legs).toEqual(['rail', 'post'])
    const q = new THREE.Quaternion(...top.seat.quaternion)
    const bolts = connectorMounts('t-bracket').flatMap((mount) => mount.bolts)
      .map((v) => new THREE.Vector3(...v).applyQuaternion(q).add(new THREE.Vector3(...top.seat.position)))
    expect(bolts.map((v) => v.toArray().map((n) => Math.round(n) || 0)))
      .toEqual([[-20, 100, 10], [0, 100, 10], [20, 100, 10], [0, 120, 10], [0, 140, 10]])
    const blocker = { id: 'blocker', position: [0, 120, -14] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number],
      width: 100, height: 100, thickness: 4, material: 'ply' as const }
    const blocked = connectorPlacementCandidates('t-bracket', corner, frame, [], undefined, undefined, { panels: [blocker] })
    expect(blocked.find((seat) => seat.seat.position[2] > 0)?.allowed).toBe(true)
    expect(blocked.find((seat) => seat.seat.position[2] < 0)).toMatchObject({ allowed: false, reason: 'collision' })
  })
})

describe('plate and connector geometry', () => {
  it('fits five real B6 inside corners at the desk front-left joint across all three member pairs', () => {
    const frame = deskExample.profiles as unknown as ProfileData[]
    const parts = deskExample.connectors as unknown as ConnectorData[]
    const point = V(40, 700, 560)
    const installed = parts.filter((part) => new THREE.Vector3(...part.position).distanceTo(point) < 35)
    const supports = new Map<string, string[]>()
    expect(installed).toHaveLength(5)
    expect(auditBrackets(frame, installed, computeAllTrims(frame), supports)).toEqual([])
    const pairCounts = new Map<string, number>()
    for (const part of installed) {
      const members = supports.get(part.id)!
      expect(members).toHaveLength(2)
      const key = [...members].sort().join('|')
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1)
      expect(validateConnectorPlacement(part, frame, parts, { excludeConnectorId: part.id }))
        .toEqual({ allowed: true, occupied: false })
    }
    expect([...pairCounts.values()].sort()).toEqual([1, 2, 2])
    expect(installed.map((part) => part.position).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]))
      .toEqual([[10, 700.5, 560.6], [30, 700.5, 560.6], [39.4, 700.5, 570], [39.4, 700.5, 590], [39.4, 710, 560.5]])
    expect(analyzeFrame(frame, parts).conflicts).toEqual([])

    // Extending the front beam over the post blocks the two side-beam brackets.
    // A third member must still obstruct them despite valid holes in both hosts.
    const front = frame.find((p) => p.id === 'p-mufs7f0j6g')!
    expect(front.position[0]).toBe(40)
    const obstructed = frame.map((p) => p.id === front.id ? { ...p, position: [0, ...p.position.slice(1)] as ProfileData['position'], length: p.length + 40 } : p)
    for (const part of installed.filter((p) => p.position[0] < 35)) {
      expect(validateConnectorPlacement(part, obstructed, [], {})).toMatchObject({ allowed: false, reason: 'collision' })
    }
  })

  it.each([0, 0.5, 1])('checks the current door opening %s independently of fitting order', (open) => {
    const door: FittingData = { id: 'door', kind: 'door', position: [0, 100, 0], quaternion: [0, 0, 0, 1],
      width: 200, height: 200, depth: 100, material: 'ply', open, hinge: 'left', hingeType: 'cup', swing: 90 }
    const remote: FittingData = { ...door, id: 'remote', position: [1000, 100, 0] }
    const center = fittingSolids(door)[0].center
    const frame = [
      { ...buildProfile(V(0, 100, 0), V(300, 100, 0), '2020')!, id: 'rail' },
      { ...buildProfile(V(0, 100, 0), V(0, 400, 0), '2020')!, id: 'post' },
    ]
    const seat = connectorPlacementCandidates('bracket', corner, frame, []).find((candidate) => candidate.allowed)!.seat
    const shift = center.clone().sub(new THREE.Vector3(...seat.position)).sub(V(10, 2, 0))
    frame.forEach((profile) => { profile.position = new THREE.Vector3(...profile.position).add(shift).toArray() })
    const part: ConnectorData = { id: 'bracket', type: 'bracket', ...seat,
      position: new THREE.Vector3(...seat.position).add(shift).toArray() }
    expect(validateConnectorPlacement(part, frame, [])).toEqual({ allowed: true, occupied: false })
    for (const fittings of [[door], [door, remote], [remote, door]]) {
      expect(validateConnectorPlacement(part, frame, [], { fittings }))
        .toEqual({ allowed: false, occupied: false, reason: 'collision' })
    }
    if (open > 0) expect(validateConnectorPlacement(part, frame, [], { fittings: [{ ...door, open: 0 }] }))
      .toEqual({ allowed: true, occupied: false })
  })

  it('fits a three-way cube between three square-cut 4040 ends and requires the third support', () => {
    const frame = endFrame()
    const candidate = connectorPlacementCandidates('corner-3way', corner, frame, []).find((seat) => seat.allowed)!
    expect(candidate).toBeDefined()
    const part: ConnectorData = { id: 'three-way', type: 'corner-3way', ...candidate.seat }
    expect(auditBrackets(frame, [part])).toEqual([])
    expect(analyzeFrame(frame, [part]).conflicts).toEqual([])
    expect(validateConnectorPlacement(part, frame.slice(0, 2), [])).toMatchObject({ allowed: false, reason: 'no-joint' })
    const blocker = makeOBB(corner.clone(), V(3, 3, 3), new THREE.Quaternion())
    expect(connectorHitsBody(part, blocker, 1, false)).toBe(true)
  })

  it('installs all fourteen showcase parts on their supported profiles', () => {
    const frame = connectorDemo.profiles as unknown as ProfileData[]
    const parts = connectorDemo.connectors as unknown as ConnectorData[]
    expect(new Set(parts.map((part) => part.type))).toEqual(new Set(CONNECTOR_CATALOG.map((part) => part.type)))
    expect(connectorDemo.showcaseSamples).toEqual([])
    expect(auditBrackets(frame, parts)).toEqual([])
    expect(analyzeFrame(frame, parts).conflicts).toEqual([])
    expect(analyzeFrame(frame, parts).mismatches.filter((m) => m.kind === 'face')).toEqual([])
    for (const part of parts) {
      const status = validateConnectorPlacement(part, frame, parts, { excludeConnectorId: part.id })
      expect(status, part.type).toEqual({ allowed: true, occupied: false })
    }
  })

  it('does not accept a displaced, incompatible or obstructed three-way installation', () => {
    const frame = endFrame()
    const seat = connectorPlacementCandidates('corner-3way', corner, frame, []).find((candidate) => candidate.allowed)!.seat
    const part: ConnectorData = { id: 'cube', type: 'corner-3way', ...seat }
    expect(validateConnectorPlacement({ ...part, position: [5, 100, 0] }, frame, [])).toMatchObject({ allowed: false, reason: 'no-joint' })
    expect(validateConnectorPlacement({ ...part, series: 30 }, frame, [])).toMatchObject({ allowed: false, reason: 'unverified' })
    const panel = { id: 'blocker', position: [...part.position] as ConnectorData['position'], quaternion: [0, 0, 0, 1] as ConnectorData['quaternion'],
      width: 100, height: 100, thickness: 100, material: 'ply' as const }
    expect(validateConnectorPlacement(part, frame, [], { panels: [panel] })).toMatchObject({ allowed: false, reason: 'collision' })
    expect(analyzeFrame(frame, [part], [panel]).conflictIds.has(part.id)).toBe(true)
  })

  it('keeps showcase connector contact checks invariant under rigid transforms', () => {
    const original = connectorDemo.profiles as unknown as ProfileData[]
    const trims = computeAllTrims(original)
    // Freeze physical cut ends before rotating; the world-axis through-member rule
    // otherwise recalculates a different assembly instead of rigidly moving this one.
    const fixed = original.map((p) => ({ ...p, fixedTrims: {
      start: trims.get(p.id)!.start.trim, end: trims.get(p.id)!.end.trim,
    } }))
    for (let i = 0; i < 9; i++) {
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(i * 0.19, i * 0.31, i * 0.43))
      const shift = V(17 * i, -31 * i, 10.2 * i)
      const pose = <T extends ProfileData | ConnectorData>(part: T): T => ({ ...part,
        position: new THREE.Vector3(...part.position).applyQuaternion(rotation).add(shift).toArray(),
        quaternion: rotation.clone().multiply(new THREE.Quaternion(...part.quaternion)).toArray(),
      })
      const frame = fixed.map(pose)
      const parts = (connectorDemo.connectors as unknown as ConnectorData[]).map(pose)
      const ids = new Set(parts.map((p) => p.id))
      expect(analyzeFrame(frame, parts).conflicts.filter((c) => ids.has(c.a) || ids.has(c.b))).toEqual([])
      // Feet and casters require downward-facing hosts; their supported floor
      // orientation is checked above, independently of rigid contact transforms.
      expect(auditBrackets(frame, parts.filter((part) => !['foot', 'caster-mount'].includes(part.type)))).toEqual([])
    }
  })

  it('offers both faces, every slot and either through-member role for a T plate', () => {
    const type = 't-bracket'
    const cross: ProfileData[] = [
      { ...buildProfile(V(-200, 0, 0), V(200, 0, 0), '2040', 'x')!, quaternion: [0.5, 0.5, 0.5, 0.5] },
      { ...buildProfile(V(0, 0, -200), V(0, 0, 200), '2040', 'z')!, quaternion: [0, 0, Math.SQRT1_2, Math.SQRT1_2] },
    ]
    const seats = seatsFor(type, cross[0], cross[1], V(0, 0, 0))
    expect(seats).toHaveLength(32)
    expect(auditBrackets(cross, seats.map((seat, i) => ({ id: `plate-${i}`, type, ...seat })))).toEqual([])
    expect(new Set(seats.map((s) => s.position.join()))).toEqual(new Set(
      [-10, 10].flatMap((x) => [-10, 10].flatMap((y) => [-10, 10].map((z) => [x, y, z].join()))),
    ))
    expect(new Set(seats.map((s) => s.legs.join('/')))).toEqual(new Set(['x/z', 'z/x']))
  })

  it.each(['gusset', 't-bracket'])('leaves the empty part of the %s envelope available', (type) => {
    const part: ConnectorData = { id: 'plate', type, position: [0, 0, 0], quaternion: [0, 0, 0, 1] }
    const empty = makeOBB(V(25, 25, 2), V(2, 2, 2), new THREE.Quaternion())
    const metal = makeOBB(V(18, 0, 2), V(2, 2, 2), new THREE.Quaternion())
    expect(connectorHitsBody(part, empty, 1, false)).toBe(false)
    expect(connectorHitsBody(part, metal, 1, false)).toBe(true)
    const equipment = { id: 'unit', name: 'Unit', width: 4, height: 4, depth: 4,
      position: [25, 25, 2] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], clearance: noClearance() }
    expect(analyzeFrame([], [part], [], [], [equipment]).equipmentConflicts).toEqual([])
  })

  it('detects colliding inserted arms and checks each member against its own slot', () => {
    const part: ConnectorData = { id: 'inside', type: 'inside-corner', position: [-.5, -.6, 0], quaternion: [0, 0, 0, 1] }
    const moved = { ...part, id: 'other', position: [10, 0, 0] as [number, number, number] }
    expect(connectorsCollide(part, moved)).toBe(true)
    expect(analyzeFrame([], [part, moved]).conflicts.map((c) => [c.a, c.b])).toEqual([['inside', 'other']])
    expect(connectorHitsBody(part, makeOBB(V(1, 1, 0), V(10, 10, 10), new THREE.Quaternion()))).toBe(true)
    const alongX = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), Math.PI / 2)
    expect(connectorHitsBody(part, makeOBB(V(50, -10, 0), V(10, 10, 50), alongX))).toBe(false)
    // A crossing member cannot inherit the exemption of the arm's mounting member.
    expect(connectorHitsBody(part, makeOBB(V(10, -10, 0), V(10, 10, 10), new THREE.Quaternion()))).toBe(true)
  })
})
