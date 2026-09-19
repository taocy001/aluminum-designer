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
  // Drag state
  isDragging: boolean
  dragProfileId: string | null
  dragStartHit: THREE.Vector3 | null
  dragOriginPos: THREE.Vector3 | null
  dragGroupOrigins: Record<string, [number, number, number]>
  // UI state
  showDimensionLabels: boolean
  selectMode: boolean
  // Frame selection
  isFrameSelecting: boolean
  frameSelectStart: { x: number; y: number } | null
  frameSelectCurrent: { x: number; y: number } | null
  frameSelectRect: { x1: number; y1: number; x2: number; y2: number } | null

  setPlacementMode: (mode: PlacementMode) => void
  setViewMode: (mode: ViewMode) => void
  setDrawing: (isDrawing: boolean) => void
  setPoints: (start: THREE.Vector3 | null, current: THREE.Vector3 | null) => void
  setSnapPoint: (snap: THREE.Vector3 | null) => void
  setActiveSpec: (spec: ProfileSpec) => void
  setActiveConnector: (type: string | null) => void
  setLanguage: (lang: Language) => void
  triggerCameraReset: () => void
  startDrag: (id: string, hit: THREE.Vector3, origin: THREE.Vector3, groupOrigins?: Record<string, [number, number, number]>) => void
  stopDrag: () => void
  toggleDimensionLabels: () => void
  setSelectMode: (on: boolean) => void
  startFrameSelect: (x: number, y: number) => void
  updateFrameSelect: (x: number, y: number) => void
  endFrameSelect: (x: number, y: number) => void
  setFrameSelectRect: (rect: { x1: number; y1: number; x2: number; y2: number } | null) => void
  clearFrameSelectRect: () => void
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
  isDragging: false,
  dragProfileId: null,
  dragStartHit: null,
  dragOriginPos: null,
  dragGroupOrigins: {},
  showDimensionLabels: true,
  selectMode: false,
  isFrameSelecting: false,
  frameSelectStart: null,
  frameSelectCurrent: null,
  frameSelectRect: null,

  setPlacementMode: (placementMode) => set({ placementMode }),
  setViewMode: (viewMode) => set({ viewMode, isDrawing: false, startPoint: null, currentPoint: null, selectMode: false }),
  setDrawing: (isDrawing) => set({ isDrawing }),
  setPoints: (start, current) => set({ startPoint: start, currentPoint: current }),
  setSnapPoint: (snapPoint) => set({ snapPoint }),
  setActiveSpec: (spec) => set({ activeSpec: spec, placementMode: 'profile', viewMode: 'draw', selectMode: false }),
  setActiveConnector: (type) => set({ activeConnectorType: type, placementMode: 'connector', viewMode: 'draw', selectMode: false }),
  setLanguage: (language) => set({ language }),
  triggerCameraReset: () => set((s) => ({ cameraResetTrigger: s.cameraResetTrigger + 1 })),
  startDrag: (id, hit, origin, groupOrigins = {}) => set({
    isDragging: true,
    dragProfileId: id,
    dragStartHit: hit,
    dragOriginPos: origin,
    dragGroupOrigins: groupOrigins,
  }),
  stopDrag: () => set({ isDragging: false, dragProfileId: null, dragStartHit: null, dragOriginPos: null, dragGroupOrigins: {} }),
  toggleDimensionLabels: () => set((s) => ({ showDimensionLabels: !s.showDimensionLabels })),
  setSelectMode: (on) => set({ selectMode: on }),

  startFrameSelect: (x, y) => set({
    isFrameSelecting: true,
    frameSelectStart: { x, y },
    frameSelectCurrent: { x, y },
  }),
  updateFrameSelect: (x, y) => set({ frameSelectCurrent: { x, y } }),
  endFrameSelect: (x, y) => set((s) => {
    if (!s.frameSelectStart) return { isFrameSelecting: false }
    return {
      isFrameSelecting: false,
      frameSelectCurrent: { x, y },
      frameSelectRect: {
        x1: Math.min(s.frameSelectStart.x, x),
        y1: Math.min(s.frameSelectStart.y, y),
        x2: Math.max(s.frameSelectStart.x, x),
        y2: Math.max(s.frameSelectStart.y, y),
      },
    }
  }),
  setFrameSelectRect: (rect) => set({ frameSelectRect: rect }),
  clearFrameSelectRect: () => set({ frameSelectRect: null }),
}))
