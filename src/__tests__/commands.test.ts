import { beforeEach, expect, it } from 'vitest'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { commands, commandReason, keyCommand, runCommand, searchCommands } from '../utils/commands'
import { beginTransformGesture, cancelTransformGesture } from '../utils/transformGesture'

beforeEach(() => {
  cancelTransformGesture()
  useToolStore.getState().putDown()
  useToolStore.setState({ viewMode: false, language: 'en' })
  useStore.getState().loadDocument({ profiles: [{ id: 'beam', spec: '2020', length: 500,
    position: [0, 100, 0], quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2], holes: [], miterCuts: [] }],
  connectors: [], panels: [], fittings: [], equipment: [], throughRule: 'rails' })
  useStore.getState().selectItems(['beam'])
})
const reason = (id: string) => commandReason(commands.find(c => c.id === id)!)
const chord = (key: string, modifiers: Partial<Parameters<typeof keyCommand>[0]> = {}) => keyCommand({
  key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...modifiers,
})

it('distinguishes editing modifiers, redo alternatives and unrelated browser shortcuts', () => {
  expect(chord('z', { ctrlKey: true })).toBe('undo')
  expect(chord('Z', { metaKey: true, shiftKey: true })).toBe('redo')
  expect(chord('y', { ctrlKey: true })).toBe('redo')
  expect(chord('S', { metaKey: true, shiftKey: true })).toBe('save-as')
  expect(chord('c', { ctrlKey: true, shiftKey: true })).toBeUndefined()
  expect(chord('l', { altKey: true })).toBeUndefined()
  expect(chord('f', { ctrlKey: true })).toBeUndefined()
  expect(chord('F', { shiftKey: true })).toBe('fit')
})

it('rejects mutations in view mode through any command entry but allows copying', () => {
  useToolStore.getState().setViewMode(true)
  const before = useStore.getState()
  for (const id of ['delete', 'duplicate', 'paste', 'lock', 'rotate-y', 'mirror-x', 'undo', 'redo']) {
    expect(reason(id)).toContain('edit mode')
    expect(runCommand(id)).toBe(false)
  }
  expect(useStore.getState()).toBe(before)
  expect(runCommand('copy')).toBe(true)
})

it('reports missing selection and all-locked selection without changing history', () => {
  useStore.getState().clearSelection()
  expect(reason('delete')).toContain('Select parts')
  useStore.getState().selectItems(['beam'])
  expect(runCommand('lock')).toBe(true)
  const before = useStore.getState()
  expect(reason('rotate-y')).toContain('locked')
  expect(runCommand('delete')).toBe(false)
  expect(useStore.getState()).toBe(before)
  expect(reason('copy')).toBeNull()
  expect(reason('lock')).toBeNull()
})

it('prevents commands from committing a live drag and preserves undo after cancellation', () => {
  const before = useStore.getState()
  beginTransformGesture()
  for (const id of ['delete', 'lock', 'duplicate', 'rotate-y', 'view-mode', 'undo']) {
    expect(reason(id)).toContain('drag')
    expect(runCommand(id)).toBe(false)
  }
  expect(useStore.getState()).toBe(before)
  cancelTransformGesture()
  expect(runCommand('duplicate')).toBe(true)
  expect(useStore.getState().profiles).toHaveLength(2)
  expect(runCommand('undo')).toBe(true)
  expect(useStore.getState().profiles).toEqual(before.profiles)
})

it('searches both languages and checks availability again on execution', () => {
  expect(searchCommands('旋转 y').map(c => c.id)).toEqual(['rotate-y', 'rotate-y-back'])
  expect(searchCommands('copy').some(c => c.id === 'copy')).toBe(true)
  expect(searchCommands('no-such-action')).toHaveLength(0)
  expect(reason('delete')).toBeNull()
  useStore.getState().clearSelection()
  expect(runCommand('delete')).toBe(false)
  expect(useStore.getState().profiles).toHaveLength(1)
})
