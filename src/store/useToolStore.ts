import { create } from 'zustand'
import * as THREE from 'three'
import { ProfileSpec } from './useStore'

export type PlacementMode = 'profile' | 'connector'
export type Language = 'en' | 'zh'

interface ToolState {
  placementMode: PlacementMode
  isDrawing: boolean
  startPoint: THREE.Vector3 | null
  currentPoint: THREE.Vector3 | null
  activeSpec: ProfileSpec
  activeConnectorType: string | null
  language: Language
  setPlacementMode: (mode: PlacementMode) => void
  setDrawing: (isDrawing: boolean) => void
  setPoints: (start: THREE.Vector3 | null, current: THREE.Vector3 | null) => void
  setActiveSpec: (spec: ProfileSpec) => void
  setActiveConnector: (type: string | null) => void
  setLanguage: (lang: Language) => void
}

export const useToolStore = create<ToolState>((set) => ({
  placementMode: 'profile',
  isDrawing: false,
  startPoint: null,
  currentPoint: null,
  activeSpec: '2020',
  activeConnectorType: null,
  language: 'zh', // Default to Chinese
  setPlacementMode: (placementMode) => set({ placementMode }),
  setDrawing: (isDrawing) => set({ isDrawing }),
  setPoints: (start, current) => set({ startPoint: start, currentPoint: current }),
  setActiveSpec: (spec) => set({ activeSpec: spec, placementMode: 'profile' }),
  setActiveConnector: (type) => set({ activeConnectorType: type, placementMode: 'connector' }),
  setLanguage: (language) => set({ language }),
}))
