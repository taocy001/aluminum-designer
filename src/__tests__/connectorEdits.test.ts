import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore, type ConnectorData, type ProfileData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { buildProfile } from '../utils/profileFactory'
import { setThroughRule } from '../utils/jointUtils'
import { deriveSupport } from '../utils/openingBindings'
import { connectorPlacementCandidates } from '../utils/connectorPlacement'
import { auditBrackets, seatFor } from '../utils/bracketSeat'
import { connectorMeshes } from '../utils/connectorGeometry'
import { connectorTransformUpdates, reseatConnector, setConnectorAngles, setConnectorPose } from '../utils/connectorEdits'
import { commitExactMove, mirrorSelected, nudgeSelected, orientationDegrees, rotateSelected } from '../utils/editOps'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const connector = (): ConnectorData => ({ id: 'c', type: 'bracket', series: 20,
  position: [30, 100, 40], quaternion: [0, 0, 0, 1] })
const host = (): ProfileData => ({ ...buildProfile(V(0, 100, 0), V(0, 600, 0), '2020')!, id: 'p' })
const bound = (p: ProfileData): ConnectorData => deriveSupport({ ...connector(), supportBinding: {
  profileId: p.id, end: 'start', localPosition: [10, 10, 10], localQuaternion: [0, 0, 0, 1],
} }, p)!
function load(connectors = [connector()], profiles: ProfileData[] = []) {
  useStore.setState({ profiles, connectors, panels: [], fittings: [], equipment: [], selectedIds: ['c'], past: [], future: [], throughRule: 'rails' })
}

beforeEach(() => {
  load()
  setThroughRule('rails')
  useToolStore.getState().stopDrag()
  useToolStore.getState().setPivotMode('center')
})

