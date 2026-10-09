import { afterEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore, type ProfileData } from '../store/useStore'
import { beginTransformGesture, cancelTransformGesture, finishTransformGesture, transformGestureActive } from '../utils/transformGesture'
import { rotateSelected } from '../utils/editOps'
import { useToolStore } from '../store/useToolStore'

const profile: ProfileData = { id: 'beam', spec: '2020', position: [0, 100, 0], quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2], length: 400, holes: [], miterCuts: [] }
function setup() {
  useStore.getState().loadDocument({ profiles: [profile], panels: [], connectors: [], fittings: [], equipment: [], throughRule: 'rails' })
  useStore.setState({ selectedIds: ['beam'], past: [], future: [] })
}
afterEach(() => cancelTransformGesture())

describe('cancelable transform gesture', () => {
  it('restores a full history buffer and existing redo branch without an undo/redo side effect', () => {
    setup()
    const s = useStore.getState()
    const snapshot = { profiles: s.profiles, connectors: s.connectors, panels: s.panels, fittings: s.fittings, equipment: s.equipment, throughRule: s.throughRule }
    useStore.setState({ past: Array.from({ length: 50 }, () => snapshot), future: [snapshot],
      groups: [{ id: 'group', name: 'Frame', memberIds: ['beam'] }],
      templateInstances: [{ id: 'instance', templateId: 'cabinet', parameters: { w: 400 }, profileIds: ['beam'], fingerprints: ['original'] }] })
    const before = beginTransformGesture()
    useStore.getState().updateProfile('beam', { length: 550 }, { history: true })
    useStore.getState().updateProfile('beam', { length: 650 })
    useStore.setState({ groups: [], templateInstances: [] })
    expect(useStore.getState().future).toHaveLength(0)
    cancelTransformGesture()
    const after = useStore.getState()
    expect(after.profiles).toBe(before.profiles)
    expect(after.past).toBe(before.past)
    expect(after.future).toBe(before.future)
    expect(after.selectedIds).toBe(before.selectedIds)
    expect(after.groups).toBe(before.groups)
    expect(after.templateInstances).toBe(before.templateInstances)
    expect(transformGestureActive()).toBe(false)
  })

  it('previews absolute angles from the original geometry and records one undo step', () => {
    setup()
    const source = beginTransformGesture(), pivot = new THREE.Vector3(200, 100, 0)
    expect(rotateSelected('y', 15, { source, pivot, history: true })).toBe(true)
    expect(rotateSelected('y', 60, { source, pivot, history: false })).toBe(true)
    const expected = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 3)
      .multiply(new THREE.Quaternion(...profile.quaternion))
    useStore.getState().profiles[0].quaternion.forEach((n, index) => expect(n).toBeCloseTo(expected.toArray()[index], 8))
    expect(useStore.getState().past).toHaveLength(1)
    finishTransformGesture()
    useStore.getState().undo()
    expect(useStore.getState().profiles).toEqual(source.profiles)
    useStore.getState().redo()
    expect(useStore.getState().profiles[0].quaternion).toEqual(expected.toArray())
  })

  it('cancels rotation without losing the selection', () => {
    setup()
    const source = beginTransformGesture()
    rotateSelected('y', -47.2, { source, pivot: new THREE.Vector3(200, 100, 0), history: true })
    cancelTransformGesture()
    expect(useStore.getState().profiles).toBe(source.profiles)
    expect(useStore.getState().past).toHaveLength(0)
    expect(useStore.getState().selectedIds).toEqual(['beam'])
  })

  it('cannot restore an old gesture over a replacement document', () => {
    setup()
    beginTransformGesture()
    useStore.getState().updateProfile('beam', { length: 650 }, { history: true })
    useStore.getState().loadDocument({ profiles: [{ ...profile, id: 'replacement', length: 200 }], connectors: [] })
    const replacement = useStore.getState()
    cancelTransformGesture()
    expect(useStore.getState().profiles).toBe(replacement.profiles)
    expect(useStore.getState().past).toBe(replacement.past)
    expect(transformGestureActive()).toBe(false)
  })

  it('explains why a locked part in a mixed selection stays in place', () => {
    setup()
    const locked: ProfileData = { ...profile, id: 'locked', position: [0, 500, 300], locked: true }
    useStore.setState({ profiles: [profile, locked], selectedIds: ['beam', 'locked'] })
    useToolStore.setState({ language: 'en', toasts: [] })
    rotateSelected('y', 30)
    expect(useStore.getState().profiles.find(part => part.id === 'locked')).toMatchObject(locked)
    expect(useStore.getState().profiles.find(part => part.id === 'beam')?.quaternion).not.toEqual(profile.quaternion)
    expect(useToolStore.getState().toasts.some(toast => toast.message.includes('1 locked parts stay in place'))).toBe(true)
  })
})
