import { create } from 'zustand'
import * as THREE from 'three'
import { ProfileSpec } from './useStore'
import type { Axis } from '../utils/jointUtils'

export type PlacementMode = 'profile' | 'connector'
export type ViewMode = 'draw' | 'navigate'
export type Language = 'en' | 'zh'
export type ToastKind = 'info' | 'error' | 'success'

export interface Toast { id: number; message: string; kind: ToastKind }
export interface AlignGuide { from: [number, number, number]; to: [number, number, number] }

interface ToolState {
  placementMode: PlacementMode
  viewMode: ViewMode
  activeSpec: ProfileSpec
  activeConnectorType: string | null
  language: Language
  cameraResetTrigger: number

  // Drawing
  isDrawing: boolean
  /** raw point the user clicked to start (before floor lift) */
  drawOrigin: THREE.Vector3 | null
  /** effective start (may be lifted so horizontals rest on the floor) */
  startPoint: THREE.Vector3 | null
  currentPoint: THREE.Vector3 | null
  snapPoint: THREE.Vector3 | null
  drawAxis: Axis | null
  lockedAxis: Axis | null
  alignGuides: AlignGuide[]
  /** how the current point is attached: endpoint / joint (centerline) / align / grid */
  snapKind: string | null
  /** member the cursor/end is attaching to (highlighted in the scene) */
  hoverTargetId: string | null
  /** incremented when a digit is typed while drawing → focus the exact-length input */
  preciseFocusRequest: number
  preciseSeed: string

  // Drag
  isDragging: boolean
  /** what is being dragged: a member or a connector */
  dragKind: 'profile' | 'connector'
  dragProfileId: string | null
  dragStartHit: THREE.Vector3 | null
  dragOriginPos: THREE.Vector3 | null
  dragGroupOrigins: Record<string, [number, number, number]>
  dragPlane: THREE.Plane | null
  dragVertical: boolean
  /** Shift: place freely, ignoring alignment snapping */
  dragFree: boolean
  /** members the current drag is aligning to, highlighted while it lasts */
  snapRefIds: string[]
  /** what the drag snapped to, for the alignment lines and the HUD */
  snapGuides: Array<{ axis: 0 | 1 | 2; kind: string; coord: number; refId: string }>
  dragMoved: boolean
  /** true while the dragged parts interfere with something — drives the cursor */
  dragConflict: boolean
  /** stretching a member by one of its end faces */
  resize: {
    id: string; end: 'start' | 'end'
    origin: [number, number, number]; length: number
    /** length the grabbed end would have if the pointer stayed exactly where it pressed */
    grabLength: number
    /** where the press happened, to tell a click from a stretch */
    downX: number; downY: number
  } | null

  // UI
  showDimensionLabels: boolean
  /** on-canvas rotation handles for the selection */
  showGizmo: boolean
  selectMode: boolean
  toasts: Toast[]
  /** member under the cursor in navigate mode (screen-space pick) */
  hoverProfileId: string | null
  /** end of the selected member the pointer is reaching for */
  hoverEnd: 'start' | 'end' | null

  // Frame selection
  isFrameSelecting: boolean
  frameSelectStart: { x: number; y: number } | null
  frameSelectCurrent: { x: number; y: number } | null
  frameSelectRect: { x1: number; y1: number; x2: number; y2: number } | null

  setPlacementMode: (mode: PlacementMode) => void
  setViewMode: (mode: ViewMode) => void
  setActiveSpec: (spec: ProfileSpec) => void
  setActiveConnector: (type: string | null) => void
  setLanguage: (lang: Language) => void
  triggerCameraReset: () => void

  beginDraw: (origin: THREE.Vector3) => void
  updateDraw: (patch: Partial<Pick<ToolState, 'startPoint' | 'currentPoint' | 'snapPoint' | 'drawAxis' | 'alignGuides' | 'snapKind' | 'hoverTargetId'>>) => void
  setHover: (point: THREE.Vector3 | null, snap: THREE.Vector3 | null, kind?: string | null, targetId?: string | null) => void
  cancelDraw: () => void
  setLockedAxis: (axis: Axis | null) => void
  requestPreciseFocus: (seed: string) => void

  startDrag: (args: {
    id: string; kind?: 'profile' | 'connector'; hit: THREE.Vector3; origin: THREE.Vector3;
    groupOrigins: Record<string, [number, number, number]>; plane: THREE.Plane; vertical: boolean; free?: boolean
  }) => void
  setDragFree: (free: boolean) => void
  setSnapRefs: (ids: string[]) => void
  setSnapGuides: (guides: ToolState['snapGuides']) => void
  markDragMoved: () => void
  setDragConflict: (conflict: boolean) => void
  startResize: (args: NonNullable<ToolState['resize']>) => void
  stopResize: () => void
  stopDrag: () => void
  setHoverProfile: (id: string | null) => void
  setHoverEnd: (end: 'start' | 'end' | null) => void

  toggleDimensionLabels: () => void
  toggleGizmo: () => void
  setSelectMode: (on: boolean) => void
  showToast: (message: string, kind?: ToastKind) => void
  dismissToast: (id: number) => void

  startFrameSelect: (x: number, y: number) => void
  updateFrameSelect: (x: number, y: number) => void
  endFrameSelect: (x: number, y: number) => void
  setFrameSelectRect: (rect: { x1: number; y1: number; x2: number; y2: number } | null) => void
  clearFrameSelectRect: () => void
}

let toastSeq = 1

