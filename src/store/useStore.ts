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
  /** a finished part: still visible and still a snapping reference, but nothing moves it */
  locked?: boolean
}

export interface ConnectorData {
  id: string
  type: string
  /** extrusion series the part is made for; older files default to the 20 series */
  series?: 20 | 30 | 40
  position: [number, number, number]
  quaternion: [number, number, number, number]
  locked?: boolean
}

/**
 * A flat board: a back, a shelf, a door or a drawer front. Modelled by its own size rather
 * than by the opening it fills, so moving the frame around it does not silently resize it —
 * a board is cut once and stays that size until somebody changes it.
 * Local axes: width along X, height along Y, thickness along Z.
 */
export type PanelMaterial = 'mdf' | 'ply' | 'acrylic' | 'alu'

export interface PanelData {
  id: string
  width: number
  height: number
  thickness: number
  /** centre of the board */
  position: [number, number, number]
  quaternion: [number, number, number, number]
  material: PanelMaterial
  locked?: boolean
}

/**
 * A drawer or a door: one part, not a pile of boards.
 *
 * A drawer was six loose boards and two rails, which meant nothing held them together —
 * resize the opening and they stayed put, delete one and the rest were still a "drawer".
 * As one component it knows its own opening, so it can be re-cut, and it has somewhere to
 * keep how far it is open, which is what makes a cabinet worth looking at rather than just
 * worth building.
 *
 * Local axes: X across the opening, Y up, **+Z is the way it opens** — the direction the
 * drawer pulls out or the door swings towards. `position` is the centre of the clear opening.
 */
export type FittingKind = 'drawer' | 'door'
/** which edge the door is hung on, looking at it from the front */
export type HingeSide = 'left' | 'right' | 'top' | 'bottom'
/**
 * Three kinds, and they are not interchangeable.
 *
 *  - `cup`: the 35 mm concealed hinge every kitchen uses. Bored into the back of the door,
 *    a plate on the carcase, adjustable in three directions, opens about 110°.
 *  - `slot`: the two-leaf hinge made for extrusion. Bolts straight into the T-slots of the
 *    profile and of the door frame, nothing bored, and it will go past 180°.
 *  - `continuous`: a piano hinge down the whole edge, for a tall or heavy door, or a flap.
 */
export type HingeType = 'cup' | 'slot' | 'continuous'
/**
 * How far a door is allowed to open, in degrees.
 *
 * Not a detail: it is chosen for the obstruction next to the door, and the wrong one is a
 * door that hits the handle beside it or one that will not clear a drawer behind it.
 *
 *  - 95  restricted, for a door beside an appliance or a proud handle
 *  - 110 the everyday standard for frameless cabinets
 *  - 135 for a cabinet set at 45°
 *  - 165 blind corners and carousels, where the door has to clear the cabinet next to it
 *  - 180 folds flat back against the side
 */
export const HINGE_ANGLES = [95, 110, 135, 165, 180] as const
/** how the door sits on the opening: over it, half over it, or inside it */
export type Overlay = 'full' | 'half' | 'inset'

export interface FittingData {
  /**
   * How thick the frame is that this front lies on (mm).
   *
   * A full-overlay front covers the uprights it is fitted to, so it sits that much further
   * out than the box behind it. Without the number the two cannot both be right: put the box
   * where it belongs and the front is inside the frame, put the front where it belongs and
   * the box is through the post. Absent on documents written before this, and then zero.
   */
  frame?: number
  id: string
  kind: FittingKind
  /** centre of the clear opening */
  position: [number, number, number]
  quaternion: [number, number, number, number]
  /** the clear opening */
  width: number
  height: number
  depth: number
  material: PanelMaterial
  /** 0 shut, 1 as far as it goes. Only ever changed while looking, never while building. */
  open: number
  hinge?: HingeSide
  hingeType?: HingeType
  /** how far it opens (degrees); older files fall back to what the mechanism allows */
  swing?: number
  overlay?: Overlay
  locked?: boolean
}

type Snapshot = { profiles: ProfileData[]; connectors: ConnectorData[]; panels: PanelData[]; fittings: FittingData[] }

const MAX_HISTORY = 50

function takeSnapshot(state: Pick<State, 'profiles' | 'connectors' | 'panels' | 'fittings'>): Snapshot {
  return {
    profiles: [...state.profiles], connectors: [...state.connectors],
    panels: [...state.panels], fittings: [...state.fittings],
  }
}

interface State {
  profiles: ProfileData[]
  connectors: ConnectorData[]
  panels: PanelData[]
  fittings: FittingData[]
  selectedIds: string[]
  past: Snapshot[]
  future: Snapshot[]

