import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { parseProjectDocument, PROJECT_VERSION, type ProjectDocument, type ProjectGeometry } from '../utils/document'
import { documentStorage } from '../utils/documentPersistence'
import { validFittings } from '../utils/fittingValidation'
import { validEquipmentList } from '../utils/equipmentValidation'
import { reconcileBindings, type EditResult, type FittingOpeningBinding, type PanelOpeningBinding, type RunnerBinding, type SupportBinding } from '../utils/openingBindings'
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
  runnerBinding?: RunnerBinding
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
  supportBinding?: SupportBinding
  id: string
  type: string
  /** extrusion series the part is made for; older files default to the 20 series */
  series?: 20 | 30 | 40
  /** Full mating section for end caps and section-specific hardware. */
  profileSpec?: ProfileSpec
  /** Slot family of the host of each inner-bracket arm, ordered local X then Y. */
  mountSeries?: [20 | 30 | 40, 20 | 30 | 40]
  position: [number, number, number]
  quaternion: [number, number, number, number]
  locked?: boolean
}

/** A board with independent dimensions: local X width, Y height and Z thickness. */
export type PanelMaterial = 'mdf' | 'ply' | 'acrylic' | 'alu'

export interface PanelData {
  openingBinding?: PanelOpeningBinding
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

export interface EquipmentClearance { left: number; right: number; bottom: number; top: number; back: number; front: number }

/** A user-sized appliance envelope: centre position, local X/Y/Z dimensions and +Z front. */
export interface EquipmentData {
  id: string
  name: string
  width: number
  height: number
  depth: number
  position: [number, number, number]
  quaternion: [number, number, number, number]
  clearance: EquipmentClearance
  locked?: boolean
}

/**
 * A drawer or door with a fixed opening and an open amount.
 * Local axes: X across the opening, Y up, +Z outward; position is the opening centre.
 */
export type FittingKind = 'drawer' | 'door'
/** which edge the door is hung on, looking at it from the front */
export type HingeSide = 'left' | 'right' | 'top' | 'bottom'
/** Concealed cup, extrusion-slot or continuous hinge representation. */
export type HingeType = 'cup' | 'slot' | 'continuous'
/** Maximum simulated door opening angle in degrees. Actual hinge travel depends on the hardware. */
export const HINGE_ANGLES = [90, 95, 110, 135, 165, 180] as const
/** how the door sits on the opening: over it, half over it, or inside it */
export type Overlay = 'full' | 'half' | 'inset'

export interface DrawerReinforcement { count: number; width: number; height: number }

/** User-specified construction and runner dimensions in millimetres. */
export interface DrawerConfig {
  sideClearance?: number
  boxThickness?: number
  bottomThickness?: number
  rearClearance?: number
  runnerLength?: number
  runnerTravel?: number
  reinforcement?: DrawerReinforcement
}

export interface FittingData {
  openingBinding?: FittingOpeningBinding
  /** Frame depth between the opening front and the front board (mm); defaults to zero. */
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
  /** The leaf's meeting edge in local X; that edge stops 1.5 mm short of the opening. */
  meeting?: 'left' | 'right'
  /** Adjacent drawer fronts share a 3 mm gap; only outer edges receive frame overlays. */
  stacked?: { above?: boolean; below?: boolean }
  drawer?: DrawerConfig
  locked?: boolean
}

type Snapshot = ProjectDocument

const MAX_HISTORY = 50

function takeSnapshot(state: ProjectDocument): Snapshot {
  return {
    profiles: [...state.profiles], connectors: [...state.connectors],
    panels: [...state.panels], fittings: [...state.fittings], throughRule: state.throughRule,
    equipment: [...(state.equipment ?? [])],
  }
}

/** Keep the editing context when history changes geometry, dropping only removed parts. */
function survivingSelection(ids: string[], document: Snapshot): string[] {
  const present = new Set([...document.profiles, ...document.connectors,
    ...(document.panels ?? []), ...(document.fittings ?? []), ...(document.equipment ?? [])].map((part) => part.id))
  return ids.filter((id) => present.has(id))
}

type ProfileUpdate = { id: string; updates: Partial<ProfileData> }
const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)
const shapeFields = ['position', 'quaternion', 'length', 'spec', 'fixedTrims'] as const

