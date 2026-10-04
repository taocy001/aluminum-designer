import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import desk from '../../examples/desk-with-pedestal.json'
import connectorDemo from '../../examples/connector-demo.json'
import { useStore, type ConnectorData, type FittingData, type ProfileData } from '../store/useStore'
import { autoConnect } from '../utils/autoConnect'
import { auditBrackets, seatsFor } from '../utils/bracketSeat'
import { connectorMounts } from '../utils/connectorCatalog'
import { connectorHitsBody, connectorsCollide } from '../utils/connectorCollision'
import { connectorMeshes } from '../utils/connectorGeometry'
import { connectorPlacementCandidates, sameConnectorInstallation, validateConnectorPlacement } from '../utils/connectorPlacement'
import { fittingSolids } from '../utils/fittingGeometry'
import { analyzeFrame } from '../utils/analysis'
import { setThroughRule } from '../utils/jointUtils'
import { makeOBB } from '../utils/obb'
import { buildProfile } from '../utils/profileFactory'
import { noClearance } from './fixtures/equipment'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const profiles = desk.profiles as unknown as ProfileData[]
const corner = V(40, 700, 560)
const fivePositions = [[10, 700, 560], [30, 700, 560], [40, 700, 570], [40, 700, 590], [40, 710, 560]]
const sortedPositions = (parts: { position: number[] }[]) => parts.map((p) => p.position).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
const existing: ConnectorData[] = [
  { id: 'locked-post-x', type: 'inside-corner', series: 20, locked: true, position: [40, 700, 570],
    quaternion: [0, 0, -Math.SQRT1_2, Math.SQRT1_2] },
  { id: 'horizontal-swapped-arms', type: 'inside-corner', series: 20, position: [40, 710, 560],
    quaternion: [-0.5, -0.5, 0.5, -0.5] },
]

beforeEach(() => {
  setThroughRule('rails')
  useStore.setState({ profiles: [], connectors: [], panels: [], fittings: [], equipment: [], past: [], future: [], selectedIds: [] })
})

describe('desk rear upper corner', () => {
  it('exposes two post-X slots, two post-Z slots and one X-Z seat', () => {
    const seats = connectorPlacementCandidates('inside-corner', corner, profiles, [])
    expect(sortedPositions(seats.map((c) => c.seat))).toEqual(fivePositions)
    expect(seats.every((c) => c.allowed && !c.occupied)).toBe(true)
    const pairs = new Map<string, number>()
    for (const seat of seats) pairs.set(seat.legs.join('/'), (pairs.get(seat.legs.join('/')) ?? 0) + 1)
    expect([...pairs.values()].sort()).toEqual([1, 2, 2])
    expect(connectorPlacementCandidates('inside-corner', corner, [...profiles].reverse(), []).map((c) => c.key))
      .toEqual(seats.map((c) => c.key))
  })

  it('recognizes swapped symmetric arms and excludes a connector when reinstalling itself', () => {
    const seats = connectorPlacementCandidates('inside-corner', corner, profiles, existing)
    expect(seats.filter((s) => s.occupied)).toHaveLength(2)
    expect(seats.filter((s) => s.allowed)).toHaveLength(3)
    const horizontal = seats.find((s) => s.seat.position.join() === '40,710,560')!
    expect(sameConnectorInstallation({ id: 'new', type: 'inside-corner', ...horizontal.seat }, existing[1])).toBe(true)
    expect(validateConnectorPlacement(existing[1], profiles, existing, { excludeConnectorId: existing[1].id }))
      .toEqual({ allowed: true, occupied: false })
  })

  it('fills all five without replacing existing parts or adding history on retry', () => {
    useStore.getState().loadDocument({ profiles, connectors: existing, panels: [], fittings: [], equipment: [], throughRule: 'rails' })
    const before = useStore.getState()
    const result = autoConnect('inside-corner')
    expect(result.placed).toBeGreaterThan(0)
    expect(result.removed).toBe(0)
    const after = useStore.getState()
    expect(after.connectors.slice(0, 2)).toEqual(existing)
    expect(after.past.length).toBe(before.past.length + 1)
    const parts = after.connectors.filter((c) => new THREE.Vector3(...c.position).distanceTo(corner) < 60)
    expect(sortedPositions(parts)).toEqual(fivePositions)
    expect(auditBrackets(profiles, parts)).toEqual([])
    expect(analyzeFrame(profiles, parts).conflicts).toEqual([])
    expect(autoConnect('inside-corner')).toMatchObject({ placed: 0, removed: 0 })
    expect(useStore.getState()).toBe(after)
  })

  it('offers the T plate with both through-member bolts and reports its obstructed opposite face', () => {
    const seats = connectorPlacementCandidates('t-bracket', corner, profiles, [])
    const top = seats.find((s) => s.seat.position.join() === '30,720,570')!
    expect(top.allowed).toBe(true)
    expect(top.legs).toEqual(['p-mufs7f0j6g', 'p-mufs7fi56h'])
    const q = new THREE.Quaternion(...top.seat.quaternion)
    const bolts = connectorMounts('t-bracket').flatMap((m) => m.bolts)
      .map((v) => new THREE.Vector3(...v).applyQuaternion(q).add(new THREE.Vector3(...top.seat.position)))
    expect(bolts.map((b) => b.toArray().map((v) => Math.round(v)))).toEqual([[8, 720, 570], [52, 720, 570], [30, 720, 542]])
    expect(seats.find((s) => s.seat.position.join() === '30,700,570')).toMatchObject({ allowed: false, reason: 'collision' })
    expect(connectorPlacementCandidates('gusset', corner, profiles, []).some((s) => s.allowed)).toBe(true)
  })
})

