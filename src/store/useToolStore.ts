import { create } from 'zustand'
import * as THREE from 'three'
import { ProfileSpec } from './useStore'
import type { Axis, ThroughRule } from '../utils/jointUtils'
import { getThroughRule, setThroughRule as applyThroughRule } from '../utils/jointUtils'
import type { PivotMode } from '../utils/editOps'

/**
 * What the pointer is carrying. There is no drawing "mode": picking a profile or a
 * connector in the sidebar puts it in your hand, and putting it down leaves you with the
 * plain canvas. The state is visible (the sidebar chip lights up, the cursor carries a
 * preview) instead of living in a toolbar toggle nobody looks at.
 */
export type HeldKind = 'profile' | 'connector'
export type Language = 'en' | 'zh'
export type ToastKind = 'info' | 'error' | 'success'

export interface Toast { id: number; message: string; kind: ToastKind }
export interface AlignGuide { from: [number, number, number]; to: [number, number, number] }

interface ToolState {
  /** the part in hand, or null for an empty hand (what used to be "navigate mode") */
  held: HeldKind | null
  activeSpec: ProfileSpec
  activeConnectorType: string | null
  language: Language
  cameraResetTrigger: number
  /** what the next camera fit should frame: everything, or just what is selected */
  cameraFitScope: 'all' | 'selection'
  /** R was pressed and is waiting for an axis key; null when no turn is pending */
  pendingRotate: null | { degrees: number }
  /** +1 closer, -1 further; the viewport consumes it and resets to 0 */
  zoomStep: number
  /** a point to pull the camera toward, consumed by the viewport */
  zoomAt: [number, number, number] | null

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
  /** every measurement on the drawing: the cut length on each member and the overall size */
  showDimensionLabels: boolean
  /** on-canvas rotation handles for the selection */
  showGizmo: boolean
  /** what the selection turns about: its centre, or one end of a single member */
  pivotMode: PivotMode
  /** at a corner, which member runs through: the rails over the posts, or the posts past the rails */
  throughRule: ThroughRule
  /**
   * Height of the plane a click falls onto when it finds nothing to attach to.
   * A pointer gives two numbers; a point in space needs three, so the missing one has to
   * come from somewhere. It used to be the floor, silently, which put members hundreds of
   * millimetres from where they were aimed. Now it is a number you can see and set.
   */
  workPlaneY: number
  /** where the Space quick menu is open, in client pixels, or null when it is closed */
  quickMenuAt: { x: number; y: number } | null
  selectMode: boolean
  toasts: Toast[]
  /** member under the cursor in navigate mode (screen-space pick) */
  hoverProfileId: string | null
  /** whatever is under the cursor, of any kind: a bracket with no highlight reads as unclickable */
  hoverPartId: string | null
  /** end of the selected member the pointer is reaching for */
  hoverEnd: 'start' | 'end' | null
  /** how many parts are stacked under the cursor, and which one Tab has stepped to */
  hoverCandidates: { count: number; index: number }
  /** gizmo handle under the cursor, for highlighting and the hint line */
  gizmoHover: { kind: 'move' | 'rotate'; axis: 'x' | 'y' | 'z' } | null
  /** axis a gizmo arrow drag is constrained to */
  dragAxis: 'x' | 'y' | 'z' | null

  // Frame selection
  isFrameSelecting: boolean
  frameSelectStart: { x: number; y: number } | null
  frameSelectCurrent: { x: number; y: number } | null
  frameSelectRect: { x1: number; y1: number; x2: number; y2: number } | null

  /** pick a profile up: it is now what a click on the canvas draws */
  setActiveSpec: (spec: ProfileSpec) => void
  /** pick a connector up, or pass null to drop it */
  setActiveConnector: (type: string | null) => void
  /** empty the hand and abandon any half-drawn line */
  putDown: () => void
  setLanguage: (lang: Language) => void
  triggerCameraReset: (scope?: 'all' | 'selection') => void
  setPendingRotate: (p: null | { degrees: number }) => void
  zoomBy: (step: number) => void
  zoomToPoint: (at: [number, number, number]) => void
  clearZoom: () => void

  beginDraw: (origin: THREE.Vector3) => void
  updateDraw: (patch: Partial<Pick<ToolState, 'startPoint' | 'currentPoint' | 'snapPoint' | 'drawAxis' | 'alignGuides' | 'snapKind' | 'hoverTargetId'>>) => void
  setHover: (point: THREE.Vector3 | null, snap: THREE.Vector3 | null, kind?: string | null, targetId?: string | null) => void
  cancelDraw: () => void
  setLockedAxis: (axis: Axis | null) => void
  requestPreciseFocus: (seed: string) => void

