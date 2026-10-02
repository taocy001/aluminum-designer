import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore, type ConnectorData, type ProfileData } from '../store/useStore'
import { buildProfile, placeConnector } from '../utils/profileFactory'
import { auditBrackets, connectorSeatAt, seatsFor } from '../utils/bracketSeat'
import { resolveConnectorPlacement } from '../utils/connectorPlacement'
import { setThroughRule } from '../utils/jointUtils'
import { modelPointFromHit } from '../utils/pickUtils'
import { getProfileShape } from '../utils/profileShapes'

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
  it.each(['2020', '4040'] as const)('uses the sight-line model point for the reach of a %s surface hit', (spec) => {
    const profiles = [
      buildProfile(V(0, 10, 0), V(600, 10, 0), spec, 'rail')!,
      buildProfile(V(0, 10, 0), V(0, 610, 0), spec, 'post')!,
    ]
    const rail = profiles[0]
    const geometry = new THREE.ExtrudeGeometry(getProfileShape(spec), { depth: rail.length, bevelEnabled: false })
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
    mesh.position.fromArray(rail.position)
    mesh.quaternion.fromArray(rail.quaternion)
    mesh.updateMatrixWorld()
    const surfaceAt = (x: number) => {
      const origin = V(520, 420, 620)
      const raycaster = new THREE.Raycaster(origin, V(x, 10, 0).sub(origin).normalize())
      const intersection = raycaster.intersectObject(mesh, false)[0]
      expect(intersection).toBeDefined()
      const hit = { profileId: rail.id, point: intersection.point,
        normal: intersection.face!.normal.clone().transformDirection(mesh.matrixWorld) }
      return { hit, model: modelPointFromHit(hit, profiles, raycaster.ray)!.point }
    }
    try {
      const { hit, model } = surfaceAt(70)
      expect(hit.point.distanceTo(V(0, 10, 0))).toBeGreaterThan(70)
      expect(model.distanceTo(V(70, 10, 0))).toBeLessThan(1e-6)
      expect(resolveConnectorPlacement('bracket', hit.point, profiles, [], hit.normal).allowed).toBe(false)
      const ghost = resolveConnectorPlacement('bracket', hit.point, profiles, [], hit.normal, 0, model)
      expect(ghost.allowed).toBe(true)
      useStore.setState({ profiles })
      placeConnector(hit.point, 'bracket', hit.normal, ghost.key!, model)
      expect(useStore.getState().connectors).toHaveLength(1)
      expect(useStore.getState().connectors[0]).toMatchObject({ position: ghost.seat.position, quaternion: ghost.seat.quaternion })
      expect(auditBrackets(profiles, useStore.getState().connectors)).toEqual([])

      const outside = surfaceAt(80)
      expect(resolveConnectorPlacement('bracket', outside.hit.point, profiles, [], outside.hit.normal, 0, outside.model).allowed).toBe(false)
      const before = useStore.getState()
      placeConnector(outside.hit.point, 'bracket', outside.hit.normal, 0, outside.model)
      expect(useStore.getState().connectors).toBe(before.connectors)
      expect(useStore.getState().past).toBe(before.past)
    } finally {
      geometry.dispose()
      mesh.material.dispose()
    }
  })

  it('keeps the pointed 2040 slot first when joint discovery uses the centerline', () => {
    const profiles: ProfileData[] = [
      buildProfile(V(0, 0, 0), V(0, 800, 0), '2040', 'post')!,
      { ...buildProfile(V(0, 20, 0), V(600, 20, 0), '2040', 'rail')!, quaternion: [0.5, 0.5, 0.5, 0.5] },
    ]
    for (const z of [-10, 10]) {
      const result = resolveConnectorPlacement('inside-corner', V(10, 30, z), profiles, [], V(1, 0, 0), 0, V(0, 30, 0))
      expect(result).toMatchObject({ count: 2, allowed: true })
      expect(result.seat.position).toEqual([10, 30, z])
    }
  })

  it('rejects an isolated member without creating a connector or an undo entry', () => {
    useStore.setState({ profiles: frame().slice(0, 1) })
    const before = useStore.getState()
    placeConnector(V(10, 30, 0), 'inside-corner')
    const after = useStore.getState()
    expect(after.connectors).toBe(before.connectors)
    expect(after.past).toBe(before.past)
    expect(resolveConnectorPlacement('inside-corner', V(10, 30, 0), after.profiles, [])).toMatchObject({ allowed: false, count: 0 })
  })

  it('places both explicit 2040 slot choices and keeps preview and committed poses identical', () => {
    const profiles = [
      buildProfile(V(0, 0, 0), V(0, 800, 0), '2040', 'post')!,
      { ...buildProfile(V(0, 20, 0), V(600, 20, 0), '2040', 'rail')!,
        quaternion: [0.5, 0.5, 0.5, 0.5] as [number, number, number, number] },
    ]
    useStore.setState({ profiles })
    for (const choice of [0, 1]) {
      const point = V(10, 30, -10), normal = V(1, 0, 0)
      const ghost = resolveConnectorPlacement('inside-corner', point, profiles, useStore.getState().connectors, normal, choice)
      expect(ghost).toMatchObject({ count: 2, index: choice, occupied: false, allowed: true })
      placeConnector(point, 'inside-corner', normal, choice)
      expect(useStore.getState().connectors.at(-1)).toMatchObject({
        position: ghost.seat.position, quaternion: ghost.seat.quaternion, series: ghost.seat.series,
      })
      expect(resolveConnectorPlacement('inside-corner', point, profiles, useStore.getState().connectors, normal, choice).occupied).toBe(true)
      placeConnector(point, 'inside-corner', normal, choice)
    }
    expect(useStore.getState().connectors).toHaveLength(2)
    expect(useStore.getState().past).toHaveLength(2)
    expect(auditBrackets(profiles, useStore.getState().connectors)).toEqual([])
  })

  it('holds an explicitly chosen slot when a slight pointer movement reverses the proximity order', () => {
    const profiles = [
      buildProfile(V(0, 0, 0), V(0, 800, 0), '2040', 'post')!,
      { ...buildProfile(V(0, 20, 0), V(600, 20, 0), '2040', 'rail')!,
        quaternion: [0.5, 0.5, 0.5, 0.5] as [number, number, number, number] },
    ]
    const normal = V(1, 0, 0)
    const chosen = resolveConnectorPlacement('inside-corner', V(10, 30, -0.1), profiles, [], normal, 1)
    const moved = resolveConnectorPlacement('inside-corner', V(10, 30, 0.1), profiles, [], normal, chosen.key!)
    expect(moved.seat).toEqual(chosen.seat)
    expect(moved.index).not.toBe(chosen.index)
    useStore.setState({ profiles })
    placeConnector(V(10, 30, 0.1), 'inside-corner', normal, chosen.key!)
    expect(useStore.getState().connectors[0].position).toEqual(chosen.seat.position)
    expect(resolveConnectorPlacement('inside-corner', V(10, 30, 0.1), profiles, [], normal, 'missing').index).toBe(0)
  })

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
