import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { parseProjectDocument, type ProjectDocument, type ProjectGeometry } from '../utils/document'
import { documentStorage } from '../utils/documentPersistence'
import { setThroughRule as applyThroughRule, withFixedProfileCuts, validFixedProfileCut, type ThroughRule } from '../utils/jointUtils'

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
  /** Determined cut faces, in local-axis millimetres; absent in legacy automatic parts. */
  fixedTrims?: { start: number; end: number }
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

/** A board with independent dimensions: local X width, Y height and Z thickness. */
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
 * A drawer or door with a fixed opening and an open amount.
 * Local axes: X across the opening, Y up, +Z outward; position is the opening centre.
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
  /** Open amount: 0 closed, 1 fully open. */
  open: number
  hinge?: HingeSide
  hingeType?: HingeType
  /** how far it opens (degrees); older files fall back to what the mechanism allows */
  swing?: number
  overlay?: Overlay
  /**
   * Drawers fitted one above another in the same opening: which of this front's edges meet
   * the next drawer's front rather than the frame. Those edges get the 3 mm gap between two
   * fronts, not an overlay onto a rail that is not there — overlaying both fronts onto the
   * same line put each one 30 mm into its neighbour.
   */
  stacked?: { above?: boolean; below?: boolean }
  locked?: boolean
}

type Snapshot = ProjectDocument

const MAX_HISTORY = 50

function takeSnapshot(state: ProjectDocument): Snapshot {
  return {
    profiles: [...state.profiles], connectors: [...state.connectors],
    panels: [...state.panels], fittings: [...state.fittings], throughRule: state.throughRule,
  }
}

/** Keep the editing context when history changes geometry, dropping only removed parts. */
function survivingSelection(ids: string[], document: Snapshot): string[] {
  const present = new Set([...document.profiles, ...document.connectors,
    ...(document.panels ?? []), ...(document.fittings ?? [])].map((part) => part.id))
  return ids.filter((id) => present.has(id))
}

type ProfileUpdate = { id: string; updates: Partial<ProfileData> }
const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)
const shapeFields = ['position', 'quaternion', 'length', 'spec', 'fixedTrims'] as const

/** Every edit path uses the same rigid-part contract, including numeric/live inputs. */
function applyProfileUpdates(all: ProfileData[], updates: ProfileUpdate[]): ProfileData[] {
  const byId = new Map(updates.map((u) => [u.id, u.updates]))
  const changed = all.filter((p) => !p.locked && byId.has(p.id)
    && Object.entries(byId.get(p.id)!).some(([key, value]) => !sameValue(p[key as keyof ProfileData], value)))
  if (!changed.length) return all
  const changedIds = new Set(changed.map((p) => p.id))
  const geometryChanged = changed.some((p) => shapeFields.some((key) => key in byId.get(p.id)!
    && !sameValue(p[key], byId.get(p.id)![key])))
  const baseline = geometryChanged ? withFixedProfileCuts(all) : all
  const result = baseline.map((p) => changedIds.has(p.id) ? { ...p, ...byId.get(p.id)! } : p)
  // Reject the whole profile edit, without a snapshot or a partially fixed document.
  return result.every(validFixedProfileCut) ? result : all
}

function applyPartUpdates<T extends { id: string; locked?: boolean }>(all: T[], updates: Array<{ id: string; updates: Partial<T> }>): T[] {
  const byId = new Map(updates.map((u) => [u.id, u.updates]))
  let changed = false
  const next = all.map((part) => {
    const edit = byId.get(part.id)
    if (part.locked || !edit || Object.entries(edit).every(([key, value]) => sameValue(part[key as keyof T], value))) return part
    changed = true
    return { ...part, ...edit }
  })
  return changed ? next : all
}

// Fixing a legacy locked reference changes how automatic neighbours fit against it.
// Preserve the whole existing assembly before adding anything or changing its rule.
const fixedLockedCuts = (all: ProfileData[]) =>
  all.some((p) => p.locked && !p.fixedTrims) ? withFixedProfileCuts(all) : all