  addProfile: (profile: ProfileData) => void
  addProfiles: (profiles: ProfileData[], select?: boolean) => void
  addItems: (profiles: ProfileData[], connectors: ConnectorData[], select?: boolean) => void
  addPanels: (panels: PanelData[], select?: boolean) => void
  addFittings: (fittings: FittingData[], select?: boolean) => void
  updateFitting: (id: string, updates: Partial<FittingData>, pushHistory?: boolean) => void
  updatePanel: (id: string, updates: Partial<PanelData>) => void
  commitPanelEdit: (id: string, updates: Partial<PanelData>) => void
  /** Replace the whole document (import) */
  loadDocument: (doc: { profiles: ProfileData[]; connectors: ConnectorData[]; panels?: PanelData[]; fittings?: FittingData[] }) => void
  removeProfile: (id: string) => void
  removeSelected: () => void
  /** lock or unlock the selection; locked parts are protected from moves and deletion */
  toggleLockSelected: () => void
  clearAll: () => void
  addConnector: (connector: ConnectorData) => void
  removeConnector: (id: string) => void
  /** drop several connectors in one history step */
  removeConnectors: (ids: string[], pushHistory?: boolean) => void
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
  commitTransform: (args: { profiles?: Array<{ id: string; updates: Partial<ProfileData> }>; connectors?: Array<{ id: string; updates: Partial<ConnectorData> }>; panels?: Array<{ id: string; updates: Partial<PanelData> }>; fittings?: Array<{ id: string; updates: Partial<FittingData> }> }) => void
  updateConnector: (id: string, updates: Partial<ConnectorData>) => void
  /** Live move of several parts at once (no history) — one store write per frame */
  updateParts: (args: { profiles?: Array<{ id: string; updates: Partial<ProfileData> }>; connectors?: Array<{ id: string; updates: Partial<ConnectorData> }>; panels?: Array<{ id: string; updates: Partial<PanelData> }>; fittings?: Array<{ id: string; updates: Partial<FittingData> }> }) => void
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
      panels: [],
      fittings: [],
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

      addFittings: (list, select = false) => set((state) => ({
        past: [...state.past.slice(-MAX_HISTORY), takeSnapshot(state)],
        future: [],
        fittings: [...state.fittings, ...list],
        ...(select ? { selectedIds: list.map((f) => f.id) } : {}),
      })),

      // How far open is a way of looking, not a change to the design, so it leaves no
      // history entry: undo after opening a drawer should undo the last thing you built.
      updateFitting: (id, updates, pushHistory = true) => set((state) => ({
        ...(pushHistory ? { past: [...state.past.slice(-MAX_HISTORY), takeSnapshot(state)], future: [] } : {}),
        fittings: state.fittings.map((f) => f.id === id ? { ...f, ...updates } : f),
      })),

      addPanels: (list, select = false) => set((state) => ({
        past: [...state.past.slice(-MAX_HISTORY), takeSnapshot(state)],
        future: [],
        panels: [...state.panels, ...list],
        selectedIds: select ? list.map((p) => p.id) : state.selectedIds,
      })),

      updatePanel: (id, updates) => set((state) => ({
        panels: state.panels.map((p) => p.id === id ? { ...p, ...updates } : p),
      })),

      commitPanelEdit: (id, updates) => set((state) => ({
        past: [...state.past.slice(-MAX_HISTORY), takeSnapshot(state)],
        future: [],
        panels: state.panels.map((p) => p.id === id ? { ...p, ...updates } : p),
      })),