  startDrag: (args: {
    id: string; kind?: 'profile' | 'connector'; hit: THREE.Vector3; origin: THREE.Vector3;
    groupOrigins: Record<string, [number, number, number]>; plane: THREE.Plane; vertical: boolean
    free?: boolean; axis?: 'x' | 'y' | 'z' | null
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
  setHoverPart: (id: string | null) => void
  setHoverEnd: (end: 'start' | 'end' | null) => void
  setGizmoHover: (part: ToolState['gizmoHover']) => void
  setHoverCandidates: (count: number, index: number) => void

  toggleDimensionLabels: () => void
  toggleGizmo: () => void
  setPivotMode: (mode: PivotMode) => void
  setThroughRule: (rule: ThroughRule) => void
  setWorkPlaneY: (y: number) => void
  cyclePivotMode: () => void
  openQuickMenu: (x: number, y: number) => void
  closeQuickMenu: () => void
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
  held: null,
  activeSpec: '2020',
  activeConnectorType: null,
  language: 'zh',
  cameraResetTrigger: 0,
  cameraFitScope: 'all',
  pendingRotate: null,
  zoomStep: 0,
  zoomAt: null,

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
  pivotMode: 'center',
  throughRule: getThroughRule(),
  workPlaneY: 0,
  quickMenuAt: null,
  selectMode: false,
  toasts: [],
  hoverProfileId: null,
  hoverPartId: null,
  hoverEnd: null,
  hoverCandidates: { count: 0, index: 0 },
  gizmoHover: null,
  dragAxis: null,

  isFrameSelecting: false,
  frameSelectStart: null,
  frameSelectCurrent: null,
  frameSelectRect: null,

  putDown: () => set({
    held: null, isDrawing: false, drawOrigin: null, startPoint: null, currentPoint: null,
    snapPoint: null, drawAxis: null, lockedAxis: null, alignGuides: [], snapKind: null, hoverTargetId: null, selectMode: false,
  }),
  setActiveSpec: (spec) => set({ activeSpec: spec, held: 'profile', selectMode: false }),
  setActiveConnector: (type) => set({
    activeConnectorType: type, held: type ? 'connector' : null, selectMode: false,
    ...(type ? {} : { isDrawing: false, startPoint: null, currentPoint: null, snapPoint: null }),
  }),
  setLanguage: (language) => set({ language }),
  triggerCameraReset: (scope = 'all') => set((s) => ({ cameraResetTrigger: s.cameraResetTrigger + 1, cameraFitScope: scope })),
  setPendingRotate: (pendingRotate) => set({ pendingRotate }),
  zoomBy: (step) => set((s) => ({ zoomStep: s.zoomStep + step })),
  clearZoom: () => set({ zoomStep: 0, zoomAt: null }),
  zoomToPoint: (at) => set({ zoomAt: at }),

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

  startDrag: ({ id, kind = 'profile', hit, origin, groupOrigins, plane, vertical, free = false, axis = null }) => set({
    isDragging: true, dragKind: kind, dragProfileId: id, dragStartHit: hit, dragOriginPos: origin,
    dragGroupOrigins: groupOrigins, dragPlane: plane, dragVertical: vertical, dragFree: free, dragAxis: axis,
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
  // dragMoved doubles as "this gesture already has a history entry", for both kinds of drag
  startResize: (resize) => set({ resize, dragMoved: false }),
  stopResize: () => set({ resize: null, dragMoved: false }),
  stopDrag: () => set({
    isDragging: false, dragKind: 'profile', dragProfileId: null, dragStartHit: null, dragOriginPos: null,
    dragGroupOrigins: {}, dragPlane: null, dragVertical: false, dragFree: false, dragAxis: null,
    dragMoved: false, dragConflict: false, snapRefIds: [], snapGuides: [],
  }),
  setHoverProfile: (id) => { if (get().hoverProfileId !== id) set({ hoverProfileId: id }) },
  setHoverPart: (id) => { if (get().hoverPartId !== id) set({ hoverPartId: id }) },
  setHoverEnd: (end) => { if (get().hoverEnd !== end) set({ hoverEnd: end }) },
  setHoverCandidates: (count, index) => {
    const cur = get().hoverCandidates
    if (cur.count !== count || cur.index !== index) set({ hoverCandidates: { count, index } })
  },
  setGizmoHover: (part) => {
    const cur = get().gizmoHover
    if (cur?.kind !== part?.kind || cur?.axis !== part?.axis) set({ gizmoHover: part })
  },

  toggleDimensionLabels: () => set((s) => ({ showDimensionLabels: !s.showDimensionLabels })),
  toggleGizmo: () => set((s) => ({ showGizmo: !s.showGizmo })),
  setPivotMode: (pivotMode) => set({ pivotMode }),
  setThroughRule: (rule) => { applyThroughRule(rule); set({ throughRule: rule }) },
  setWorkPlaneY: (workPlaneY) => set({ workPlaneY: isFinite(workPlaneY) ? Math.max(0, Math.round(workPlaneY)) : 0 }),
  openQuickMenu: (x, y) => set({ quickMenuAt: { x, y } }),
  closeQuickMenu: () => set({ quickMenuAt: null }),
  cyclePivotMode: () => set((s) => ({
    pivotMode: s.pivotMode === 'center' ? 'start' : s.pivotMode === 'start' ? 'end' : 'center',
  })),
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
