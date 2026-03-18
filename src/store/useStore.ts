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
  position: [number, number, number]
  quaternion: [number, number, number, number]
}

interface State {
  profiles: ProfileData[]
  connectors: ConnectorData[]
  selectedId: string | null
  addProfile: (profile: ProfileData) => void
  removeProfile: (id: string) => void
  clearAll: () => void
  addConnector: (connector: ConnectorData) => void
  removeConnector: (id: string) => void
  selectProfile: (id: string | null) => void
  updateProfile: (id: string, updates: Partial<ProfileData>) => void
}

export const useStore = create<State>()(
  persist(
    (set) => ({
      profiles: [],
      connectors: [],
      selectedId: null,
      addProfile: (profile) => set((state) => ({ profiles: [...state.profiles, profile] })),
      removeProfile: (id) => set((state) => ({
        profiles: state.profiles.filter((p) => p.id !== id),
        selectedId: state.selectedId === id ? null : state.selectedId
      })),
      clearAll: () => set({ profiles: [], connectors: [], selectedId: null }),
      addConnector: (connector) => set((state) => ({ connectors: [...state.connectors, connector] })),
      removeConnector: (id) => set((state) => ({ connectors: state.connectors.filter((c) => c.id !== id) })),
      selectProfile: (id) => set({ selectedId: id }),
      updateProfile: (id, updates) => set((state) => ({
        profiles: state.profiles.map((p) => p.id === id ? { ...p, ...updates } : p)
      })),
    }),
    {
      name: 'aluminum-designer-store',
      partialize: (state) => ({ profiles: state.profiles, connectors: state.connectors }),
    }
  )
)
