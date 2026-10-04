import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore, type EquipmentData, type FittingData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { autoConnect } from '../utils/autoConnect'
import { addDrawerSupports } from '../utils/drawerSupports'
import { buildProfile } from '../utils/profileFactory'
import { connectorOBB } from '../utils/analysis'
import { findEquipmentConflicts } from '../utils/equipmentChecks'
import { noClearance } from './fixtures/equipment'

const V = (x: number, y: number, z = 0) => new THREE.Vector3(x, y, z)
const equipment = (extra: Partial<EquipmentData>): EquipmentData => ({
  id: 'equipment', name: 'Equipment', width: 20, height: 100, depth: 100,
  position: [0, 50, 0], quaternion: [0, 0, 0, 1], clearance: noClearance(), ...extra,
})
const drawer: FittingData = { id: 'drawer', kind: 'drawer', width: 600, height: 240, depth: 500,
  frame: 20, material: 'ply', open: 0, position: [0, 200, 0], quaternion: [0, 0, 0, 1] }

beforeEach(() => {
  useToolStore.setState({ viewMode: false })
  useStore.getState().loadDocument({ profiles: [], connectors: [], panels: [], fittings: [], equipment: [], throughRule: 'rails' })
})

describe('automatic drawer supports around equipment', () => {
  it.each(['body', 'clearance'] as const)('rejects an obstructed %s without adding either support or history', (kind) => {
    const profiles = [-310, 310].flatMap((x) => [-260, 260].map((z) => buildProfile(V(x, 0, z), V(x, 600, z), '2020')!))
    const blocker = kind === 'body' ? equipment({ position: [-310, 187, 0] })
      : equipment({ position: [-360, 187, 0], clearance: { ...noClearance(), right: 60 } })
    useStore.getState().loadDocument({ profiles, connectors: [], panels: [], fittings: [drawer], equipment: [blocker] })
    const before = useStore.getState()
    expect(addDrawerSupports(['drawer'])).toEqual({ generated: [], failed: [{ fittingId: 'drawer', side: 'left', reason: 'collision' }] })
    expect(useStore.getState()).toBe(before)
  })
})

describe('automatic connectors around equipment', () => {
  it.each(['body', 'clearance'] as const)('leaves an obstructed %s cap off and installs the unobstructed cap', (kind) => {
    const profiles = [buildProfile(V(0, 0), V(0, 500), '2020')!]
    const blocker = kind === 'body' ? equipment({ position: [0, 500, 0] })
      : equipment({ position: [40, 500, 0], clearance: { ...noClearance(), left: 40 } })
    useStore.getState().loadDocument({ profiles, connectors: [], panels: [], fittings: [], equipment: [blocker] })
    expect(autoConnect('end-cap')).toMatchObject({ placed: 1, blocked: 1 })
    const after = useStore.getState()
    expect(after.connectors[0].position[1]).toBe(0)
    expect(findEquipmentConflicts(after.equipment, after.connectors.map((c) => ({ id: c.id, obb: connectorOBB(c) })))).toEqual([])
    const history = after.past.length
    expect(autoConnect('end-cap')).toMatchObject({ placed: 0, blocked: 1 })
    expect(useStore.getState().past).toHaveLength(history)
    useStore.getState().undo()
    expect(useStore.getState().connectors).toEqual([])
  })

  it('does not create history when all free ends are obstructed', () => {
    const profiles = [buildProfile(V(0, 0), V(0, 500), '2020')!]
    const blocker = equipment({ width: 100, height: 600, position: [0, 250, 0] })
    useStore.getState().loadDocument({ profiles, connectors: [], panels: [], fittings: [], equipment: [blocker] })
    const before = useStore.getState()
    expect(autoConnect('end-cap')).toMatchObject({ placed: 0, blocked: 2 })
    expect(useStore.getState()).toBe(before)
  })

  it('chooses another legal bracket seat when equipment blocks the first', () => {
    const profiles = [buildProfile(V(0, 0), V(0, 700), '2020')!, buildProfile(V(0, 300), V(300, 300), '2020')!]
    useStore.getState().loadDocument({ profiles, connectors: [], panels: [], fittings: [], equipment: [] })
    expect(autoConnect('bracket').placed).toBe(2)
    const original = useStore.getState().connectors[0]
    const center = V(15, 2, 0).applyQuaternion(new THREE.Quaternion(...original.quaternion))
      .add(new THREE.Vector3(...original.position)).toArray() as [number, number, number]
    const blocker = equipment({ width: 8, height: 8, depth: 8, position: center })
    useStore.getState().loadDocument({ profiles, connectors: [], panels: [], fittings: [], equipment: [blocker] })
    expect(autoConnect('bracket').placed).toBe(1)
    const after = useStore.getState()
    expect(findEquipmentConflicts([blocker], after.connectors.map((c) => ({ id: c.id, obb: connectorOBB(c) })))).toEqual([])
    expect(after.connectors[0].position).not.toEqual(original.position)
  })
})
