import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { projectSession } from './projectSession'

export type TransformSource = ReturnType<typeof useStore.getState>
let source: TransformSource | null = null
let sessionId: string | null = null

/** Keep the original document and both history stacks until the gesture is accepted. */
export function beginTransformGesture(): TransformSource {
  source = useStore.getState()
  sessionId = projectSession.getState().id
  return source
}

export function transformGestureActive(): boolean { return source !== null }

export function finishTransformGesture(): void { source = null; sessionId = null }

export function cancelTransformGesture(): void {
  const original = sessionId === projectSession.getState().id ? source : null
  source = null
  sessionId = null
  if (original) {
    const { profiles, connectors, panels, fittings, equipment, groups, templateInstances, throughRule, selectedIds, past, future } = original
    useStore.setState({ profiles, connectors, panels, fittings, equipment, groups, templateInstances, throughRule, selectedIds, past, future })
  }
  const tool = useToolStore.getState()
  tool.stopDrag()
  tool.stopResize()
  tool.setRotationGesture(null)
}

/** UI actions must also release any pointer routing state before editing the document. */
export function cancelActiveTransformGesture(): void {
  cancelTransformGesture()
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('aluframe:cancel-gesture'))
}

projectSession.subscribe(() => {
  if (source && sessionId !== projectSession.getState().id) {
    cancelActiveTransformGesture()
  }
})

/** Locked references stay selected; explain explicitly which parts will remain still. */
export function notifyLockedSelection(): void {
  const state = useStore.getState()
  const count = [...state.profiles, ...state.connectors, ...state.panels, ...state.fittings, ...state.equipment]
    .filter(part => part.locked && state.selectedIds.includes(part.id)).length
  if (count) useToolStore.getState().showToast(useToolStore.getState().language === 'zh'
    ? `${count} 个已锁定零件保持原位；仅变换未锁定零件`
    : `${count} locked parts stay in place; only unlocked parts will move`)
}
