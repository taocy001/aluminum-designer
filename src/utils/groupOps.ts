import { useStore } from '../store/useStore'
import { cancelActiveTransformGesture } from './transformGesture'
import { nextId } from './profileFactory'
import { reportEditResult } from './editFeedback'
import { useToolStore } from '../store/useToolStore'

export function createSelectedGroup(name: string): boolean {
  const label = name.trim()
  if (useToolStore.getState().viewMode || !label || label.length > 200) return false
  cancelActiveTransformGesture()
  const state = useStore.getState()
  const live = new Set([...state.profiles, ...state.connectors, ...state.panels, ...state.fittings, ...state.equipment].map(p => p.id))
  const memberIds = [...new Set(state.selectedIds)].filter(id => live.has(id))
  if (memberIds.length < 2) return false
  return reportEditResult(state.commitDocument({ groups: [...state.groups, { id: nextId('g'), name: label, memberIds }] }))
}

export function renameGroup(id: string, name: string): boolean {
  const label = name.trim()
  if (useToolStore.getState().viewMode || !label || label.length > 200) return false
  cancelActiveTransformGesture()
  const state = useStore.getState()
  if (!state.groups.some(g => g.id === id)) return false
  return reportEditResult(state.commitDocument({ groups: state.groups.map(g => g.id === id ? { ...g, name: label } : g) }))
}

export function dissolveGroup(id: string): boolean {
  if (useToolStore.getState().viewMode) return false
  cancelActiveTransformGesture()
  const state = useStore.getState()
  if (!state.groups.some(g => g.id === id)) return false
  return reportEditResult(state.commitDocument({ groups: state.groups.filter(g => g.id !== id) }))
}