describe('connector pose editing', () => {
  it('commits positions and arbitrary angles as separate reversible edits', () => {
    const before = connector()
    expect(setConnectorPose('c', { position: [65.125, 100, 40] })).toBe(true)
    expect(setConnectorAngles('c', [15, 25, 35])).toBe(true)
    expect(useStore.getState().connectors[0].position).toEqual([65.125, 100, 40])
    expect(orientationDegrees(useStore.getState().connectors[0].quaternion)).toEqual([15, 25, 35])
    expect(useStore.getState().past).toHaveLength(2)
    useStore.getState().undo()
    expect(useStore.getState().connectors[0].quaternion).toEqual(before.quaternion)
    useStore.getState().undo()
    expect(useStore.getState().connectors[0]).toEqual(before)
    useStore.getState().redo()
    expect(useStore.getState().connectors[0].position).toEqual([65.125, 100, 40])
  })

  it('does not record invalid, unchanged or locked edits', () => {
    expect(setConnectorPose('c', { position: [NaN, 100, 0] })).toBe(false)
    expect(setConnectorPose('c', { quaternion: [0, 0, 0, 0] })).toBe(false)
    expect(setConnectorAngles('c', [0, Infinity, 0])).toBe(false)
    expect(setConnectorPose('c', { position: connector().position })).toBe(false)
    expect(setConnectorPose('c', { quaternion: [0, 0, 0, -1] })).toBe(false)
    load([{ ...connector(), locked: true }])
    expect(setConnectorPose('c', { position: [50, 100, 40] })).toBe(false)
    expect(setConnectorAngles('c', [0, 30, 0])).toBe(false)
    expect(nudgeSelected([100, 0, 0])).toBe(false)
    expect(rotateSelected('z', 90)).toBe(false)
    expect(useStore.getState().past).toHaveLength(0)
  })

  it('keeps support bindings and history when a drag snaps back to the same pose', () => {
    const p = host(), c = bound(p)
    load([c], [p])
    const updates = connectorTransformUpdates(c, { position: [...c.position],
      quaternion: c.quaternion.map((v) => -v) as ConnectorData['quaternion'] })
    expect(updates).toEqual({})
    expect(useStore.getState().updateParts({ connectors: [{ id: c.id, updates }] }, { history: true }).status).toBe('noop')
    expect(useStore.getState().connectors[0]).toEqual(c)
    expect(useStore.getState().past).toHaveLength(0)
  })

  for (const [name, edit] of [
    ['position', () => setConnectorPose('c', { position: [50, 150, 40] })],
    ['angles', () => setConnectorAngles('c', [0, 30, 0])],
    ['nudge', () => nudgeSelected([50, 0, 0])],
    ['rotation', () => rotateSelected('z', 90)],
  ] as const) {
    it(`${name} detaches a generated connector and undo restores its original binding`, () => {
      const p = host(), c = bound(p)
      load([c], [p])
      expect(edit()).toBe(true)
      const moved = useStore.getState().connectors[0]
      expect(moved.supportBinding).toBeUndefined()
      expect(useStore.getState().past).toHaveLength(1)
      useStore.getState().undo()
      expect(useStore.getState().connectors[0]).toEqual(c)
      useStore.getState().redo()
      useStore.getState().selectItems(['p'])
      expect(nudgeSelected([100, 0, 0])).toBe(true)
      expect(useStore.getState().connectors[0]).toEqual(moved)
    })
  }

  it('preserves bindings for a group that includes the connector host', () => {
    const p = host(), c = bound(p)
    load([c], [p])
    useStore.getState().selectItems(['p', 'c'])
    expect(nudgeSelected([100, 0, 0])).toBe(true)
    expect(rotateSelected('y', 90)).toBe(true)
    const state = useStore.getState()
    expect(state.connectors[0].supportBinding).toEqual(c.supportBinding)
    expect(state.connectors[0]).toEqual(deriveSupport(state.connectors[0], state.profiles[0]))
    state.undo()
    useStore.getState().undo()
    expect(useStore.getState().connectors[0]).toEqual(c)
  })

  it('detaches when the selected host is locked and cannot follow the connector', () => {
    const p = { ...host(), locked: true }, c = bound(p)
    load([c], [p])
    useStore.getState().selectItems(['p', 'c'])
    expect(nudgeSelected([100, 0, 0])).toBe(true)
    expect(useStore.getState().profiles[0]).toEqual(p)
    expect(useStore.getState().connectors[0].supportBinding).toBeUndefined()
  })

  it('lifts a connector at the rotation pivot together with a member resting on the floor', () => {
    const p = { ...buildProfile(V(-100, 10, 0), V(100, 10, 0), '2020')!, id: 'p' }
    const c: ConnectorData = { ...connector(), position: [0, 10, 0] }
    load([c], [p])
    useStore.getState().selectItems(['p', 'c'])
    expect(rotateSelected('z', 90)).toBe(true)
    expect(useStore.getState().connectors[0].position[1]).toBeCloseTo(100)
    expect(useStore.getState().past).toHaveLength(1)
    useStore.getState().undo()
    expect(useStore.getState().connectors[0]).toEqual(c)
  })

  it('treats a drag and its exact distance correction as one reversible edit', () => {
    const p = host(), c = bound(p)
    load([c], [p])
    const store = useStore.getState()
    store.snapshotHistory()
    useToolStore.getState().startDrag({ id: c.id, hit: new THREE.Vector3(...c.position), origin: new THREE.Vector3(...c.position),
      groupOrigins: { [c.id]: c.position }, plane: new THREE.Plane(V(0, 1, 0), -c.position[1]), vertical: false, axis: 'x' })
    useToolStore.getState().markDragMoved()
    expect(store.updateParts({ connectors: [{ id: c.id,
      updates: connectorTransformUpdates(c, { position: [c.position[0] + 50, c.position[1], c.position[2]] }) }] }).status).toBe('applied')
    expect(commitExactMove(75)).toBe(true)
    expect(useStore.getState().connectors[0].position).toEqual([c.position[0] + 75, c.position[1], c.position[2]])
    expect(useStore.getState().past).toHaveLength(1)
    store.undo()
    expect(useStore.getState().connectors[0]).toEqual(c)
  })
})

