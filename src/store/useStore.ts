import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ProfileSpec = '2020' | '2040' | '3030' | '3040' | '4040'

export interface MiterCut {
  angle: number
  side: 'start' | 'end'
}

export interface Hole {
  id: string
  position: [number, number, number]
  diameter: number
}

export interface ProfileData {
  id: string
  spec: ProfileSpec
  length: number
  position: [number, number, number]
  quaternion: [number, number, number, number]
  miterCuts: MiterCut[]
  holes: Hole[]
}

export interface ConnectorData {
  id: string
  type: string
  /** extrusion series the part is made for; older files default to the 20 series */
  series?: 20 | 30 | 40
  position: [number, number, number]
  quaternion: [number, number, number, number]
}

type Snapshot = { profiles: ProfileData[]; connectors: ConnectorData[] }

const MAX_HISTORY = 50

function takeSnapshot(state: Pick<State, 'profiles' | 'connectors'>): Snapshot {
  return { profiles: [...state.profiles], connectors: [...state.connectors] }
}

interface State {
  profiles: ProfileData[]
  connectors: ConnectorData[]
  selectedIds: string[]
  past: Snapshot[]
  future: Snapshot[]

  addProfile: (profile: ProfileData) => void
  addProfiles: (profiles: ProfileData[], select?: boolean) => void
  addItems: (profiles: ProfileData[], connectors: ConnectorData[], select?: boolean) => void
  /** Replace the whole document (import) */
  loadDocument: (doc: { profiles: ProfileData[]; connectors: ConnectorData[] }) => void
  removeProfile: (id: string) => void
  removeSelected: () => void
  clearAll: () => void
  addConnector: (connector: ConnectorData) => void
  removeConnector: (id: string) => void
  selectItem: (id: string, multi?: boolean) => void
  selectItems: (ids: string[]) => void
  clearSelection: () => void
  // Live update without history (for drag)
  updateProfile: (id: string, updates: Partial<ProfileData>) => void
  updateProfiles: (updates: Array<{ id: string; updates: Partial<ProfileData> }>) => void
  // Commit to history (for sidebar edits)
  commitProfileEdit: (id: string, updates: Partial<ProfileData>) => void
  commitProfilesEdit: (updates: Array<{ id: string; updates: Partial<ProfileData> }>) => void
  /** Move/rotate profiles and connectors together as one undoable step */
  commitTransform: (args: { profiles?: Array<{ id: string; updates: Partial<ProfileData> }>; connectors?: Array<{ id: string; updates: Partial<ConnectorData> }> }) => void
  updateConnector: (id: string, updates: Partial<ConnectorData>) => void
  /** Live move of several parts at once (no history) — one store write per frame */
  updateParts: (args: { profiles?: Array<{ id: string; updates: Partial<ProfileData> }>; connectors?: Array<{ id: string; updates: Partial<ConnectorData> }> }) => void
  snapshotHistory: () => void
  undo: () => void
  redo: () => void
  // Backward compat
  selectProfile: (id: string | null) => void
}