describe('plate and connector geometry', () => {
  it.each([0, 0.5, 1])('checks the current door opening %s independently of fitting order', (open) => {
    const door: FittingData = { id: 'door', kind: 'door', position: [0, 100, 0], quaternion: [0, 0, 0, 1],
      width: 200, height: 200, depth: 100, material: 'ply', open, hinge: 'left', hingeType: 'cup', swing: 90 }
    const remote: FittingData = { ...door, id: 'remote', position: [1000, 100, 0] }
    const part: ConnectorData = { id: 'nut', type: 't-nut', position: fittingSolids(door)[0].center.toArray(),
      quaternion: [0, 0, 0, 1], series: 20 }
    const closedPosition = fittingSolids(door, 0)[0].center.toArray()
    for (const fittings of [[door], [door, remote], [remote, door]]) {
      expect(validateConnectorPlacement(part, [], [], { fittings }))
        .toEqual({ allowed: false, occupied: false, reason: 'collision' })
      if (open > 0) expect(validateConnectorPlacement({ ...part, position: closedPosition }, [], [], { fittings }))
        .toEqual({ allowed: true, occupied: false })
    }
  })

  it('keeps the third arm outside the adjacent post while all three mounting holes reach slots', () => {
    const frame = [
      buildProfile(V(0, 10, 0), V(600, 10, 0), '2020', 'rail')!,
      buildProfile(V(0, 0, 0), V(0, 800, 0), '2020', 'post')!,
      buildProfile(V(10, 10, 0), V(10, 10, 600), '2020', 'third')!,
    ]
    const candidates = connectorPlacementCandidates('corner-3way', V(0, 10, 0), frame, [])
    expect(candidates.some((candidate) => candidate.allowed)).toBe(true)
    const part = { id: 'three-way', type: 'corner-3way', ...candidates.find((candidate) => candidate.allowed)!.seat }
    expect(auditBrackets(frame, [part])).toEqual([])
    expect(analyzeFrame(frame, [part]).conflicts).toEqual([])
    const blocker = makeOBB(V(0, 2, 16), V(3, 2, 3), new THREE.Quaternion())
    expect(connectorHitsBody({ id: 'local', type: 'corner-3way', position: [0, 0, 0], quaternion: [0, 0, 0, 1] }, blocker, 1, false)).toBe(true)
  })

  it('seats the connector showcase without profile or connector collisions', () => {
    const frame = connectorDemo.profiles as unknown as ProfileData[]
    const parts = connectorDemo.connectors as ConnectorData[]
    expect(auditBrackets(frame, parts)).toEqual([])
    expect(analyzeFrame(frame, parts).conflicts).toEqual([])
    expect(analyzeFrame(frame, parts).mismatches.filter((m) => m.kind === 'face')).toEqual([])
    for (const id of ['c3', 'c5']) {
      expect(validateConnectorPlacement(parts.find((part) => part.id === id)!, frame, parts, { excludeConnectorId: id }))
        .toEqual({ allowed: true, occupied: false })
    }
  })

  it('overrides a planar face warning only for an installed, supported and unobstructed three-way connector', () => {
    const frame = (connectorDemo.profiles as unknown as ProfileData[]).filter((p) => ['p10', 'p11', 'p12'].includes(p.id))
    const part = connectorDemo.connectors.find((c) => c.id === 'c5') as ConnectorData
    const faces = (profiles: ProfileData[], connectors: ConnectorData[]) => analyzeFrame(profiles, connectors).mismatches.filter((m) => m.kind === 'face')
    expect(faces(frame, [])).not.toHaveLength(0)
    expect(faces(frame, [part])).toEqual([])
    expect(faces(frame, [{ ...part, position: [part.position[0] + 5, part.position[1], part.position[2]] }])).not.toHaveLength(0)
    expect(faces(frame, [{ ...part, series: 30 }])).not.toHaveLength(0)
    expect(faces(frame.filter((p) => p.id !== 'p10'), [part])).not.toHaveLength(0)
    const obstructed = analyzeFrame(frame, [part], [{ id: 'blocker', position: [...part.position], quaternion: [0, 0, 0, 1],
      width: 100, height: 100, thickness: 100, material: 'ply' }])
    expect(obstructed.conflictIds.has(part.id)).toBe(true)
    expect(obstructed.mismatches.filter((m) => m.kind === 'face')).not.toHaveLength(0)
  })

  it('keeps showcase connector contact checks invariant under rigid transforms', () => {
    for (let i = 0; i < 9; i++) {
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(i * 0.19, i * 0.31, i * 0.43))
      const shift = V(17 * i, -31 * i, 10.2 * i)
      const pose = <T extends ProfileData | ConnectorData>(part: T): T => ({ ...part,
        position: new THREE.Vector3(...part.position).applyQuaternion(rotation).add(shift).toArray(),
        quaternion: rotation.clone().multiply(new THREE.Quaternion(...part.quaternion)).toArray(),
      })
      const frame = (connectorDemo.profiles as unknown as ProfileData[]).map(pose)
      const parts = (connectorDemo.connectors as ConnectorData[]).map(pose)
      const ids = new Set(parts.map((p) => p.id))
      expect(analyzeFrame(frame, parts).conflicts.filter((c) => ids.has(c.a) || ids.has(c.b))).toEqual([])
      expect(auditBrackets(frame, parts)).toEqual([])
    }
  })

  it.each(['gusset', 't-bracket'])('offers both faces, every slot and either through-member role for %s', (type) => {
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

  it.each(['bracket', 'gusset', 't-bracket', 'corner-3way'])('uses the audited mounting positions for visible %s holes', (type) => {
    const holes = connectorMeshes(type).filter((m) => m.dark)
    const mounts = connectorMounts(type).flatMap((m) => m.bolts.map((bolt) => ({ bolt, normal: m.normal })))
    expect(holes).toHaveLength(mounts.length)
    holes.forEach((mesh, i) => {
      mesh.geometry.computeBoundingBox()
      const center = mesh.geometry.boundingBox!.getCenter(new THREE.Vector3())
      const expected = new THREE.Vector3(...mounts[i].bolt)
      expected[mounts[i].normal] += 2
      expect(center.distanceTo(expected)).toBeLessThan(1e-5)
    })
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

  it('detects colliding inserted arms and a blocked exposed corner', () => {
    const part: ConnectorData = { id: 'inside', type: 'inside-corner', position: [0, 0, 0], quaternion: [0, 0, 0, 1] }
    const moved = { ...part, id: 'other', position: [10, 0, 0] as [number, number, number] }
    expect(connectorsCollide(part, moved)).toBe(true)
    expect(analyzeFrame([], [part, moved]).conflicts.map((c) => [c.a, c.b])).toEqual([['inside', 'other']])
    expect(connectorHitsBody(part, makeOBB(V(1, 1, 0), V(10, 10, 10), new THREE.Quaternion()))).toBe(true)
    // Only the deliberately inserted part of an arm overlaps this solid section envelope.
    expect(connectorHitsBody(part, makeOBB(V(10, -8, 0), V(10, 8, 10), new THREE.Quaternion()))).toBe(false)
  })
})