describe('mirroring installed connectors', () => {
  for (const axis of ['x', 'y', 'z'] as const) {
    it(`preserves a gusset's solid and mounting faces across ${axis.toUpperCase()}`, () => {
      const profiles = [
        { ...buildProfile(V(0, 20, 0), V(600, 20, 0), '4040')!, id: 'rail' },
        { ...buildProfile(V(0, 0, 0), V(0, 800, 0), '4040')!, id: 'post' },
      ]
      const c: ConnectorData = { id: 'c', type: 'gusset', ...seatFor('gusset', profiles[0], profiles[1], V(0, 20, 0))! }
      load([c], profiles)
      useStore.getState().selectItems(['rail', 'post', 'c'])
      expect(auditBrackets(profiles, [c])).toEqual([])
      expect(mirrorSelected(axis)).toBe(true)
      const state = useStore.getState(), copy = state.connectors[1]
      expect(auditBrackets(state.profiles.slice(2), [copy])).toEqual([])
      const triangles = (part: ConnectorData) => connectorMeshes(part.type, part.series).filter((mesh) => !mesh.visualOnly).flatMap((mesh) => {
        const attr = mesh.geometry.getAttribute('position'), index = mesh.geometry.getIndex()
        const result: THREE.Triangle[] = []
        for (let i = 0; i < (index?.count ?? attr.count); i += 3) {
          const points = [0, 1, 2].map((j) => V(0, 0, 0).fromBufferAttribute(attr, index ? index.getX(i + j) : i + j)
            .applyQuaternion(new THREE.Quaternion(...part.quaternion)))
          result.push(new THREE.Triangle(...points as [THREE.Vector3, THREE.Vector3, THREE.Vector3]))
        }
        return result
      })
      const actual = triangles(copy), closest = new THREE.Vector3()
      const vertices = new Map<string, THREE.Vector3>()
      for (const triangle of triangles(c)) for (const point of [triangle.a, triangle.b, triangle.c]) vertices.set(point.toArray().join(), point)
      // Different triangulations of a circular hole need not share vertices; compare surfaces.
      for (const point of vertices.values()) {
        point[axis] *= -1
        expect(Math.min(...actual.map((triangle) => triangle.closestPointToPoint(point, closest).distanceTo(point)))).toBeLessThan(.025)
      }
    })

    it(`refits a handed three-way connector to the reflected supports across ${axis.toUpperCase()}`, () => {
      const profiles = [
        { ...buildProfile(V(-300, 100, 0), V(-20, 100, 0), '4040')!, id: 'rail' },
        { ...buildProfile(V(0, -200, 0), V(0, 80, 0), '4040')!, id: 'post' },
        { ...buildProfile(V(0, 100, -300), V(0, 100, -20), '4040')!, id: 'cross' },
      ]
      const candidate = connectorPlacementCandidates('corner-3way', V(0, 100, 0), profiles, []).find((s) => s.allowed)!
      expect(candidate).toBeDefined()
      const c: ConnectorData = { id: 'c', type: 'corner-3way', ...candidate.seat }
      const reference = { ...buildProfile(V(3000, 3000, 3000), V(3000, 3100, 3000), '2020')!, id: 'reference' }
      // The unused reference puts the mirror plane outside this assembly on every axis.
      load([c], [...profiles, reference])
      useStore.getState().selectItems(['rail', 'post', 'cross', 'c'])
      expect(auditBrackets(profiles, [c])).toEqual([])
      expect(mirrorSelected(axis)).toBe(true)
      const state = useStore.getState()
      expect(auditBrackets(state.profiles.slice(4), state.connectors.slice(1))).toEqual([])
      expect(state.past).toHaveLength(1)
      state.undo()
      expect(useStore.getState().connectors).toEqual([c])
    })
  }

  it('rejects a three-way mirror without destination supports without creating history', () => {
    const c = { ...connector(), type: 'corner-3way' }
    load([c])
    expect(mirrorSelected('x')).toBe(false)
    expect(useStore.getState().connectors).toEqual([c])
    expect(useStore.getState().past).toHaveLength(0)
  })
})

describe('reinstalling a connector', () => {
  function setup() {
    const profiles = [
      { ...buildProfile(V(0, 100, 0), V(600, 100, 0), '2040')!, id: 'rail', quaternion: [.5, .5, .5, .5] as [number, number, number, number] },
      { ...buildProfile(V(0, 100, 0), V(0, 600, 0), '2040')!, id: 'post' },
    ]
    const anchor: ConnectorData['position'] = [0, 100, 0]
    const candidates = connectorPlacementCandidates('inside-corner', new THREE.Vector3(...anchor), profiles, []).filter((candidate) => candidate.allowed)
    expect(candidates.length).toBeGreaterThanOrEqual(2)
    const c: ConnectorData = { id: 'c', type: 'inside-corner', ...candidates[0].seat }
    load([c], profiles)
    return { c, anchor, target: candidates[1], profiles }
  }

  it('offers the current seat and can change mounting face in one undo step', () => {
    const { c, anchor, target, profiles } = setup()
    const seats = connectorPlacementCandidates('inside-corner', new THREE.Vector3(...anchor), profiles, [c], undefined, undefined, { excludeConnectorId: c.id })
    expect(seats.filter((seat) => seat.allowed).length).toBeGreaterThanOrEqual(2)
    expect(reseatConnector(c.id, target.key, anchor)).toBe(true)
    expect(useStore.getState().connectors[0].position).toEqual(target.seat.position)
    expect(useStore.getState().connectors[0].quaternion).toEqual(target.seat.quaternion)
    expect(useStore.getState().past).toHaveLength(1)
    useStore.getState().undo()
    expect(useStore.getState().connectors[0]).toEqual(c)
  })

  it('rechecks occupied or stale choices and respects locking', () => {
    const { c, anchor, target, profiles } = setup()
    load([c, { id: 'other', type: c.type, ...target.seat }], profiles)
    expect(reseatConnector(c.id, target.key, anchor)).toBe(false)
    expect(reseatConnector(c.id, 'unknown', anchor)).toBe(false)
    expect(useStore.getState().past).toHaveLength(0)
    load([{ ...c, locked: true }], profiles)
    expect(reseatConnector(c.id, target.key, anchor)).toBe(false)
    expect(useStore.getState().past).toHaveLength(0)
  })
})