export const useStore = create<State>()(
  persist(
    (set) => ({
      profiles: [],
      connectors: [],
      selectedIds: [],
      past: [],
      future: [],

      addProfile: (profile) => set((state) => ({
        past: [...state.past.slice(-MAX_HISTORY), takeSnapshot(state)],
        future: [],
        profiles: [...state.profiles, profile],
      })),

      addProfiles: (list, select = false) => set((state) => ({
        past: [...state.past.slice(-MAX_HISTORY), takeSnapshot(state)],
        future: [],
        profiles: [...state.profiles, ...list],
        selectedIds: select ? list.map((p) => p.id) : state.selectedIds,
      })),

      addItems: (list, conns, select = false) => set((state) => ({
        past: [...state.past.slice(-MAX_HISTORY), takeSnapshot(state)],
        future: [],
        profiles: [...state.profiles, ...list],
        connectors: [...state.connectors, ...conns],
        selectedIds: select ? [...list.map((p) => p.id), ...conns.map((c) => c.id)] : state.selectedIds,
      })),

      loadDocument: (doc) => set((state) => ({
        past: [...state.past.slice(-MAX_HISTORY), takeSnapshot(state)],
        future: [],
        profiles: doc.profiles,
        connectors: doc.connectors,
        selectedIds: [],
      })),

      removeProfile: (id) => set((state) => ({
        past: [...state.past.slice(-MAX_HISTORY), takeSnapshot(state)],
        future: [],
        profiles: state.profiles.filter((p) => p.id !== id),
        selectedIds: state.selectedIds.filter((s) => s !== id),
      })),

      removeSelected: () => set((state) => {
        const ids = new Set(state.selectedIds)
        if (ids.size === 0) return {}
        return {
          past: [...state.past.slice(-MAX_HISTORY), takeSnapshot(state)],
          future: [],
          profiles: state.profiles.filter((p) => !ids.has(p.id)),
          connectors: state.connectors.filter((c) => !ids.has(c.id)),
          selectedIds: [],
        }
      }),

      clearAll: () => set((state) => ({
        past: [...state.past.slice(-MAX_HISTORY), takeSnapshot(state)],
        future: [],
        profiles: [],
        connectors: [],
        selectedIds: [],
      })),

      addConnector: (connector) => set((state) => ({
        past: [...state.past.slice(-MAX_HISTORY), takeSnapshot(state)],
        future: [],
        connectors: [...state.connectors, connector],
      })),

      removeConnector: (id) => set((state) => ({
        past: [...state.past.slice(-MAX_HISTORY), takeSnapshot(state)],
        future: [],
        connectors: state.connectors.filter((c) => c.id !== id),
        selectedIds: state.selectedIds.filter((s) => s !== id),
      })),

      selectItem: (id, multi = false) => set((state) => {
        if (multi) {
          const idx = state.selectedIds.indexOf(id)
          return { selectedIds: idx >= 0 ? state.selectedIds.filter((s) => s !== id) : [...state.selectedIds, id] }
        }
        return { selectedIds: [id] }
      }),

      selectItems: (ids) => set({ selectedIds: ids }),
      clearSelection: () => set({ selectedIds: [] }),

      // backward compat
      selectProfile: (id) => set({ selectedIds: id ? [id] : [] }),

      updateProfile: (id, updates) => set((state) => ({
        profiles: state.profiles.map((p) => p.id === id ? { ...p, ...updates } : p),
      })),

      updateProfiles: (updates) => set((state) => {
        const map = new Map(updates.map((u) => [u.id, u.updates]))
        return {
          profiles: state.profiles.map((p) => map.has(p.id) ? { ...p, ...map.get(p.id)! } : p),
        }
      }),

      commitProfileEdit: (id, updates) => set((state) => ({
        past: [...state.past.slice(-MAX_HISTORY), takeSnapshot(state)],
        future: [],
        profiles: state.profiles.map((p) => p.id === id ? { ...p, ...updates } : p),
      })),

      commitProfilesEdit: (updates) => set((state) => {
        const map = new Map(updates.map((u) => [u.id, u.updates]))
        return {
          past: [...state.past.slice(-MAX_HISTORY), takeSnapshot(state)],
          future: [],
          profiles: state.profiles.map((p) => map.has(p.id) ? { ...p, ...map.get(p.id)! } : p),
        }
      }),

      commitTransform: ({ profiles = [], connectors = [] }) => set((state) => {
        if (profiles.length === 0 && connectors.length === 0) return {}
        const pMap = new Map(profiles.map((u) => [u.id, u.updates]))
        const cMap = new Map(connectors.map((u) => [u.id, u.updates]))
        return {
          past: [...state.past.slice(-MAX_HISTORY), takeSnapshot(state)],
          future: [],
          profiles: state.profiles.map((p) => pMap.has(p.id) ? { ...p, ...pMap.get(p.id)! } : p),
          connectors: state.connectors.map((c) => cMap.has(c.id) ? { ...c, ...cMap.get(c.id)! } : c),
        }
      }),

      updateParts: ({ profiles = [], connectors = [] }) => set((state) => {
        if (profiles.length === 0 && connectors.length === 0) return {}
        const pMap = new Map(profiles.map((u) => [u.id, u.updates]))
        const cMap = new Map(connectors.map((u) => [u.id, u.updates]))
        return {
          profiles: pMap.size ? state.profiles.map((p) => pMap.has(p.id) ? { ...p, ...pMap.get(p.id)! } : p) : state.profiles,
          connectors: cMap.size ? state.connectors.map((c) => cMap.has(c.id) ? { ...c, ...cMap.get(c.id)! } : c) : state.connectors,
        }
      }),

      updateConnector: (id, updates) => set((state) => ({
        connectors: state.connectors.map((c) => c.id === id ? { ...c, ...updates } : c),
      })),

      snapshotHistory: () => set((state) => ({
        past: [...state.past.slice(-MAX_HISTORY), takeSnapshot(state)],
        future: [],
      })),

      undo: () => set((state) => {
        if (state.past.length === 0) return {}
        const prev = state.past[state.past.length - 1]
        return {
          past: state.past.slice(0, -1),
          future: [takeSnapshot(state), ...state.future.slice(0, MAX_HISTORY - 1)],
          profiles: prev.profiles,
          connectors: prev.connectors,
          selectedIds: [],
        }
      }),

      redo: () => set((state) => {
        if (state.future.length === 0) return {}
        const next = state.future[0]
        return {
          past: [...state.past.slice(-MAX_HISTORY), takeSnapshot(state)],
          future: state.future.slice(1),
          profiles: next.profiles,
          connectors: next.connectors,
          selectedIds: [],
        }
      }),
    }),
    {
      name: 'aluminum-designer-store',
      partialize: (state) => ({ profiles: state.profiles, connectors: state.connectors }),
    }
  )
)
