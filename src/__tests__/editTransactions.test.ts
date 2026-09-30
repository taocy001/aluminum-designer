import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore, type ConnectorData, type FittingData, type PanelData, type ProfileData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { arraySelected, commitExactMove, duplicateSelected, liveParts, mirrorSelected, nudgeSelected, rotateSelected, selectionLocked } from '../utils/editOps'
import { buildProfile } from '../utils/profileFactory'
import { fittingSolids } from '../utils/fittingGeometry'
import { connectorOBB, panelOBB } from '../utils/analysis'
import { obbCorners } from '../utils/obb'
import { getProfileEndpoints } from '../utils/geometryCore'
import { setThroughRule } from '../utils/jointUtils'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const profile = (): ProfileData => ({ ...buildProfile(V(0, 0, 0), V(0, 800, 0), '2040')!, id: 'p' })
const connector = (): ConnectorData => ({ id: 'c', type: 'bracket', series: 20, position: [30, 60, 40], quaternion: [0, 0, 0, 1] })
const panel = (id = 'b'): PanelData => ({ id, width: 560, height: 760, thickness: 18, material: 'mdf', position: [300, 400, 430], quaternion: [0, 0, 0, 1] })
const fitting = (): FittingData => ({ id: 'f', kind: 'door', width: 580, height: 760, depth: 380, frame: 20, position: [300, 400, 210], quaternion: [0, 0, 0, 1], material: 'mdf', open: 0.6, hinge: 'left', hingeType: 'cup', swing: 110 })
type Document = Pick<ReturnType<typeof useStore.getState>, 'profiles' | 'connectors' | 'panels' | 'fittings'>
const empty: Document = { profiles: [], connectors: [], panels: [], fittings: [] }
const mixed = (): Document => ({ profiles: [profile()], connectors: [connector()], panels: [panel()], fittings: [fitting()] })
const load = (doc: Partial<Document> = {}, ids: string[] = []) => useStore.setState({ ...empty, ...doc, selectedIds: ids, past: [], future: [] })

beforeEach(() => {
  load()
  useStore.setState({ throughRule: 'rails' })
  useToolStore.getState().stopDrag()
  useToolStore.getState().stopResize()
  useToolStore.getState().setPivotMode('center')
  setThroughRule('rails')
})

describe('copy commands preserve an entire selected assembly', () => {
  for (const [name, run, copies] of [
    ['duplicate', duplicateSelected, 1],
    ['mirror', () => mirrorSelected('x'), 1],
    ['array', () => arraySelected('x', 2, 700), 2],
  ] as const) {
    it(`${name} includes all four part kinds in one undo step and selects every copy`, () => {
      const doc = mixed()
      doc.fittings[0].locked = true
      load(doc, ['p', 'c', 'b', 'f'])
      expect(run()).toBe(true)
      const store = useStore.getState()
      for (const kind of ['profiles', 'connectors', 'panels', 'fittings'] as const) {
        expect(store[kind]).toHaveLength(1 + copies)
        expect(store[kind].slice(1).every((part) => !part.locked && store.selectedIds.includes(part.id))).toBe(true)
      }
      expect(store.selectedIds).toHaveLength(4 * copies)
      expect(store.fittings[1].frame).toBe(20)
      expect(store.fittings[1].open).toBe(0.6)
      expect(store.past).toHaveLength(1)
      store.undo()
      for (const kind of ['profiles', 'connectors', 'panels', 'fittings'] as const) expect(useStore.getState()[kind]).toEqual(doc[kind])
      useStore.getState().redo()
      expect(useStore.getState().fittings).toHaveLength(1 + copies)
      expect(useStore.getState().selectedIds).toEqual([])
    })
  }

  it('copies a door or drawer without requiring a selected frame', () => {
    for (const kind of ['door', 'drawer'] as const) {
      load({ fittings: [{ ...fitting(), kind }] }, ['f'])
      expect(duplicateSelected()).toBe(true)
      expect(useStore.getState().fittings).toHaveLength(2)
      expect(useStore.getState().selectedIds).toEqual([useStore.getState().fittings[1].id])
    }
  })
})

const reflect = (point: THREE.Vector3, axis: 'x' | 'y' | 'z', centre: THREE.Vector3) => {
  const reflected = point.clone()
  reflected[axis] = 2 * centre[axis] - reflected[axis]
  return reflected
}
function expectSamePoints(actual: THREE.Vector3[], expected: THREE.Vector3[]) {
  expect(actual).toHaveLength(expected.length)
  for (const point of expected) expect(actual.some((candidate) => point.distanceTo(candidate) < 0.002)).toBe(true)
}