      loadDocument: (doc) => set((state) => ({
        past: [...state.past.slice(-MAX_HISTORY), takeSnapshot(state)],
        future: [],
        profiles: doc.profiles,
        connectors: doc.connectors,
        panels: doc.panels ?? [],
        fittings: doc.fittings ?? [],
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
        // a lock protects against deletion too, or it would only be half a lock
        const removable = (x: { id: string; locked?: boolean }) => ids.has(x.id) && !x.locked
        if (!state.profiles.some(removable) && !state.connectors.some(removable)
          && !state.panels.some(removable) && !state.fittings.some(removable)) return {}
        const stillLocked = (id: string) => state.profiles.some((p) => p.id === id && p.locked)
          || state.connectors.some((c) => c.id === id && c.locked)
          || state.panels.some((p) => p.id === id && p.locked)
          || state.fittings.some((f) => f.id === id && f.locked)
        return {
          past: [...state.past.slice(-MAX_HISTORY), takeSnapshot(state)],
          future: [],
          profiles: state.profiles.filter((p) => !removable(p)),
          connectors: state.connectors.filter((c) => !removable(c)),
          panels: state.panels.filter((p) => !removable(p)),
          fittings: state.fittings.filter((f) => !removable(f)),
          selectedIds: state.selectedIds.filter(stillLocked),
        }
      }),

      toggleLockSelected: () => set((state) => {
        const ids = new Set(state.selectedIds)
        if (ids.size === 0) return {}
        // mixed selections lock rather than unlock: the safer of the two
        const anyUnlocked = state.profiles.some((p) => ids.has(p.id) && !p.locked)
          || state.connectors.some((c) => ids.has(c.id) && !c.locked)
          || state.panels.some((p) => ids.has(p.id) && !p.locked)
        return {
          past: [...state.past.slice(-MAX_HISTORY), takeSnapshot(state)],
          future: [],
          profiles: state.profiles.map((p) => ids.has(p.id) ? { ...p, locked: anyUnlocked } : p),
          connectors: state.connectors.map((c) => ids.has(c.id) ? { ...c, locked: anyUnlocked } : c),
          panels: state.panels.map((p) => ids.has(p.id) ? { ...p, locked: anyUnlocked } : p),
          fittings: state.fittings.map((f) => ids.has(f.id) ? { ...f, locked: anyUnlocked } : f),
        }
      }),

      clearAll: () => set((state) => ({
        past: [...state.past.slice(-MAX_HISTORY), takeSnapshot(state)],
        future: [],
        profiles: [],
        connectors: [],
        panels: [],
        fittings: [],
        selectedIds: [],
      })),

      addConnector: (connector) => set((state) => ({
        past: [...state.past.slice(-MAX_HISTORY), takeSnapshot(state)],
        future: [],
        connectors: [...state.connectors, connector],
      })),

      removeConnectors: (ids, pushHistory = true) => set((state) => {
        const drop = new Set(ids)
        if (drop.size === 0) return {}
        return {
          ...(pushHistory ? { past: [...state.past.slice(-MAX_HISTORY), takeSnapshot(state)], future: [] } : {}),
          connectors: state.connectors.filter((c) => !drop.has(c.id)),
          selectedIds: state.selectedIds.filter((s) => !drop.has(s)),
        }
      }),

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

      commitTransform: ({ profiles = [], connectors = [], panels = [], fittings = [] }) => set((state) => {
        if (profiles.length === 0 && connectors.length === 0 && panels.length === 0 && fittings.length === 0) return {}
        const pMap = new Map(profiles.map((u) => [u.id, u.updates]))
        const cMap = new Map(connectors.map((u) => [u.id, u.updates]))
        const bMap = new Map(panels.map((u) => [u.id, u.updates]))
        const fMap = new Map(fittings.map((u) => [u.id, u.updates]))
        return {
          past: [...state.past.slice(-MAX_HISTORY), takeSnapshot(state)],
          future: [],
          profiles: state.profiles.map((p) => pMap.has(p.id) ? { ...p, ...pMap.get(p.id)! } : p),
          connectors: state.connectors.map((c) => cMap.has(c.id) ? { ...c, ...cMap.get(c.id)! } : c),
          panels: state.panels.map((b) => bMap.has(b.id) ? { ...b, ...bMap.get(b.id)! } : b),
          fittings: state.fittings.map((f) => fMap.has(f.id) ? { ...f, ...fMap.get(f.id)! } : f),
        }
      }),

      updateParts: ({ profiles = [], connectors = [], panels = [], fittings = [] }) => set((state) => {
        if (profiles.length === 0 && connectors.length === 0 && panels.length === 0 && fittings.length === 0) return {}
        const pMap = new Map(profiles.map((u) => [u.id, u.updates]))
        const cMap = new Map(connectors.map((u) => [u.id, u.updates]))
        const bMap = new Map(panels.map((u) => [u.id, u.updates]))
        const fMap = new Map(fittings.map((u) => [u.id, u.updates]))
        return {
          profiles: pMap.size ? state.profiles.map((p) => pMap.has(p.id) ? { ...p, ...pMap.get(p.id)! } : p) : state.profiles,
          connectors: cMap.size ? state.connectors.map((c) => cMap.has(c.id) ? { ...c, ...cMap.get(c.id)! } : c) : state.connectors,
          panels: bMap.size ? state.panels.map((b) => bMap.has(b.id) ? { ...b, ...bMap.get(b.id)! } : b) : state.panels,
          fittings: fMap.size ? state.fittings.map((f) => fMap.has(f.id) ? { ...f, ...fMap.get(f.id)! } : f) : state.fittings,
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
          panels: prev.panels ?? [],
          fittings: prev.fittings ?? [],
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
          panels: next.panels ?? [],
          fittings: next.fittings ?? [],
          selectedIds: [],
        }
      }),
    }),
    {
      name: 'aluminum-designer-store',
      partialize: (state) => ({ profiles: state.profiles, connectors: state.connectors, panels: state.panels, fittings: state.fittings }),
    }
  )
)
