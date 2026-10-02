import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore, type EquipmentData, type ProfileData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { arraySelected, duplicateSelected, liveParts, mirrorSelected, nudgeSelected, rotateSelected, selectAll } from '../utils/editOps'
import { equipmentBody, equipmentClearance } from '../utils/equipmentGeometry'
import { obbCorners } from '../utils/obb'
import { equipment, noClearance } from './fixtures/equipment'

const profile = (): ProfileData => ({ id: 'beam', spec: '2020', length: 600, position: [1000, 200, 0],
  quaternion: [0, 0, 0, 1], miterCuts: [], holes: [], fixedTrims: { start: 0, end: 0 } })
const load = (devices: EquipmentData[] = [equipment()]) => {
  useStore.setState({ equipment: devices, past: [], future: [], selectedIds: devices.map((e) => e.id) })
  return useStore.getState()
}

beforeEach(() => {
  useStore.setState({ profiles: [], connectors: [], panels: [], fittings: [], equipment: [], throughRule: 'rails',
    past: [], future: [], selectedIds: [] })
  useToolStore.getState().stopDrag()
  useToolStore.getState().stopResize()
  useToolStore.getState().setPivotMode('center')
})

describe('equipment transactions', () => {
  it('adds and selects a device with one undo entry', () => {
    const oven = equipment()
    expect(useStore.getState().addEquipment(oven)).toMatchObject({ status: 'applied', changedIds: ['oven'] })
    const state = useStore.getState()
    expect(state.equipment).toEqual([oven])
    expect(state.selectedIds).toEqual(['oven'])
    expect(state.past).toHaveLength(1)
    state.undo()
    expect(useStore.getState().equipment).toEqual([])
    expect(useStore.getState().selectedIds).toEqual([])
    useStore.getState().redo()
    expect(useStore.getState().equipment).toEqual([oven])
  })

  it('edits name, dimensions, pose and each installation clearance in one transaction', () => {
    const before = load(), next = equipment('oven', { name: 'Refrigerator', width: 650, height: 1800, depth: 660,
      position: [100, 900, 50], quaternion: [0, 0, 0, 1], clearance: { left: 20, right: 30, top: 40, bottom: 5, front: 900, back: 60 } })
    expect(before.updateEquipment('oven', next).status).toBe('applied')
    expect(useStore.getState().equipment).toEqual([next])
    expect(useStore.getState().past).toHaveLength(1)
    useStore.getState().undo()
    expect(useStore.getState().equipment).toEqual(before.equipment)
    useStore.getState().redo()
    expect(useStore.getState().equipment).toEqual([next])
  })

  it.each([
    { width: 0 }, { height: -1 }, { depth: Infinity }, { name: '' }, { position: [0, NaN, 0] },
    { quaternion: [0, 0, 0, 0] }, { clearance: { ...noClearance(), front: -1 } },
    { clearance: { left: 1 } }, { width: 1e308, clearance: { ...noClearance(), left: 1e308 } },
  ])('rejects invalid equipment at add, update, live and document commit (%j)', (patch) => {
    const before = load(), bad = { ...equipment('bad'), ...patch }
    expect(before.addEquipment(bad as EquipmentData)).toMatchObject({ status: 'rejected', reason: 'invalid-equipment' })
    expect(before.updateEquipment('oven', patch as Partial<EquipmentData>).status).toBe('rejected')
    expect(liveParts(['oven'], patch, true)).toBe(false)
    expect(before.commitDocument({ equipment: [bad as EquipmentData] }).status).toBe('rejected')
    expect(useStore.getState()).toBe(before)
  })

  it('rejects duplicate IDs within devices and across model kinds', () => {
    const before = load()
    expect(before.addEquipment(equipment()).status).toBe('rejected')
    expect(before.commitDocument({ profiles: [profile()], equipment: [equipment('beam')] }).status).toBe('rejected')
    expect(useStore.getState()).toBe(before)
  })

  it('rejects all changes in a mixed batch when a device is invalid', () => {
    load()
    useStore.setState({ profiles: [profile()] })
    const before = useStore.getState()
    expect(before.updateParts({ profiles: [{ id: 'beam', updates: { length: 800 } }],
      equipment: [{ id: 'oven', updates: { width: 0 } }] }, { history: true }).status).toBe('rejected')
    expect(useStore.getState()).toBe(before)
  })

  it('preserves live dimension precision and retains one snapshot through later rejection', () => {
    const before = load()
    expect(liveParts(['oven'], { width: 0 }, true)).toBe(false)
    expect(useStore.getState()).toBe(before)
    expect(liveParts(['oven'], { width: 0.04 }, true)).toBe(true)
    const accepted = useStore.getState()
    expect(accepted.equipment[0].width).toBe(0.04)
    expect(liveParts(['oven'], { height: 0 }, false)).toBe(false)
    expect(useStore.getState()).toBe(accepted)
    expect(accepted.past).toHaveLength(1)
    accepted.undo()
    expect(useStore.getState().equipment).toEqual(before.equipment)
  })

  it('skips locked devices during edits and removal, and supports undoing the lock itself', () => {
    load()
    expect(useStore.getState().toggleLockSelected().status).toBe('applied')
    const locked = useStore.getState()
    expect(locked.equipment[0].locked).toBe(true)
    expect(locked.updateEquipment('oven', { width: 700 }).status).toBe('noop')
    expect(liveParts(['oven'], { width: 700 }, true)).toBe(false)
    expect(nudgeSelected([10, 0, 0])).toBe(false)
    expect(rotateSelected('y', 90)).toBe(false)
    expect(locked.removeSelected().status).toBe('noop')
    expect(useStore.getState()).toBe(locked)
    locked.undo()
    expect(useStore.getState().equipment[0].locked).toBeUndefined()
    expect(useStore.getState().selectedIds).toEqual(['oven'])
  })

  it('removes selected unlocked equipment and clears remaining equipment with undo', () => {
    const before = load([equipment('oven'), equipment('fixed', { locked: true, position: [1500, 420, 0] })])
    expect(selectAll()).toBe(true)
    expect(useStore.getState().removeSelected().status).toBe('applied')
    expect(useStore.getState().equipment.map((e) => e.id)).toEqual(['fixed'])
    expect(useStore.getState().selectedIds).toEqual(['fixed'])
    expect(useStore.getState().clearAll().status).toBe('applied')
    expect(useStore.getState().equipment).toEqual([])
    useStore.getState().undo()
    expect(useStore.getState().equipment.map((e) => e.id)).toEqual(['fixed'])
    useStore.getState().undo()
    expect(useStore.getState().equipment).toEqual(before.equipment)
  })
})