/** Every edit path uses the same rigid-part contract, including numeric/live inputs. */
function applyProfileUpdates(all: ProfileData[], updates: ProfileUpdate[], rule: ThroughRule): ProfileData[] | null {
  const byId = new Map(updates.map((u) => [u.id, u.updates]))
  const changed = all.filter((p) => !p.locked && byId.has(p.id)
    && Object.entries(byId.get(p.id)!).some(([key, value]) => !sameValue(p[key as keyof ProfileData], value)))
  if (!changed.length) return all
  const changedIds = new Set(changed.map((p) => p.id))
  const geometryChanged = changed.some((p) => shapeFields.some((key) => key in byId.get(p.id)!
    && !sameValue(p[key], byId.get(p.id)![key])))
  const baseline = geometryChanged ? withFixedProfileCuts(all, undefined, rule) : all
  const result = baseline.map((p) => changedIds.has(p.id) ? { ...p, ...byId.get(p.id)! } : p)
  // Reject the whole profile edit, without a snapshot or a partially fixed document.
  return result.every((p) => validFixedProfileCut(p) && Number.isFinite(p.length) && p.length > 0
    && p.position.every(Number.isFinite) && p.quaternion.every(Number.isFinite) && Math.hypot(...p.quaternion) > 1e-6) ? result : null
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
const fixedLockedCuts = (all: ProfileData[], rule: ThroughRule) =>
  all.some((p) => p.locked && !p.fixedTrims) ? withFixedProfileCuts(all, undefined, rule) : all

/** Changing a joint rule is explicit; a locked finished part still keeps its cut faces. */
function automaticUnlockedCuts(all: ProfileData[], rule: ThroughRule): ProfileData[] {
  const protectedParts = fixedLockedCuts(all, rule)
  let changed = protectedParts !== all
  const next = protectedParts.map((p) => {
    if (p.locked || !p.fixedTrims) return p
    changed = true
    const { fixedTrims: _fixedTrims, ...automatic } = p
    return automatic
  })
  return changed ? next : all
}

export interface PartUpdates {
  profiles?: Array<{ id: string; updates: Partial<ProfileData> }>
  connectors?: Array<{ id: string; updates: Partial<ConnectorData> }>
  panels?: Array<{ id: string; updates: Partial<PanelData> }>
  fittings?: Array<{ id: string; updates: Partial<FittingData> }>
  equipment?: Array<{ id: string; updates: Partial<EquipmentData> }>
}
export interface LiveEditOptions { history?: boolean }
interface State {
  profiles: ProfileData[]
  connectors: ConnectorData[]
  panels: PanelData[]
  fittings: FittingData[]
  equipment: EquipmentData[]
  throughRule: ThroughRule
  selectedIds: string[]
  past: Snapshot[]
  future: Snapshot[]
  setThroughRule: (rule: ThroughRule) => EditResult
  freezeProfileCuts: () => EditResult
  recalculateJoints: () => EditResult
  commitDocument: (doc: Partial<ProjectDocument>, selection?: string[]) => EditResult
  addProfile: (profile: ProfileData) => EditResult
  addProfiles: (profiles: ProfileData[], select?: boolean) => EditResult
  addItems: (profiles: ProfileData[], connectors: ConnectorData[], select?: boolean) => EditResult
  addPanels: (panels: PanelData[], select?: boolean) => EditResult
  addFittings: (fittings: FittingData[], select?: boolean) => EditResult
  addEquipment: (equipment: EquipmentData) => EditResult
  updateEquipment: (id: string, updates: Partial<EquipmentData>) => EditResult
  updateFitting: (id: string, updates: Partial<FittingData>, pushHistory?: boolean) => EditResult
  setFittingOpenings: (ids: string[], open: number) => void
  updatePanel: (id: string, updates: Partial<PanelData>) => EditResult
  commitPanelEdit: (id: string, updates: Partial<PanelData>) => EditResult
  loadDocument: (doc: Pick<ProjectGeometry, 'profiles' | 'connectors'> & Partial<ProjectDocument> & { version?: number }) => void
  removeProfile: (id: string) => EditResult
  removeSelected: () => EditResult
  toggleLockSelected: () => EditResult
  clearAll: () => EditResult
  addConnector: (connector: ConnectorData) => EditResult
  removeConnector: (id: string) => EditResult
  removeConnectors: (ids: string[], pushHistory?: boolean) => EditResult
  selectItem: (id: string, multi?: boolean) => void
  selectItems: (ids: string[]) => void
  clearSelection: () => void
  updateProfile: (id: string, updates: Partial<ProfileData>, options?: LiveEditOptions) => EditResult
  updateProfiles: (updates: ProfileUpdate[], options?: LiveEditOptions) => EditResult
  commitProfileEdit: (id: string, updates: Partial<ProfileData>) => EditResult
  commitProfilesEdit: (updates: ProfileUpdate[]) => EditResult
  commitTransform: (args: PartUpdates) => EditResult
  updateConnector: (id: string, updates: Partial<ConnectorData>) => EditResult
  updateParts: (args: PartUpdates, options?: LiveEditOptions) => EditResult
  snapshotHistory: () => void
  undo: () => void
  redo: () => void
  selectProfile: (id: string | null) => void
}

const documentOf = (state: ProjectDocument): ProjectDocument & { equipment: EquipmentData[] } => ({ profiles: state.profiles, connectors: state.connectors,
  panels: state.panels, fittings: state.fittings, equipment: state.equipment ?? [], throughRule: state.throughRule })
const partKinds = ['profiles', 'connectors', 'panels', 'fittings', 'equipment'] as const
const rejectEdit = (reason: Extract<EditResult, { status: 'rejected' }>['reason'], partIds: string[]): Extract<EditResult, { status: 'rejected' }> => ({ status: 'rejected', reason, partIds })

/** Keep rejection separate from no-op: an invalid profile must also cancel mixed edits. */
function updatedParts(state: State, edits: PartUpdates): Partial<ProjectDocument> | Extract<EditResult, { status: 'rejected' }> {
  const profiles = applyProfileUpdates(state.profiles, edits.profiles ?? [], state.throughRule)
  if (!profiles) return rejectEdit('invalid-profile', (edits.profiles ?? []).map((u) => u.id))
  return { profiles, connectors: applyPartUpdates(state.connectors, edits.connectors ?? []),
    panels: applyPartUpdates(state.panels, edits.panels ?? []), fittings: applyPartUpdates(state.fittings, edits.fittings ?? []),
    equipment: applyPartUpdates(state.equipment, edits.equipment ?? []) }
}

export const useStore = create<State>()(
  persist(
    (set) => {
      /** Validate and derive the entire document before allocating history or publishing any part. */
      const transact = (
        prepare: (state: State) => Partial<ProjectDocument> | Extract<EditResult, { status: 'rejected' }>,
        history = true, selection?: string[] | ((state: State, document: ProjectDocument) => string[]),
      ): EditResult => {
        let result: EditResult = { status: 'noop' }
        set((state) => {
          const patch = prepare(state)
          if ('status' in patch) { result = patch; return state }
          const before = documentOf(state), candidate = { ...before, ...patch,
            equipment: patch.equipment === undefined ? before.equipment : patch.equipment }
          const candidateEquipment: unknown = candidate.equipment
          if (!validEquipmentList(candidateEquipment)) {
            result = rejectEdit('invalid-equipment', Array.isArray(candidateEquipment)
              ? candidateEquipment.flatMap((e: EquipmentData | null) => typeof e?.id === 'string' ? [e.id] : []) : [])
            return state
          }
          const otherIds = new Set([...candidate.profiles, ...candidate.connectors, ...candidate.panels, ...candidate.fittings].map((p) => p.id))
          if (candidate.equipment.some((e) => otherIds.has(e.id))) { result = rejectEdit('invalid-equipment', candidate.equipment.filter((e) => otherIds.has(e.id)).map((e) => e.id)); return state }
          if (!validFittings(candidate.fittings)) { result = rejectEdit('invalid-fitting', candidate.fittings.map((f) => f.id)); return state }
          if (candidate.panels.some((p) => ![p.width, p.height, p.thickness].every((n) => Number.isFinite(n) && n > 0))) {
            result = rejectEdit('invalid-opening', candidate.panels.map((p) => p.id)); return state
          }
          const resolved = reconcileBindings(before, candidate)
          if (resolved.status === 'rejected') { result = resolved; return state }
          const doc = { ...resolved.document, equipment: candidate.equipment }
          for (const kind of partKinds) if (sameValue(doc[kind], state[kind])) (doc[kind] as unknown[]) = state[kind]
          if (partKinds.every((kind) => doc[kind] === state[kind]) && doc.throughRule === state.throughRule) return state
          const old = new Map(partKinds.flatMap((kind) => state[kind].map((p) => [p.id, p] as const)))
          const next = new Map(partKinds.flatMap((kind) => doc[kind].map((p) => [p.id, p] as const)))
          const changedIds = [...new Set([...old.keys(), ...next.keys()])].filter((id) => !sameValue(old.get(id), next.get(id)))
          result = { status: 'applied', changedIds, orphanedIds: resolved.orphanedIds }
          return { ...doc,
            ...(history ? { past: [...state.past.slice(-(MAX_HISTORY - 1)), takeSnapshot(state)], future: [] } : {}),
            ...(selection !== undefined ? { selectedIds: typeof selection === 'function' ? selection(state, doc) : selection } : {}),
          }
        })
        return result
      }
      const edit = (updates: PartUpdates, history = true) => transact((state) => updatedParts(state, updates), history)
      return {
        profiles: [], connectors: [], panels: [], fittings: [], equipment: [], throughRule: 'rails', selectedIds: [], past: [], future: [],
        setThroughRule: (throughRule) => transact((state) => state.throughRule === throughRule ? {} : {
          throughRule, profiles: automaticUnlockedCuts(state.profiles, state.throughRule),
        }),
        freezeProfileCuts: () => transact((state) => ({ profiles: withFixedProfileCuts(state.profiles, undefined, state.throughRule) }), false),
        recalculateJoints: () => transact((state) => ({ profiles: automaticUnlockedCuts(state.profiles, state.throughRule) })),
        commitDocument: (doc, selection) => transact(() => doc, true, selection),
        addProfile: (profile) => transact((state) => ({ profiles: [...fixedLockedCuts(state.profiles, state.throughRule), profile] })),
        addProfiles: (profiles, select = false) => transact((state) => ({ profiles: [...fixedLockedCuts(state.profiles, state.throughRule), ...profiles] }), true, select ? profiles.map((p) => p.id) : undefined),
        addItems: (profiles, connectors, select = false) => transact((state) => ({ profiles: [...fixedLockedCuts(state.profiles, state.throughRule), ...profiles], connectors: [...state.connectors, ...connectors] }), true, select ? [...profiles, ...connectors].map((p) => p.id) : undefined),
        addPanels: (panels, select = false) => transact((state) => ({ panels: [...state.panels, ...panels] }), true, select ? panels.map((p) => p.id) : undefined),
        addFittings: (fittings, select = false) => transact((state) => ({ fittings: [...state.fittings, ...fittings] }), true, select ? fittings.map((p) => p.id) : undefined),
        addEquipment: (equipment) => transact((state) => ({ equipment: [...state.equipment, equipment] }), true, [equipment.id]),
        updateEquipment: (id, updates) => edit({ equipment: [{ id, updates }] }),
        updateFitting: (id, updates, history = true) => edit({ fittings: [{ id, updates }] }, history),
        updatePanel: (id, updates) => edit({ panels: [{ id, updates }] }, false),
        commitPanelEdit: (id, updates) => edit({ panels: [{ id, updates }] }),
        // Opening is a viewing action, independent of design locks, bindings and history.
        setFittingOpenings: (ids, open) => set((state) => {
          if (!Number.isFinite(open)) return state
          const selected = new Set(ids), value = Math.max(0, Math.min(1, open))
          const fittings = state.fittings.map((f) => selected.has(f.id) && f.open !== value ? { ...f, open: value } : f)
          return fittings.some((f, i) => f !== state.fittings[i]) ? { fittings } : state
        }),
        loadDocument: (doc) => {
          const checked = parseProjectDocument(doc)
          set((state) => ({ ...checked, past: [...state.past.slice(-(MAX_HISTORY - 1)), takeSnapshot(state)], future: [], selectedIds: [] }))
        },
        removeProfile: (id) => transact((state) => state.profiles.some((p) => p.id === id && !p.locked)
          ? { profiles: withFixedProfileCuts(state.profiles, undefined, state.throughRule).filter((p) => p.id !== id) } : {}, true,
          (state, doc) => survivingSelection(state.selectedIds, doc)),
        removeSelected: () => transact((state) => {
          const ids = new Set(state.selectedIds), removable = (p: { id: string; locked?: boolean }) => ids.has(p.id) && !p.locked
          const profiles = state.profiles.some(removable) ? withFixedProfileCuts(state.profiles, undefined, state.throughRule) : state.profiles
          return { profiles: profiles.filter((p) => !removable(p)), connectors: state.connectors.filter((p) => !removable(p)),
            panels: state.panels.filter((p) => !removable(p)), fittings: state.fittings.filter((p) => !removable(p)),
            equipment: state.equipment.filter((p) => !removable(p)) }
        }, true, (state, doc) => survivingSelection(state.selectedIds, doc)),
        toggleLockSelected: () => transact((state) => {
          const ids = new Set(state.selectedIds)
          const locked = partKinds.some((kind) => state[kind].some((p) => ids.has(p.id) && !p.locked))
          const profiles = locked && state.profiles.some((p) => ids.has(p.id)) ? withFixedProfileCuts(state.profiles, undefined, state.throughRule) : state.profiles
          return { profiles: profiles.map((p) => ids.has(p.id) ? { ...p, locked } : p),
            connectors: state.connectors.map((p) => ids.has(p.id) ? { ...p, locked } : p),
            panels: state.panels.map((p) => ids.has(p.id) ? { ...p, locked } : p), fittings: state.fittings.map((p) => ids.has(p.id) ? { ...p, locked } : p),
            equipment: state.equipment.map((p) => ids.has(p.id) ? { ...p, locked } : p) }
        }),
        clearAll: () => transact(() => ({ profiles: [], connectors: [], panels: [], fittings: [], equipment: [] }), true, []),
        addConnector: (connector) => transact((state) => ({ connectors: [...state.connectors, connector] })),
        removeConnector: (id) => transact((state) => ({ connectors: state.connectors.filter((c) => c.id !== id || c.locked) }), true, (state, doc) => survivingSelection(state.selectedIds, doc)),
        removeConnectors: (ids, history = true) => transact((state) => ({ connectors: state.connectors.filter((c) => !ids.includes(c.id) || c.locked) }), history, (state, doc) => survivingSelection(state.selectedIds, doc)),
        selectItem: (id, multi = false) => set((state) => ({ selectedIds: multi ? state.selectedIds.includes(id) ? state.selectedIds.filter((v) => v !== id) : [...state.selectedIds, id] : [id] })),
        selectItems: (selectedIds) => set({ selectedIds }), clearSelection: () => set({ selectedIds: [] }),
        selectProfile: (id) => set({ selectedIds: id ? [id] : [] }),
        updateProfile: (id, updates, options) => edit({ profiles: [{ id, updates }] }, options?.history ?? false),
        updateProfiles: (profiles, options) => edit({ profiles }, options?.history ?? false),
        commitProfileEdit: (id, updates) => edit({ profiles: [{ id, updates }] }),
        commitProfilesEdit: (profiles) => edit({ profiles }),
        commitTransform: (updates) => edit(updates),
        updateParts: (updates, options) => edit(updates, options?.history ?? false),
        updateConnector: (id, updates) => edit({ connectors: [{ id, updates }] }, false),
        snapshotHistory: () => set((state) => ({ past: [...state.past.slice(-(MAX_HISTORY - 1)), takeSnapshot(state)], future: [] })),
        undo: () => set((state) => {
          if (!state.past.length) return state
          const prev = state.past[state.past.length - 1]
          return { ...prev, panels: prev.panels ?? [], fittings: prev.fittings ?? [], equipment: prev.equipment ?? [], throughRule: prev.throughRule ?? 'rails',
            past: state.past.slice(0, -1), future: [takeSnapshot(state), ...state.future.slice(0, MAX_HISTORY - 1)], selectedIds: survivingSelection(state.selectedIds, prev) }
        }),
        redo: () => set((state) => {
          if (!state.future.length) return state
          const next = state.future[0]
          return { ...next, panels: next.panels ?? [], fittings: next.fittings ?? [], equipment: next.equipment ?? [], throughRule: next.throughRule ?? 'rails',
            past: [...state.past.slice(-(MAX_HISTORY - 1)), takeSnapshot(state)], future: state.future.slice(1), selectedIds: survivingSelection(state.selectedIds, next) }
        }),
      }
    },
    {
      name: 'aluminum-designer-store', storage: documentStorage,
      partialize: (state) => ({ version: PROJECT_VERSION, profiles: state.profiles, connectors: state.connectors, panels: state.panels, fittings: state.fittings, equipment: state.equipment, throughRule: state.throughRule }),
    },
  ),
)

// The compatibility geometry API reads this rule. Synchronize before scene/log subscribers
// run; the document owns it, including hydration, import, undo and redo.
applyThroughRule(useStore.getState().throughRule)
useStore.subscribe((state, previous) => {
  if (state.throughRule !== previous.throughRule) applyThroughRule(state.throughRule)
})
