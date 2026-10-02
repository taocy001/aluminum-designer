import { beforeEach, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { createEquipment } from '../utils/equipmentOps'
import { livePart, selectionPivot } from '../utils/editOps'
import { selectedSolidTop } from '../utils/selectionBounds'
import { equipment } from './fixtures/equipment'
import { buildProfile } from '../utils/profileFactory'

beforeEach(() => {
  useStore.setState({ profiles: [], connectors: [], panels: [], fittings: [], equipment: [], throughRule: 'rails', selectedIds: [], past: [], future: [] })
  useToolStore.getState().setWorkPlaneY(0)
})

it('creates the exact entered dimensions on the work plane and selects the new equipment', () => {
  useToolStore.getState().setWorkPlaneY(123.4)
  expect(createEquipment({ name: 'Washer', width: 123.456789, height: 333.3333, depth: 51.12345, clearance: { front: 22 } }).status).toBe('applied')
  const state = useStore.getState(), e = state.equipment[0]
  expect(e).toMatchObject({ name: 'Washer', width: 123.456789, height: 333.3333, depth: 51.12345,
    position: [0, 123.4 + 333.3333 / 2, 0], quaternion: [0, 0, 0, 1], clearance: { left: 0, front: 22 } })
  expect(state.selectedIds).toEqual([e.id])
  expect(state.past).toHaveLength(1)
  state.undo()
  expect(useStore.getState().equipment).toEqual([])
  useStore.getState().redo()
  expect(useStore.getState().equipment).toEqual([e])
})

it('uses the selected assembly centre for X/Z without resizing the appliance', () => {
  const p = buildProfile(new THREE.Vector3(120, 0, 70), new THREE.Vector3(120, 500, 70), '2020', 'post')!
  useStore.setState({ profiles: [p], selectedIds: ['post'] })
  expect(createEquipment({ name: 'Oven', width: 610, height: 590, depth: 550 }).status).toBe('applied')
  expect(useStore.getState().equipment[0]).toMatchObject({ width: 610, height: 590, depth: 550 })
  useStore.getState().equipment[0].position.forEach((n, i) => expect(n).toBeCloseTo([120, 295, 70][i], 8))
})

it('rejects invalid creation without history, selection or document changes', () => {
  const before = useStore.getState()
  expect(createEquipment({ name: ' ', width: 600, height: 600, depth: 600 }).status).toBe('rejected')
  expect(createEquipment({ name: 'Oven', width: 600, height: 600, depth: 600, clearance: { front: -1 } }).status).toBe('rejected')
  expect(useStore.getState()).toBe(before)
})

it('uses the rotated body top and centre without adding clearance to the work plane', () => {
  const e = equipment('e', { position: [100, 200, 300], width: 120, height: 240, depth: 360,
    quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2).toArray() })
  const doc = { profiles: [], connectors: [], panels: [], fittings: [], equipment: [e] }
  expect(selectedSolidTop(doc, ['e'])).toBe(260)
  expect(selectionPivot([], [], 'start', [], [], [], [e]).toArray()).toEqual(e.position)
})

it('takes live history on the first successful equipment change', () => {
  const e = equipment()
  useStore.setState({ equipment: [e] })
  const before = useStore.getState()
  expect(livePart(e.id, { width: -1 }, true)).toBe(false)
  expect(useStore.getState()).toBe(before)
  expect(livePart(e.id, { width: 612.34567 }, true)).toBe(true)
  expect(livePart(e.id, { width: 620 }, false)).toBe(true)
  expect(useStore.getState().past).toHaveLength(1)
  useStore.getState().undo()
  expect(useStore.getState().equipment).toEqual([e])
})
