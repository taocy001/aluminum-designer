import type { PersistStorage, StorageValue } from 'zustand/middleware'
import type { ProjectDocument } from './document'
import { parseProjectDocument } from './document'

interface StorageLike { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void; removeItem: (key: string) => void }
let rejectedProject: string | null = null
export const rejectedLocalProject = () => rejectedProject
export const clearRejectedLocalProject = () => { rejectedProject = null }

/** Coalesce live edits; selection/history-only changes never serialize the drawing. */
export function projectStorage(getStorage: () => StorageLike | null): PersistStorage<ProjectDocument> & { flush: () => void } {
  let previous: ProjectDocument | undefined
  let pending: { name: string; value: StorageValue<ProjectDocument> } | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (!pending) return
    const next = pending
    pending = null
    try { getStorage()?.setItem(next.name, JSON.stringify(next.value)) } catch { /* keep the in-memory document */ }
  }
  return {
    flush,
    getItem: (name) => {
      let raw: string | null = null
      try {
        const storage = getStorage()
        rejectedProject = storage?.getItem(`${name}:recovery`) ?? null
        raw = storage?.getItem(name) ?? null
        if (!raw) return null
        const value = JSON.parse(raw) as StorageValue<unknown>
        const state = parseProjectDocument(value.state)
        previous = state
        return { state, version: value.version }
      } catch {
        // Keep a separate recovery copy across later edits and page reloads. Never replace
        // the first rejected document until the user explicitly dismisses recovery.
        rejectedProject ??= raw
        if (rejectedProject !== null) {
          try { getStorage()?.setItem(`${name}:recovery`, rejectedProject) } catch { /* still available for download this session */ }
        }
        return null
      }
    },
    setItem: (name, value) => {
      const next = value.state
      if (previous && previous.profiles === next.profiles && previous.connectors === next.connectors
        && previous.panels === next.panels && previous.fittings === next.fittings && previous.throughRule === next.throughRule) return
      previous = next
      pending = { name, value }
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, 180)
    },
    removeItem: (name) => {
      if (timer) clearTimeout(timer)
      pending = null
      previous = undefined
      try {
        const storage = getStorage()
        storage?.removeItem(name)
        storage?.removeItem(`${name}:recovery`)
      } catch { /* storage unavailable */ }
    },
  }
}

export const documentStorage = projectStorage(() => typeof localStorage === 'undefined' ? null : localStorage)
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => documentStorage.flush())
  window.addEventListener('beforeunload', () => documentStorage.flush())
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') documentStorage.flush() })
}