/** Changing a joint rule is explicit; a locked finished part still keeps its cut faces. */
function automaticUnlockedCuts(all: ProfileData[]): ProfileData[] {
  const protectedParts = fixedLockedCuts(all)
  let changed = protectedParts !== all
  const next = protectedParts.map((p) => {
    if (p.locked || !p.fixedTrims) return p
    changed = true
    const { fixedTrims: _fixedTrims, ...automatic } = p
    return automatic
  })
  return changed ? next : all
}

interface State {
  profiles: ProfileData[]
  connectors: ConnectorData[]
  panels: PanelData[]
  fittings: FittingData[]
  throughRule: ThroughRule
  setThroughRule: (rule: ThroughRule) => void
  /** Preserve all current physical lengths; the caller owns any gesture history entry. */
  freezeProfileCuts: () => void
  /** Explicitly fit unlocked cut faces to the current joints in one undoable action. */
  recalculateJoints: () => void
  /** One user command, one complete history entry, including replacements/removals. */
  commitDocument: (doc: Partial<ProjectDocument>, selection?: string[]) => void
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
  loadDocument: (doc: Pick<ProjectGeometry, 'profiles' | 'connectors'> & Partial<ProjectDocument>) => void
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
      throughRule: 'rails',
      selectedIds: [],
      past: [],
      future: [],

      setThroughRule: (throughRule) => set((state) => {
        if (state.throughRule === throughRule) return state
        return { throughRule, profiles: automaticUnlockedCuts(state.profiles),
          past: [...state.past.slice(-(MAX_HISTORY - 1)), takeSnapshot(state)], future: [] }
      }),
      freezeProfileCuts: () => set((state) => {
        const profiles = withFixedProfileCuts(state.profiles)
        return profiles === state.profiles ? state : { profiles }
      }),
      recalculateJoints: () => set((state) => {
        if (!state.profiles.some((p) => p.fixedTrims && !p.locked)) return state
        return { profiles: automaticUnlockedCuts(state.profiles),
          past: [...state.past.slice(-(MAX_HISTORY - 1)), takeSnapshot(state)], future: [] }
      }),
      commitDocument: (doc, selection) => set((state) => {
        const changed = Object.entries(doc).some(([key, value]) => state[key as keyof ProjectDocument] !== value)
        if (!changed) return state
        return {
          ...doc, past: [...state.past.slice(-(MAX_HISTORY - 1)), takeSnapshot(state)], future: [],
          ...(selection ? { selectedIds: selection } : {}),
        }
      }),

      addProfile: (profile) => set((state) => ({
        past: [...state.past.slice(-(MAX_HISTORY - 1)), takeSnapshot(state)],
        future: [],
        profiles: [...fixedLockedCuts(state.profiles), profile],
      })),

      addProfiles: (list, select = false) => set((state) => ({
        past: [...state.past.slice(-(MAX_HISTORY - 1)), takeSnapshot(state)],
        future: [],
        profiles: [...fixedLockedCuts(state.profiles), ...list],
        selectedIds: select ? list.map((p) => p.id) : state.selectedIds,
      })),

      addItems: (list, conns, select = false) => set((state) => ({
        past: [...state.past.slice(-(MAX_HISTORY - 1)), takeSnapshot(state)],
        future: [],
        profiles: [...fixedLockedCuts(state.profiles), ...list],
        connectors: [...state.connectors, ...conns],
        selectedIds: select ? [...list.map((p) => p.id), ...conns.map((c) => c.id)] : state.selectedIds,
      })),

      addFittings: (list, select = false) => set((state) => ({
        past: [...state.past.slice(-(MAX_HISTORY - 1)), takeSnapshot(state)],
        future: [],
        fittings: [...state.fittings, ...list],
        ...(select ? { selectedIds: list.map((f) => f.id) } : {}),
      })),

