import { create } from 'zustand'
import * as THREE from 'three'
import { ProfileSpec } from './useStore'

export type PlacementMode = 'profile' | 'connector'
export type ViewMode = 'draw' | 'navigate'
export type Language = 'en' | 'zh'

interface ToolState {
  placementMode: PlacementMode
  viewMode: ViewMode
  isDrawing: boolean
  startPoint: THREE.Vector3 | null
  currentPoint: THREE.Vector3 | null
  snapPoint: THREE.Vector3 | null
  activeSpec: ProfileSpec
  activeConnectorType: string | null
  language: Language
  cameraResetTrigger: number
  setPlacementMode: (mode: PlacementMode) => void
  setViewMode: (mode: ViewMode) => void
  setDrawing: (isDrawing: boolean) => void
  setPoints: (start: THREE.Vector3 | null, current: THREE.Vector3 | null) => void
  setSnapPoint: (snap: THREE.Vector3 | null) => void
  setActiveSpec: (spec: ProfileSpec) => void
  setActiveConnector: (type: string | null) => void
  setLanguage: (lang: Language) => void
  triggerCameraReset: () => void
}

export const useToolStore = create<ToolState>((set) => ({
  placementMode: 'profile',
  viewMode: 'navigate',
  isDrawing: false,
  startPoint: null,
  currentPoint: null,
  snapPoint: null,
  activeSpec: '2020',
  activeConnectorType: null,
  language: 'zh',
  cameraResetTrigger: 0,
  setPlacementMode: (placementMode) => set({ placementMode }),
  setViewMode: (viewMode) => set({ viewMode, isDrawing: false, startPoint: null, currentPoint: null }),
  setDrawing: (isDrawing) => set({ isDrawing }),
  setPoints: (start, current) => set({ startPoint: start, currentPoint: current }),
  setSnapPoint: (snapPoint) => set({ snapPoint }),
  setActiveSpec: (spec) => set({ activeSpec: spec, placementMode: 'profile', viewMode: 'draw' }),
  setActiveConnector: (type) => set({ activeConnectorType: type, placementMode: 'connector', viewMode: 'draw' }),
  setLanguage: (language) => set({ language }),
  triggerCameraReset: () => set((s) => ({ cameraResetTrigger: s.cameraResetTrigger + 1 })),
}))
