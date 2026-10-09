import { useMemo, useSyncExternalStore } from 'react'
import { useStore } from './useStore'
import { useToolStore } from './useToolStore'

const transforming = () => {
  const tool = useToolStore.getState()
  return tool.isDragging || !!tool.resize || !!tool.rotationGesture
}

/** Inspectors refresh on gesture completion; the viewport reads the live document. */
export function useSettledDocument() {
  const source = useMemo(() => {
    let snapshot = useStore.getState()
    return {
      getSnapshot: () => {
        if (!transforming()) snapshot = useStore.getState()
        return snapshot
      },
      subscribe: (notify: () => void) => {
        const document = useStore.subscribe(() => { if (!transforming()) notify() })
        let active = transforming()
        const tools = useToolStore.subscribe(() => {
          const next = transforming()
          if (next !== active) { active = next; notify() }
        })
        return () => { document(); tools() }
      },
    }
  }, [])
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
}