      // How far open is a way of looking, not a change to the design, so it leaves no
      // history entry: undo after opening a drawer should undo the last thing you built.
      updateFitting: (id, updates, pushHistory = true) => set((state) => ({
        ...(pushHistory ? { past: [...state.past.slice(-(MAX_HISTORY - 1)), takeSnapshot(state)], future: [] } : {}),
        fittings: state.fittings.map((f) => f.id === id ? { ...f, ...updates } : f),
      })),

      addPanels: (list, select = false) => set((state) => ({
        past: [...state.past.slice(-(MAX_HISTORY - 1)), takeSnapshot(state)],
        future: [],
        panels: [...state.panels, ...list],
        selectedIds: select ? list.map((p) => p.id) : state.selectedIds,
      })),

      updatePanel: (id, updates) => set((state) => ({
        panels: state.panels.map((p) => p.id === id ? { ...p, ...updates } : p),
      })),

      commitPanelEdit: (id, updates) => set((state) => ({
        past: [...state.past.slice(-(MAX_HISTORY - 1)), takeSnapshot(state)],
        future: [],
        panels: state.panels.map((p) => p.id === id ? { ...p, ...updates } : p),
      })),

      loadDocument: (doc) => {
        const checked = parseProjectDocument(doc)
        set((state) => ({
          past: [...state.past.slice(-(MAX_HISTORY - 1)), takeSnapshot(state)],
          future: [],
          ...checked,
          selectedIds: [],
        }))
      },