export const useToolStore = create<ToolState>((set, get) => ({
  placementMode: 'profile',
  viewMode: 'navigate',
  activeSpec: '2020',
  activeConnectorType: null,
  language: 'zh',
  cameraResetTrigger: 0,

  isDrawing: false,
  drawOrigin: null,
  startPoint: null,
  currentPoint: null,
  snapPoint: null,
  drawAxis: null,
  lockedAxis: null,
  alignGuides: [],
  snapKind: null,
  hoverTargetId: null,
  preciseFocusRequest: 0,
  preciseSeed: '',

  isDragging: false,
  dragKind: 'profile',
  dragProfileId: null,
  dragStartHit: null,
  dragOriginPos: null,
  dragGroupOrigins: {},
  dragPlane: null,
  dragVertical: false,
  dragFree: false,
  snapRefIds: [],
  snapGuides: [],
  dragMoved: false,
  dragConflict: false,
  resize: null,

  showDimensionLabels: true,
  showGizmo: true,
  selectMode: false,
  toasts: [],
  hoverProfileId: null,
  hoverEnd: null,

  isFrameSelecting: false,
  frameSelectStart: null,
  frameSelectCurrent: null,
  frameSelectRect: null,

  setPlacementMode: (placementMode) => set({ placementMode }),
  setViewMode: (viewMode) => set({
    viewMode, isDrawing: false, drawOrigin: null, startPoint: null, currentPoint: null,
    snapPoint: null, drawAxis: null, lockedAxis: null, alignGuides: [], snapKind: null, hoverTargetId: null, selectMode: false,
  }),
  setActiveSpec: (spec) => set({ activeSpec: spec, placementMode: 'profile', viewMode: 'draw', selectMode: false }),
  setActiveConnector: (type) => set({ activeConnectorType: type, placementMode: 'connector', viewMode: 'draw', selectMode: false }),
  setLanguage: (language) => set({ language }),
  triggerCameraReset: () => set((s) => ({ cameraResetTrigger: s.cameraResetTrigger + 1 })),

  beginDraw: (origin) => set({
    isDrawing: true, drawOrigin: origin.clone(), startPoint: origin.clone(), currentPoint: origin.clone(),
    snapPoint: null, drawAxis: null, lockedAxis: null, alignGuides: [], snapKind: null,
  }),
  updateDraw: (patch) => set(patch),
  setHover: (point, snap, kind = null, targetId = null) => set({ currentPoint: point, snapPoint: snap, snapKind: kind, hoverTargetId: targetId }),
  cancelDraw: () => set({
    isDrawing: false, drawOrigin: null, startPoint: null, currentPoint: null,
    snapPoint: null, drawAxis: null, lockedAxis: null, alignGuides: [], snapKind: null, hoverTargetId: null,
  }),
  setLockedAxis: (lockedAxis) => set({ lockedAxis }),
  requestPreciseFocus: (seed) => set((s) => ({ preciseFocusRequest: s.preciseFocusRequest + 1, preciseSeed: seed })),

  startDrag: ({ id, kind = 'profile', hit, origin, groupOrigins, plane, vertical, free = false }) => set({
    isDragging: true, dragKind: kind, dragProfileId: id, dragStartHit: hit, dragOriginPos: origin,
    dragGroupOrigins: groupOrigins, dragPlane: plane, dragVertical: vertical, dragFree: free,
    dragMoved: false, dragConflict: false, snapRefIds: [], snapGuides: [],
  }),
  setDragFree: (free) => { if (get().dragFree !== free) set({ dragFree: free }) },
  setSnapRefs: (ids) => {
    const cur = get().snapRefIds
    if (cur.length !== ids.length || ids.some((id, i) => cur[i] !== id)) set({ snapRefIds: ids })
  },
  setSnapGuides: (guides) => {
    const cur = get().snapGuides
    const same = cur.length === guides.length && guides.every((g, i) =>
      cur[i].axis === g.axis && cur[i].kind === g.kind && Math.abs(cur[i].coord - g.coord) < 0.01 && cur[i].refId === g.refId)
    if (!same) set({ snapGuides: guides })
  },
  markDragMoved: () => { if (!get().dragMoved) set({ dragMoved: true }) },
  setDragConflict: (conflict) => { if (get().dragConflict !== conflict) set({ dragConflict: conflict }) },
  startResize: (resize) => set({ resize }),
  stopResize: () => set({ resize: null }),
  stopDrag: () => set({
    isDragging: false, dragKind: 'profile', dragProfileId: null, dragStartHit: null, dragOriginPos: null,
    dragGroupOrigins: {}, dragPlane: null, dragVertical: false, dragFree: false,
    dragMoved: false, dragConflict: false, snapRefIds: [], snapGuides: [],
  }),
  setHoverProfile: (id) => { if (get().hoverProfileId !== id) set({ hoverProfileId: id }) },
  setHoverEnd: (end) => { if (get().hoverEnd !== end) set({ hoverEnd: end }) },

  toggleDimensionLabels: () => set((s) => ({ showDimensionLabels: !s.showDimensionLabels })),
  toggleGizmo: () => set((s) => ({ showGizmo: !s.showGizmo })),
  setSelectMode: (on) => set({ selectMode: on }),
  showToast: (message, kind = 'info') => {
    const id = toastSeq++
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, message, kind }] }))
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 3500 : 2200)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  startFrameSelect: (x, y) => set({ isFrameSelecting: true, frameSelectStart: { x, y }, frameSelectCurrent: { x, y } }),
  updateFrameSelect: (x, y) => set({ frameSelectCurrent: { x, y } }),
  // The canvas-relative selection rect is set separately by the caller (setFrameSelectRect)
  endFrameSelect: (x, y) => set({ isFrameSelecting: false, frameSelectCurrent: { x, y } }),
  setFrameSelectRect: (rect) => set({ frameSelectRect: rect }),
  clearFrameSelectRect: () => set({ frameSelectRect: null }),
}))
