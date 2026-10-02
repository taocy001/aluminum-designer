import type { PersistStorage, StorageValue } from 'zustand/middleware'
import type { ProjectDocument } from './document'
import { parseProjectDocument } from './document'

interface StorageLike { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void; removeItem: (key: string) => void }
export type AutoSaveState = 'idle' | 'pending' | 'saved' | 'error' | 'unavailable'
interface ProjectStorage extends PersistStorage<ProjectDocument> {
  flush: () => void
  getStatus: () => AutoSaveState
  subscribe: (listener: () => void) => () => void
}
type Save = { name: string; value: StorageValue<ProjectDocument> }
const sameSave = (a: Save | null, b: Save) => a !== null && a.name === b.name && a.value.version === b.value.version
  && a.value.state.profiles === b.value.state.profiles && a.value.state.connectors === b.value.state.connectors
  && a.value.state.panels === b.value.state.panels && a.value.state.fittings === b.value.state.fittings
  && a.value.state.equipment === b.value.state.equipment
  && a.value.state.throughRule === b.value.state.throughRule
let rejectedProject: string | null = null
export const rejectedLocalProject = () => rejectedProject
export const clearRejectedLocalProject = () => { rejectedProject = null }

/** Coalesce live edits; selection/history-only changes never serialize the drawing. */
export function projectStorage(getStorage: () => StorageLike | null): ProjectStorage {
  let saved: Save | null = null
  let pending: Save | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let status: AutoSaveState = 'idle'
  const listeners = new Set<() => void>()
  const report = (next: AutoSaveState) => {
    if (status === next) return
    status = next
    listeners.forEach((listener) => listener())
  }
  const storageOrNull = () => {
    try { return getStorage() } catch { return null }
  }
  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (!pending) return
    const next = pending
    const storage = storageOrNull()
    if (!storage) { report('unavailable'); return }
    try {
      storage.setItem(next.name, JSON.stringify(next.value))
      saved = next
      pending = null
      report('saved')
    } catch {
      // Retain the latest edit for an explicit retry or the next edit/lifecycle flush.
      // No timer is scheduled here: a storage failure must not start a retry loop.
      report('error')
    }
  }
  return {
    flush,
    getStatus: () => status,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    getItem: (name) => {
      const storage = storageOrNull()
      if (!storage) { report('unavailable'); return null }
      let raw: string | null = null
      try {
        rejectedProject = storage.getItem(`${name}:recovery`)
        raw = storage.getItem(name)
      } catch {
        report('unavailable')
        return null
      }
      if (!raw) { report('idle'); return null }
      try {
        const value = JSON.parse(raw) as StorageValue<unknown>
        const state = parseProjectDocument(value.state)
        saved = { name, value: { state, version: value.version } }
        report('saved')
        return { state, version: value.version }
      } catch {
        // Keep a separate recovery copy across later edits and page reloads. Never replace
        // the first rejected document until the user explicitly dismisses recovery.
        rejectedProject ??= raw
        if (rejectedProject !== null) {
          try { storage.setItem(`${name}:recovery`, rejectedProject) } catch { /* still available for download this session */ }
        }
        report('idle')
        return null
      }
    },
    setItem: (name, value) => {
      const next = { name, value }
      if (sameSave(saved, next)) {
        if (timer) clearTimeout(timer)
        timer = undefined
        pending = null
        report('saved')
        return
      }
      // Selection/history changes must neither duplicate writes nor postpone a pending save.
      if (sameSave(pending, next) && timer !== undefined) return
      pending = next
      if (timer) clearTimeout(timer)
      // Keep a failure visible while retrying, until a write actually succeeds.
      if (status !== 'error' && status !== 'unavailable') report('pending')
      timer = setTimeout(flush, 180)
    },
    removeItem: (name) => {
      if (timer) clearTimeout(timer)
      timer = undefined
      pending = null
      saved = null
      const storage = storageOrNull()
      if (!storage) { report('unavailable'); return }
      try {
        storage.removeItem(name)
        storage.removeItem(`${name}:recovery`)
        report('idle')
      } catch { report('unavailable') }
    },
  }
}

export const documentStorage = projectStorage(() => typeof localStorage === 'undefined' ? null : localStorage)
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => documentStorage.flush())
  window.addEventListener('beforeunload', () => documentStorage.flush())
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') documentStorage.flush() })
}