describe('mirroring reflects geometry and door motion', () => {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.35, 0.6, 0.4)).toArray() as [number, number, number, number]
  for (const axis of ['x', 'y', 'z'] as const) {
    it(`keeps a rolled rectangular profile and a tilted board correct across ${axis.toUpperCase()}`, () => {
      const p: ProfileData = { ...profile(), quaternion: q, position: [100, 600, 50] }
      const { start, end } = getProfileEndpoints(p)
      const centre = start.clone().add(end).multiplyScalar(0.5)
      load({ profiles: [p] }, ['p'])
      mirrorSelected(axis)
      const copy = useStore.getState().profiles[1]
      const copyEnds = getProfileEndpoints(copy)
      expect(copyEnds.start.distanceTo(reflect(start, axis, centre))).toBeLessThan(0.002)
      expect(copyEnds.end.distanceTo(reflect(end, axis, centre))).toBeLessThan(0.002)
      const originalX = V(1, 0, 0).applyQuaternion(new THREE.Quaternion(...p.quaternion))
      const copyX = V(1, 0, 0).applyQuaternion(new THREE.Quaternion(...copy.quaternion))
      originalX[axis] *= -1
      expect(Math.abs(originalX.dot(copyX))).toBeCloseTo(1, 6)

      const b = { ...panel(), quaternion: q }
      load({ panels: [b] }, ['b'])
      mirrorSelected(axis)
      expectSamePoints(obbCorners(panelOBB(useStore.getState().panels[1])),
        obbCorners(panelOBB(b)).map((point) => reflect(point, axis, new THREE.Vector3(...b.position))))
    })

    for (const hinge of ['left', 'right', 'top', 'bottom'] as const) {
      it(`reflects an open ${hinge}-hung door across ${axis.toUpperCase()}`, () => {
        const f = { ...fitting(), hinge, quaternion: q }
        load({ fittings: [f] }, ['f'])
        mirrorSelected(axis)
        const copy = useStore.getState().fittings[1]
        expectSamePoints(fittingSolids(copy).flatMap(obbCorners),
          fittingSolids(f).flatMap(obbCorners).map((point) => reflect(point, axis, new THREE.Vector3(...f.position))))
      })
    }

    it(`reflects a bracket's arms across ${axis.toUpperCase()}`, () => {
      const c = { ...connector(), quaternion: q }
      load({ connectors: [c] }, ['c'])
      mirrorSelected(axis)
      expectSamePoints(obbCorners(connectorOBB(useStore.getState().connectors[1])),
        obbCorners(connectorOBB(c)).map((point) => reflect(point, axis, new THREE.Vector3(...c.position))))
    })
  }
})

describe('movement treats explicitly selected assemblies together', () => {
  it('keeps a connector fixed on its own but moves and rotates it with a group', () => {
    load(mixed(), ['c'])
    expect(nudgeSelected([100, 0, 0])).toBe(false)
    expect(rotateSelected('y', 90)).toBe(false)
    useStore.getState().selectItems(['p', 'c', 'b', 'f'])
    expect(nudgeSelected([100, 0, 0])).toBe(true)
    expect(useStore.getState().connectors[0].position).toEqual([130, 60, 40])
    const beforeDistance = new THREE.Vector3(...useStore.getState().connectors[0].position)
      .distanceTo(new THREE.Vector3(...useStore.getState().fittings[0].position))
    expect(rotateSelected('y', 90)).toBe(true)
    const afterDistance = new THREE.Vector3(...useStore.getState().connectors[0].position)
      .distanceTo(new THREE.Vector3(...useStore.getState().fittings[0].position))
    expect(afterDistance).toBeCloseTo(beforeDistance, 2)
  })

  for (const kind of ['panels', 'fittings'] as const) {
    it(`commits exact movement with ${kind} as the grabbed part`, () => {
      const doc = mixed(), lead = doc[kind][0]
      load(doc, [lead.id])
      useStore.getState().snapshotHistory()
      useToolStore.getState().startDrag({ id: lead.id, hit: new THREE.Vector3(...lead.position), origin: new THREE.Vector3(...lead.position),
        groupOrigins: { [lead.id]: lead.position }, plane: new THREE.Plane(V(0, 1, 0), 0), vertical: false, axis: 'x' })
      useToolStore.getState().markDragMoved()
      useStore.getState().updateParts({ [kind]: [{ id: lead.id, updates: { position: [lead.position[0] + 50, lead.position[1], lead.position[2]] } }] })
      expect(commitExactMove(100)).toBe(true)
      expect(useStore.getState()[kind][0].position).toEqual([lead.position[0] + 100, lead.position[1], lead.position[2]])
      expect(useStore.getState().past).toHaveLength(1)
      useStore.getState().undo()
      expect(useStore.getState()[kind][0].position).toEqual(lead.position)
    })
  }

  it('changes the exact distance for all four kinds without splitting the group', () => {
    const doc = mixed()
    load(doc, ['p', 'c', 'b', 'f'])
    const origins = Object.fromEntries(Object.values(doc).flat().map((part) => [part.id, part.position]))
    useStore.getState().snapshotHistory()
    useToolStore.getState().startDrag({ id: 'p', hit: V(0, 0, 0), origin: V(0, 0, 0), groupOrigins: origins,
      plane: new THREE.Plane(V(0, 1, 0), 0), vertical: false, axis: 'x' })
    useToolStore.getState().markDragMoved()
    for (const kind of ['profiles', 'connectors', 'panels', 'fittings'] as const) {
      const part = doc[kind][0]
      useStore.getState().updateParts({ [kind]: [{ id: part.id, updates: { position: [part.position[0] + 50, part.position[1], part.position[2]] } }] })
    }
    expect(commitExactMove(100)).toBe(true)
    for (const kind of ['profiles', 'connectors', 'panels', 'fittings'] as const) {
      const part = doc[kind][0]
      expect(useStore.getState()[kind][0].position).toEqual([part.position[0] + 100, part.position[1], part.position[2]])
    }
    expect(useStore.getState().past).toHaveLength(1)
  })

  it('keeps a locked target fixed even if a stale gesture included it', () => {
    const doc = mixed()
    doc.fittings[0].locked = true
    load(doc, ['p', 'f'])
    useToolStore.getState().startDrag({ id: 'p', hit: V(0, 0, 0), origin: V(0, 0, 0),
      groupOrigins: { p: doc.profiles[0].position, f: doc.fittings[0].position },
      plane: new THREE.Plane(V(0, 1, 0), 0), vertical: false, axis: 'x' })
    useToolStore.getState().markDragMoved()
    useStore.getState().updateProfile('p', { position: [50, 0, 0] })
    expect(commitExactMove(100)).toBe(true)
    expect(useStore.getState().profiles[0].position).toEqual([100, 0, 0])
    expect(useStore.getState().fittings[0].position).toEqual(doc.fittings[0].position)
  })
})

