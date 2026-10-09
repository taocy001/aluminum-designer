import { create } from 'zustand'
import { projectSession } from '../utils/projectSession'

export type SidebarTab = 'add' | 'objects' | 'properties' | 'inspect'
interface ViewState {
  sidebarTab: SidebarTab
  hiddenIds: string[]
  isolatedIds: string[] | null
  setSidebarTab: (tab: SidebarTab) => void
  hide: (ids: string[]) => void
  reveal: (ids: string[]) => void
  isolate: (ids: string[]) => void
  restoreAll: () => void
}

/** Visibility is a workspace aid; it never changes the saved assembly or its BOM. */
export const useViewStore = create<ViewState>((set) => ({
  sidebarTab: 'add', hiddenIds: [], isolatedIds: null,
  setSidebarTab: (sidebarTab) => set({ sidebarTab }),
  hide: (ids) => set((s) => ({ hiddenIds: [...new Set([...s.hiddenIds, ...ids])] })),
  reveal: (ids) => set((s) => ({
    hiddenIds: s.hiddenIds.filter((id) => !ids.includes(id)),
    isolatedIds: s.isolatedIds ? [...new Set([...s.isolatedIds, ...ids])] : null,
  })),
  isolate: (ids) => set({ isolatedIds: ids.length ? [...ids] : null, hiddenIds: [] }),
  restoreAll: () => set({ hiddenIds: [], isolatedIds: null }),
}))

export function isObjectVisible(id: string): boolean {
  const { hiddenIds, isolatedIds } = useViewStore.getState()
  return !hiddenIds.includes(id) && (!isolatedIds || isolatedIds.includes(id))
}

let documentId = projectSession.getState().id
projectSession.subscribe(() => {
  const next = projectSession.getState().id
  if (next !== documentId) { documentId = next; useViewStore.getState().restoreAll() }
})
