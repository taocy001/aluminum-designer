import { beforeEach, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore, type PanelData, type FittingData, type ConnectorData } from '../store/useStore'
import { buildProfile } from '../utils/profileFactory'

const profile = () => buildProfile(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 800, 0), '4040', 'profile')!
const panel: PanelData = { id: 'panel', width: 400, height: 600, thickness: 18, material: 'mdf', position: [0, 400, 0], quaternion: [0, 0, 0, 1] }
const fitting: FittingData = { id: 'fitting', kind: 'door', width: 400, height: 600, depth: 400, material: 'mdf', position: [0, 400, 0], quaternion: [0, 0, 0, 1], open: 0 }
const connector: ConnectorData = { id: 'connector', type: 'bracket', series: 40, position: [0, 20, 0], quaternion: [0, 0, 0, 1] }

beforeEach(() => useStore.setState({ profiles: [profile()], panels: [panel], fittings: [fitting], connectors: [connector],
  selectedIds: [], past: [], future: [], throughRule: 'rails' }))

it('keeps the current mixed selection through undo and redo of a geometry edit', () => {
  const ids = ['profile', 'panel', 'fitting', 'connector']
  useStore.getState().selectItems(ids)
  useStore.getState().commitTransform({ profiles: [{ id: 'profile', updates: { length: 600 } }] })
  useStore.getState().undo()
  expect(useStore.getState().selectedIds).toEqual(ids)
  expect(useStore.getState().profiles[0].length).toBe(800)
  useStore.getState().redo()
  expect(useStore.getState().selectedIds).toEqual(ids)
  expect(useStore.getState().profiles[0].length).toBe(600)
})

it('filters a selected newly added part on undo while retaining the other selected parts', () => {
  const added = { ...profile(), id: 'added' }
  useStore.getState().addProfile(added)
  useStore.getState().selectItems(['profile', 'added', 'panel', 'missing'])
  useStore.getState().undo()
  expect(useStore.getState().selectedIds).toEqual(['profile', 'panel'])
  useStore.getState().redo()
  expect(useStore.getState().selectedIds).toEqual(['profile', 'panel'])
})

it('does not resurrect an old selection when the user intentionally cleared it', () => {
  useStore.getState().selectItems(['profile'])
  useStore.getState().commitTransform({ profiles: [{ id: 'profile', updates: { length: 600 } }] })
  useStore.getState().clearSelection()
  useStore.getState().undo()
  expect(useStore.getState().selectedIds).toEqual([])
  useStore.getState().redo()
  expect(useStore.getState().selectedIds).toEqual([])
})

it('drops only deleted IDs when redoing removal after the restored parts were reselected', () => {
  useStore.getState().removeProfile('profile')
  useStore.getState().undo()
  useStore.getState().selectItems(['profile', 'panel'])
  useStore.getState().redo()
  expect(useStore.getState().selectedIds).toEqual(['panel'])
})