describe('live input uses the same safe rules for every target', () => {
  it('previews a batch once, skips locked parts and rejects illegal dimensions without history', () => {
    const b = panel('b'), b2 = { ...panel('b2'), locked: true }, b3 = panel('b3')
    load({ panels: [b, b2, b3], fittings: [fitting()] }, ['b', 'b2', 'b3', 'f'])
    expect(liveParts(['b', 'b2', 'b3'], { width: 10 }, true)).toBe(false)
    expect(liveParts(['f'], { depth: Infinity }, true)).toBe(false)
    expect(liveParts(['f'], { width: 59 }, true)).toBe(false)
    expect(useStore.getState().past).toHaveLength(0)
    expect(liveParts(['b', 'b2', 'b3'], { width: 620 }, true)).toBe(true)
    expect(useStore.getState().panels.map((part) => part.width)).toEqual([620, 560, 620])
    expect(liveParts(['b', 'b2', 'b3'], { width: 650 })).toBe(true)
    expect(liveParts(['b', 'b2', 'b3'], { width: 650 }, true)).toBe(false)
    expect(useStore.getState().past).toHaveLength(1)
    useStore.getState().undo()
    expect(useStore.getState().panels.map((part) => part.width)).toEqual([560, 560, 560])
  })

  it('does not preview or snapshot an edit to a locked fitting', () => {
    load({ fittings: [{ ...fitting(), locked: true }] }, ['f'])
    expect(liveParts(['f'], { width: 800 }, true)).toBe(false)
    expect(useStore.getState().fittings[0].width).toBe(580)
    expect(useStore.getState().past).toHaveLength(0)
  })

  it('rejects invalid poses and mechanisms before they can reach the renderer or exporter', () => {
    load(mixed(), ['p', 'c', 'b', 'f'])
    expect(liveParts(['p'], { length: 9 }, true)).toBe(false)
    expect(liveParts(['b'], { position: [0, NaN, 0] }, true)).toBe(false)
    expect(liveParts(['f'], { quaternion: [0, 0, 0, 0] }, true)).toBe(false)
    expect(liveParts(['f'], { swing: 270 }, true)).toBe(false)
    expect(liveParts(['c'], { series: 50 }, true)).toBe(false)
    expect(useStore.getState().past).toHaveLength(0)
  })

  it('derives lock state from every actual selected part', () => {
    const doc = mixed()
    for (const parts of Object.values(doc)) parts[0].locked = true
    expect(selectionLocked(doc, ['p', 'c', 'b', 'f'])).toBe(true)
    doc.fittings[0].locked = false
    expect(selectionLocked(doc, ['f'])).toBe(false)
    expect(selectionLocked(doc, ['b', 'f'])).toBe(false)
    expect(selectionLocked(doc, ['b'])).toBe(true)
    expect(selectionLocked(doc, [])).toBe(false)
    expect(selectionLocked(doc, ['missing'])).toBe(false)
  })
})