      removeProfile: (id) => set((state) => {
        if (!state.profiles.some((p) => p.id === id && !p.locked)) return state
        return { past: [...state.past.slice(-(MAX_HISTORY - 1)), takeSnapshot(state)], future: [],
          profiles: withFixedProfileCuts(state.profiles).filter((p) => p.id !== id),
          selectedIds: state.selectedIds.filter((s) => s !== id) }
      }),

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
          past: [...state.past.slice(-(MAX_HISTORY - 1)), takeSnapshot(state)],
          future: [],
          profiles: (state.profiles.some(removable) ? withFixedProfileCuts(state.profiles) : state.profiles).filter((p) => !removable(p)),
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
          || state.fittings.some((f) => ids.has(f.id) && !f.locked)
        return {
          past: [...state.past.slice(-(MAX_HISTORY - 1)), takeSnapshot(state)],
          future: [],
          profiles: (anyUnlocked && state.profiles.some((p) => ids.has(p.id)) ? withFixedProfileCuts(state.profiles) : state.profiles)
            .map((p) => ids.has(p.id) ? { ...p, locked: anyUnlocked } : p),
          connectors: state.connectors.map((c) => ids.has(c.id) ? { ...c, locked: anyUnlocked } : c),
          panels: state.panels.map((p) => ids.has(p.id) ? { ...p, locked: anyUnlocked } : p),
          fittings: state.fittings.map((f) => ids.has(f.id) ? { ...f, locked: anyUnlocked } : f),
        }
      }),

      clearAll: () => set((state) => ({
        past: [...state.past.slice(-(MAX_HISTORY - 1)), takeSnapshot(state)],
        future: [],
        profiles: [],
        connectors: [],
        panels: [],
        fittings: [],
        selectedIds: [],
      })),

      addConnector: (connector) => set((state) => ({
        past: [...state.past.slice(-(MAX_HISTORY - 1)), takeSnapshot(state)],
        future: [],
        connectors: [...state.connectors, connector],
      })),

      removeConnectors: (ids, pushHistory = true) => set((state) => {
        const drop = new Set(ids)
        if (drop.size === 0) return {}
        return {
          ...(pushHistory ? { past: [...state.past.slice(-(MAX_HISTORY - 1)), takeSnapshot(state)], future: [] } : {}),
          connectors: state.connectors.filter((c) => !drop.has(c.id)),
          selectedIds: state.selectedIds.filter((s) => !drop.has(s)),
        }
      }),

      removeConnector: (id) => set((state) => ({
        past: [...state.past.slice(-(MAX_HISTORY - 1)), takeSnapshot(state)],
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

      updateProfile: (id, updates) => set((state) => {
        const profiles = applyProfileUpdates(state.profiles, [{ id, updates }])
        return profiles === state.profiles ? state : { profiles }
      }),

      updateProfiles: (updates) => set((state) => {
        const profiles = applyProfileUpdates(state.profiles, updates)
        return profiles === state.profiles ? state : { profiles }
      }),

      commitProfileEdit: (id, updates) => set((state) => {
        const profiles = applyProfileUpdates(state.profiles, [{ id, updates }])
        return profiles === state.profiles ? state : { profiles,
          past: [...state.past.slice(-(MAX_HISTORY - 1)), takeSnapshot(state)], future: [] }
      }),

      commitProfilesEdit: (updates) => set((state) => {
        const profiles = applyProfileUpdates(state.profiles, updates)
        return profiles === state.profiles ? state : { profiles,
          past: [...state.past.slice(-(MAX_HISTORY - 1)), takeSnapshot(state)], future: [] }
      }),

      commitTransform: ({ profiles = [], connectors = [], panels = [], fittings = [] }) => set((state) => {
        if (profiles.length === 0 && connectors.length === 0 && panels.length === 0 && fittings.length === 0) return {}
        const next = { profiles: applyProfileUpdates(state.profiles, profiles),
          connectors: applyPartUpdates(state.connectors, connectors), panels: applyPartUpdates(state.panels, panels),
          fittings: applyPartUpdates(state.fittings, fittings) }
        if (Object.entries(next).every(([key, value]) => state[key as keyof typeof next] === value)) return state
        return {
          past: [...state.past.slice(-(MAX_HISTORY - 1)), takeSnapshot(state)],
          future: [],
          ...next,
        }
      }),

      updateParts: ({ profiles = [], connectors = [], panels = [], fittings = [] }) => set((state) => {
        if (profiles.length === 0 && connectors.length === 0 && panels.length === 0 && fittings.length === 0) return {}
        const next = { profiles: applyProfileUpdates(state.profiles, profiles),
          connectors: applyPartUpdates(state.connectors, connectors), panels: applyPartUpdates(state.panels, panels),
          fittings: applyPartUpdates(state.fittings, fittings) }
        return Object.entries(next).every(([key, value]) => state[key as keyof typeof next] === value) ? state : next
      }),

      updateConnector: (id, updates) => set((state) => ({
        connectors: state.connectors.map((c) => c.id === id ? { ...c, ...updates } : c),
      })),

      snapshotHistory: () => set((state) => ({
        past: [...state.past.slice(-(MAX_HISTORY - 1)), takeSnapshot(state)],
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
          throughRule: prev.throughRule ?? 'rails',
          selectedIds: survivingSelection(state.selectedIds, prev),
        }
      }),

      redo: () => set((state) => {
        if (state.future.length === 0) return {}
        const next = state.future[0]
        return {
          past: [...state.past.slice(-(MAX_HISTORY - 1)), takeSnapshot(state)],
          future: state.future.slice(1),
          profiles: next.profiles,
          connectors: next.connectors,
          panels: next.panels ?? [],
          fittings: next.fittings ?? [],
          throughRule: next.throughRule ?? 'rails',
          selectedIds: survivingSelection(state.selectedIds, next),
        }
      }),
    }),
    {
      name: 'aluminum-designer-store',
      storage: documentStorage,
      partialize: (state) => ({ profiles: state.profiles, connectors: state.connectors, panels: state.panels, fittings: state.fittings, throughRule: state.throughRule }),
    }
  )
)

// The compatibility geometry API reads this rule. Synchronize before scene/log subscribers
// run; the document owns it, including hydration, import, undo and redo.
applyThroughRule(useStore.getState().throughRule)
useStore.subscribe((state, previous) => {
  if (state.throughRule !== previous.throughRule) applyThroughRule(state.throughRule)
})