describe('equipment geometry operations', () => {
  it('moves the whole selection and clamps its body to the floor, excluding clearance', () => {
    load([equipment('oven', { position: [0, 300, 0], quaternion: [0, 0, 0, 1], height: 400,
      clearance: { ...noClearance(), bottom: 100 } })])
    useStore.setState({ profiles: [profile()], selectedIds: ['oven', 'beam'] })
    expect(nudgeSelected([25, -500, -10])).toBe(true)
    const state = useStore.getState()
    expect(state.equipment[0].position).toEqual([25, 200, -10])
    expect(state.profiles[0].position).toEqual([1025, 100, -10])
    expect(Math.min(...obbCorners(equipmentBody(state.equipment[0])).map((p) => p.y))).toBeCloseTo(0)
    expect(state.past).toHaveLength(1)
  })

  it('rotates an equipment-only selection about its body centre and lifts it above the floor', () => {
    const before = load([equipment('oven', { position: [50, 100, -30], quaternion: [0, 0, 0, 1],
      width: 100, height: 200, depth: 400 })])
    expect(rotateSelected('x', 90)).toBe(true)
    const state = useStore.getState(), after = state.equipment[0]
    expect(after.position).toEqual([50, 200, -30])
    expect(new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(...after.quaternion)).y).toBeCloseTo(-1)
    expect(Math.min(...obbCorners(equipmentBody(after)).map((p) => p.y))).toBeCloseTo(0)
    state.undo()
    expect(useStore.getState().equipment).toEqual(before.equipment)
  })

  it('copies a locked reference as an independent unlocked device with a new ID', () => {
    const before = load([equipment('oven', { locked: true })])
    expect(duplicateSelected()).toBe(true)
    const state = useStore.getState(), copied = state.equipment[1]
    expect(copied.id).not.toBe('oven')
    expect(copied.locked).toBe(false)
    expect(copied.position).toEqual([200, 420, -280])
    expect(copied.clearance).toEqual(before.equipment[0].clearance)
    expect(copied.clearance).not.toBe(before.equipment[0].clearance)
    expect(state.selectedIds).toEqual([copied.id])
    expect(state.past).toHaveLength(1)
    state.undo()
    expect(useStore.getState().equipment).toEqual(before.equipment)
  })

  it('arrays devices with unique IDs and independent clearance objects in a single undo step', () => {
    load()
    expect(arraySelected('x', 2, 700)).toBe(true)
    const state = useStore.getState()
    expect(state.equipment.map((e) => e.position)).toEqual([[150, 420, -280], [850, 420, -280], [1550, 420, -280]])
    expect(new Set(state.equipment.map((e) => e.id)).size).toBe(3)
    expect(state.selectedIds).toEqual(state.equipment.slice(1).map((e) => e.id))
    expect(state.equipment[1].clearance).not.toBe(state.equipment[0].clearance)
    expect(state.equipment[2].clearance).not.toBe(state.equipment[1].clearance)
    expect(state.past).toHaveLength(1)
  })

  it.each(['x', 'y', 'z'] as const)('mirrors the physical installation envelope across world %s', (axis) => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.6, -0.2))
    const source = equipment('oven', { position: [100, 1000, -300], quaternion: q.toArray() as EquipmentData['quaternion'] })
    load([source])
    expect(mirrorSelected(axis)).toBe(true)
    const copied = useStore.getState().equipment[1], k = { x: 0, y: 1, z: 2 }[axis]
    expect(copied.position).toEqual(source.position)
    expect(copied.clearance).toEqual({ ...source.clearance, left: source.clearance.right, right: source.clearance.left })
    const expected = obbCorners(equipmentClearance(source)).map((corner) => {
      corner.setComponent(k, 2 * source.position[k] - corner.getComponent(k))
      return corner
    })
    for (const point of obbCorners(equipmentClearance(copied)))
      expect(Math.min(...expected.map((other) => other.distanceTo(point)))).toBeLessThan(1e-6)
    expect(useStore.getState().past).toHaveLength(1)
  })
})
