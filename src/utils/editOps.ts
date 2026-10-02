import * as THREE from 'three'
import { noteNext } from './opLog'
import { useStore, type ConnectorData, type FittingData, type PanelData, type ProfileData, type ProfileSpec } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { closestOnSegment, getProfileEndpoints } from './geometryCore'
import { createTrimResolver, getProfileAxis, getProfileDir, withFixedProfileCuts, validFixedProfileCut } from './jointUtils'
import { profileBodyEndpoints } from './profileFaces'
import { analyzeFrame } from './analysis'
import { buildProfile, floorY, lowestPointY, nextId } from './profileFactory'
import { translations } from './translations'
import { fittingObb } from './fittingGeometry'
import { ALL_SPECS } from './specUtils'
import { connectorEntry } from './connectorCatalog'
import { MIN_FITTING_OPENING, validFitting } from './fittingValidation'

export type RotAxis = 'x' | 'y' | 'z'
const AXES: Record<RotAxis, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
}

function t() { return translations[useToolStore.getState().language] }
function toast(msg: string, kind: 'error' | 'info' | 'success' = 'error') { useToolStore.getState().showToast(msg, kind) }
const round3 = (v: number) => { const r = Math.round(v * 1000) / 1000; return r === 0 ? 0 : r }

// Locked parts stay in the selection — they can still be inspected, copied and used as a
// snapping reference — but every operation that would move them skips them.
function selectedProfiles(includeLocked = false): ProfileData[] {
  const { profiles, selectedIds } = useStore.getState()
  const ids = new Set(selectedIds)
  return profiles.filter((p) => ids.has(p.id) && (includeLocked || !p.locked))
}

/** A copy has the source's physical length even when copied away from its neighbours. */
function fixedSelectedProfiles(): ProfileData[] {
  const { profiles, selectedIds } = useStore.getState()
  const ids = new Set(selectedIds)
  return withFixedProfileCuts(profiles).filter((p) => ids.has(p.id))
}

/** A connector stays fixed on its own, and travels with an explicitly selected assembly. */
function selectedConnectors(includeLocked = false, includeStandalone = false): ConnectorData[] {
  const { connectors, selectedIds } = useStore.getState()
  if (!includeStandalone && selectedIds.length < 2) return []
  const ids = new Set(selectedIds)
  return connectors.filter((c) => ids.has(c.id) && (includeLocked || !c.locked))
}

/** A drawer or a door moves, turns, is mirrored and copied like any other part */
function selectedFittings(includeLocked = false): FittingData[] {
  const { fittings, selectedIds } = useStore.getState()
  const ids = new Set(selectedIds)
  return fittings.filter((f) => ids.has(f.id) && (includeLocked || !f.locked))
}

function selectedPanels(includeLocked = false): PanelData[] {
  const { panels, selectedIds } = useStore.getState()
  const ids = new Set(selectedIds)
  return panels.filter((p) => ids.has(p.id) && (includeLocked || !p.locked))
}

type PartDocument = Pick<ReturnType<typeof useStore.getState>, 'profiles' | 'connectors' | 'panels' | 'fittings'>

/** Shared by the properties panel and the quick menu; empty or stale selections are unlocked. */
export function selectionLocked(doc: PartDocument, ids: string[]): boolean {
  const selected = new Set(ids)
  const parts = [...doc.profiles, ...doc.connectors, ...doc.panels, ...doc.fittings]
    .filter((part) => selected.has(part.id))
  return parts.length > 0 && parts.every((part) => part.locked)
}

/** Add every kind of part and select the whole copy in one document transaction. */
function addCopies(copies: PartDocument): void {
  const store = useStore.getState()
  const ids = [...copies.profiles, ...copies.connectors, ...copies.panels, ...copies.fittings].map((part) => part.id)
  store.commitDocument({
    profiles: [...(copies.profiles.length ? withFixedProfileCuts(store.profiles) : store.profiles), ...copies.profiles],
    connectors: [...store.connectors, ...copies.connectors],
    panels: [...store.panels, ...copies.panels],
    fittings: [...store.fittings, ...copies.fittings],
  }, ids)
}

/** Shift a part's centre by a world delta, rounded the way everything else is */
const shifted = (pos: [number, number, number], d: THREE.Vector3): [number, number, number] =>
  [round3(pos[0] + d.x), round3(pos[1] + d.y), round3(pos[2] + d.z)]

/** Report newly introduced interference pairs after an edit; existing pairs are excluded. */
function warnIfNewConflicts(before: Set<string>): void {
  const after = conflictPairsNow()
  for (const key of after) {
    if (!before.has(key)) { toast(t().toastConflictAdded, 'error'); return }
  }
}

function conflictPairsNow(): Set<string> {
  const st = useStore.getState()
  const { conflicts } = analyzeFrame(st.profiles, st.connectors, st.panels, st.fittings)
  return new Set(conflicts.map((c) => [c.a, c.b].sort().join('|')))
}

/** Apply edited profiles (same ids) as one undoable step */
function applyProfiles(cands: ProfileData[]): boolean {
  if (cands.length === 0) return false
  if (cands.some((c) => c.locked)) { toast(t().toastLocked); return false }
  const fixed = new Map(withFixedProfileCuts(useStore.getState().profiles).map((p) => [p.id, p]))
  if (cands.some((c) => !validFixedProfileCut({ ...fixed.get(c.id)!, ...c }))) {
    toast(t().toastTooShort); return false
  }
  const before = conflictPairsNow()
  useStore.getState().commitProfilesEdit(cands.map((c) => ({ id: c.id, updates: c })))
  warnIfNewConflicts(before)
  return true
}

/** How far a moved set of members would sink below the floor (0 when clear) */
function sinkBelowFloor(profiles: ProfileData[], delta: [number, number, number]): number {
  let sink = 0
  for (const p of profiles) {
    const moved: [number, number, number] = [p.position[0] + delta[0], p.position[1] + delta[1], p.position[2] + delta[2]]
    sink = Math.min(sink, lowestPointY({ ...p, position: moved }))
  }
  return sink
}

/** Move the selection by a world-space delta (mm), applying the floor limit to the whole group. */
export function nudgeSelected(delta: [number, number, number]): boolean {
  const profiles = selectedProfiles()
  const connectors = selectedConnectors()
  const panels = selectedPanels()
  const fittings = selectedFittings()
  if (profiles.length === 0 && connectors.length === 0 && panels.length === 0 && fittings.length === 0) return false

  const d: [number, number, number] = [...delta]
  const sink = sinkBelowFloor(profiles, d)
  if (sink < 0) d[1] -= sink
  if (d.every((v) => Math.abs(v) < 1e-6)) return false   // fully clamped: no move, no history entry

  noteNext('nudge')
  const before = conflictPairsNow()
  useStore.getState().commitTransform({
    profiles: profiles.map((p) => ({
      id: p.id,
      updates: { position: [round3(p.position[0] + d[0]), round3(p.position[1] + d[1]), round3(p.position[2] + d[2])] as [number, number, number] },
    })),
    connectors: connectors.map((c) => ({
      id: c.id,
      updates: { position: [round3(c.position[0] + d[0]), round3(c.position[1] + d[1]), round3(c.position[2] + d[2])] as [number, number, number] },
    })),
    panels: panels.map((p) => ({
      id: p.id,
      updates: { position: [round3(p.position[0] + d[0]), round3(p.position[1] + d[1]), round3(p.position[2] + d[2])] as [number, number, number] },
    })),
    fittings: fittings.map((f) => ({
      id: f.id,
      updates: { position: [round3(f.position[0] + d[0]), round3(f.position[1] + d[1]), round3(f.position[2] + d[2])] as [number, number, number] },
    })),
  })
  warnIfNewConflicts(before)
  return true
}

/** Duplicate all selected parts, including locked references, and select the unlocked copies. */
export function duplicateSelected(): boolean {
  const profiles = fixedSelectedProfiles()
  const connectors = selectedConnectors(true, true)
  const panels = selectedPanels(true)
  const fittings = selectedFittings(true)
  if (profiles.length === 0 && connectors.length === 0 && panels.length === 0 && fittings.length === 0) return false
  noteNext('duplicate')
  const axis = profiles[0] ? getProfileAxis(profiles[0]) : 'y'
  const d: [number, number, number] = axis === 'x' ? [0, 0, 50] : [50, 0, 0]
  const before = conflictPairsNow()
  const newProfiles = profiles.map((p) => ({
    ...p, id: nextId('p'), locked: false,
    position: [p.position[0] + d[0], p.position[1] + d[1], p.position[2] + d[2]] as [number, number, number],
  }))
  const newConnectors = connectors.map((c) => ({
    ...c, id: nextId('c'), locked: false,
    position: [c.position[0] + d[0], c.position[1] + d[1], c.position[2] + d[2]] as [number, number, number],
  }))
  const newPanels = panels.map((p) => ({
    ...p, id: nextId('b'), locked: false,
    position: [p.position[0] + d[0], p.position[1] + d[1], p.position[2] + d[2]] as [number, number, number],
  }))
  const newFittings = fittings.map((f) => ({
    ...f, id: nextId('f'), locked: false,
    position: [f.position[0] + d[0], f.position[1] + d[1], f.position[2] + d[2]] as [number, number, number],
  }))
  addCopies({ profiles: newProfiles, connectors: newConnectors, panels: newPanels, fittings: newFittings })
  toast(t().toastDuplicated(newProfiles.length + newConnectors.length + newPanels.length + newFittings.length), 'success')
  warnIfNewConflicts(before)
  return true
}

/** Centre of everything in the document, which is the plane a mirror reflects across */
function documentCentre(): THREE.Vector3 {
  const { profiles, connectors, panels, fittings } = useStore.getState()
  const min = new THREE.Vector3(Infinity, Infinity, Infinity)
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
  const add = (v: THREE.Vector3) => { min.min(v); max.max(v) }
  for (const p of profiles) { const { start, end } = getProfileEndpoints(p); add(start); add(end) }
  for (const c of connectors) add(new THREE.Vector3(...c.position))
  for (const b of panels) add(new THREE.Vector3(...b.position))
  for (const f of fittings) add(new THREE.Vector3(...f.position))
  if (!isFinite(min.x)) return new THREE.Vector3()
  return min.add(max).multiplyScalar(0.5)
}

/** A world reflection plus one local reflection produces a right-handed orientation. */
function reflectedQuaternion(
  quaternion: [number, number, number, number], axis: RotAxis,
  symmetry: RotAxis | 'swapXY' = 'x',
): [number, number, number, number] {
  const q = new THREE.Quaternion(...quaternion).normalize()
  const reflect = (v: THREE.Vector3) => { v[axis] *= -1; return v }
  const basis = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]
    .map((v) => reflect(v.applyQuaternion(q)))
  if (symmetry === 'swapXY') [basis[0], basis[1]] = [basis[1], basis[0]]
  else basis[{ x: 0, y: 1, z: 2 }[symmetry]].negate()
  const reflected = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(basis[0], basis[1], basis[2])).normalize()
  return [reflected.x, reflected.y, reflected.z, reflected.w]
}

/** Each connector uses a symmetry of its actual model, so its arms and mounting face survive. */
function connectorSymmetry(type: string): RotAxis | 'swapXY' {
  if (type === 'corner-3way') return 'swapXY'
  if (type === 'bracket' || type === 'inside-corner' || type === 'gusset') return 'z'
  if (type === 'hinge') return 'y'
  return 'x'
}

/**
 * Mirror the selection across the plane through the centre of the whole frame.
 *
 * The plane is the frame's, not the selection's: building a cabinet means drawing one side
 * and mirroring it to get the other, and a plane through the selection's own centre would
 * only drop the copy back on top of it. With everything selected the two coincide, which
 * turns the gesture into flipping the whole frame — also a reasonable reading.
 *
 * The local X reflection preserves rectangular sections and slabs; doors swap their hung
 * edge so their leaf and opening motion are reflected too.
 */
export function mirrorSelected(axis: RotAxis = 'x'): boolean {
  const profiles = fixedSelectedProfiles()
  const connectors = selectedConnectors(true, true)
  const panels = selectedPanels(true)
  const fittings = selectedFittings(true)
  if (profiles.length === 0 && connectors.length === 0 && panels.length === 0 && fittings.length === 0) return false
  noteNext(`mirror ${axis.toUpperCase()}`)

  const centre = documentCentre()
  const k = { x: 0, y: 1, z: 2 }[axis] as 0 | 1 | 2
  const c = [centre.x, centre.y, centre.z][k]
  const flip = (v: THREE.Vector3) => {
    const out = v.clone()
    if (k === 0) out.x = 2 * c - v.x
    else if (k === 1) out.y = 2 * c - v.y
    else out.z = 2 * c - v.z
    return out
  }

  const before = conflictPairsNow()
  const positionAt = (position: [number, number, number]): [number, number, number] => {
    const at = flip(new THREE.Vector3(...position))
    return [round3(at.x), round3(at.y), round3(at.z)]
  }
  const copies: ProfileData[] = profiles.map((p) => ({
    ...p, id: nextId('p'), locked: false, position: positionAt(p.position),
    quaternion: reflectedQuaternion(p.quaternion, axis),
    holes: p.holes.map((hole) => ({ ...hole, position: [-hole.position[0], hole.position[1], hole.position[2]] })),
  }))
  const connectorCopies: ConnectorData[] = connectors.map((c2) => {
    return { ...c2, id: nextId('c'), locked: false, position: positionAt(c2.position),
      quaternion: reflectedQuaternion(c2.quaternion, axis, connectorSymmetry(c2.type)) }
  })
  const panelCopies: PanelData[] = panels.map((b) => {
    return { ...b, id: nextId('b'), locked: false, position: positionAt(b.position),
      quaternion: reflectedQuaternion(b.quaternion, axis) }
  })
  const fittingCopies: FittingData[] = fittings.map((f) => {
    const hinge = f.hinge ?? 'left'
    return { ...f, id: nextId('f'), locked: false, position: positionAt(f.position),
      quaternion: reflectedQuaternion(f.quaternion, axis),
      ...(f.kind === 'door' ? { hinge: hinge === 'left' ? 'right' : hinge === 'right' ? 'left' : hinge } : {}),
      ...(f.meeting ? { meeting: f.meeting === 'left' ? 'right' : 'left' } : {}),
    }
  })
  addCopies({ profiles: copies, connectors: connectorCopies, panels: panelCopies, fittings: fittingCopies })
  toast(t().toastMirrored(copies.length + connectorCopies.length + panelCopies.length + fittingCopies.length), 'success')
  warnIfNewConflicts(before)
  return true
}

/** Repeat the selection along a world axis with the specified count and spacing in millimetres. */
export function arraySelected(axis: RotAxis, count: number, spacing: number): boolean {
  const profiles = fixedSelectedProfiles()
  const connectors = selectedConnectors(true, true)
  const panels = selectedPanels(true)
  const fittings = selectedFittings(true)
  if (profiles.length === 0 && connectors.length === 0 && panels.length === 0 && fittings.length === 0) return false
  if (!isFinite(count) || count < 1 || !isFinite(spacing) || Math.abs(spacing) < 1) return false
  const n = Math.min(Math.floor(count), 50)   // a slip of the keyboard must not make 5000 parts
  noteNext(`array ${axis.toUpperCase()} ×${n} @${spacing}`)

  const step = new THREE.Vector3(
    axis === 'x' ? spacing : 0, axis === 'y' ? spacing : 0, axis === 'z' ? spacing : 0,
  )
  const before = conflictPairsNow()
  const copies: ProfileData[] = []
  const connectorCopies: ConnectorData[] = []
  const panelCopies: PanelData[] = []
  const fittingCopies: FittingData[] = []
  for (let i = 1; i <= n; i++) {
    const d = step.clone().multiplyScalar(i)
    for (const p of profiles) {
      copies.push({
        ...p, id: nextId('p'), locked: false,
        position: [round3(p.position[0] + d.x), round3(p.position[1] + d.y), round3(p.position[2] + d.z)],
      })
    }
    for (const c of connectors) {
      connectorCopies.push({
        ...c, id: nextId('c'), locked: false,
        position: [round3(c.position[0] + d.x), round3(c.position[1] + d.y), round3(c.position[2] + d.z)],
      })
    }
    for (const b of panels) panelCopies.push({ ...b, id: nextId('b'), locked: false, position: shifted(b.position, d) })
    for (const f of fittings) fittingCopies.push({ ...f, id: nextId('f'), locked: false, position: shifted(f.position, d) })
  }
  // the whole array is lifted as one, so the copies stay in line instead of being clamped apart
  const sink = sinkBelowFloor(copies, [0, 0, 0])
  if (sink < 0) {
    for (const p of copies) p.position = [p.position[0], round3(p.position[1] - sink), p.position[2]]
    for (const c of connectorCopies) c.position = [c.position[0], round3(c.position[1] - sink), c.position[2]]
    for (const b of panelCopies) b.position = [b.position[0], round3(b.position[1] - sink), b.position[2]]
    for (const f of fittingCopies) f.position = [f.position[0], round3(f.position[1] - sink), f.position[2]]
  }

  addCopies({ profiles: copies, connectors: connectorCopies, panels: panelCopies, fittings: fittingCopies })
  toast(t().toastArrayed(copies.length + connectorCopies.length + panelCopies.length + fittingCopies.length), 'success')
  warnIfNewConflicts(before)
  return true
}

/**
 * Where the selection turns about.
 *
 * The centre is the obvious default but rarely the useful one: a rail turned about its
 * middle throws both ends out and has to be dragged back. Frames are built from corners,
 * so turning about the end that is already joined leaves that joint alone. `start` and
 * `end` only mean something for a single member; anything else falls back to the centre.
 */
export type PivotMode = 'center' | 'start' | 'end'

export function selectionPivot(
  profiles: ProfileData[], connectors: ConnectorData[], mode: PivotMode = 'center',
  panels: PanelData[] = [], fittings: FittingData[] = [], allProfiles: ProfileData[] = profiles,
): THREE.Vector3 {
  // A construction endpoint can sit inside a joint, or short of its extended cap. The
  // widget and the turn use the visible solid, with unselected neighbours resolving any
  // automatic cuts. Finished pieces carry their own cuts and need no scene lookup.
  const resolve = profiles.some((p) => !p.fixedTrims) ? createTrimResolver(allProfiles) : null
  const ends = (p: ProfileData) => profileBodyEndpoints(p, p.fixedTrims ? undefined : resolve?.(p))
  if (mode !== 'center' && profiles.length === 1 && connectors.length === 0 && panels.length === 0 && fittings.length === 0) {
    const { start, end } = ends(profiles[0])
    return mode === 'start' ? start : end
  }
  const pts: THREE.Vector3[] = []
  for (const p of profiles) {
    const { start, end } = ends(p)
    pts.push(start, end)
  }
  for (const c of connectors) pts.push(new THREE.Vector3(...c.position))
  for (const b of panels) pts.push(new THREE.Vector3(...b.position))
  // Use fitting geometry when computing the rotation pivot.
  for (const f of fittings) pts.push(fittingObb(f).center)
  if (pts.length === 0) return new THREE.Vector3()
  const sum = pts.reduce((acc, v) => acc.add(v), new THREE.Vector3())
  return sum.divideScalar(pts.length)
}

/** True when `start`/`end` actually apply: one member, nothing else */
export function pivotApplies(profiles: ProfileData[], connectors: ConnectorData[]): boolean {
  return profiles.length === 1 && connectors.length === 0
}

/**
 * Rotate the whole selection by any angle about a world axis, around the selection centre.
 * Profiles and connectors alike — nothing is restricted to 90° steps or to the Y axis.
 */
export function rotateSelected(axis: RotAxis = 'y', degrees = 90): boolean {
  const { profiles: allProfiles, selectedIds } = useStore.getState()
  const ids = new Set(selectedIds)
  // Use the same physical cuts for the pivot, rotation and floor check. The transaction
  // fixes these cuts in the document; this preparation itself does not mutate the scene.
  const profiles = withFixedProfileCuts(allProfiles).filter((p) => ids.has(p.id) && !p.locked)
  const connectors = selectedConnectors()
  const panels = selectedPanels()
  const fittings = selectedFittings()
  if (profiles.length === 0 && connectors.length === 0 && panels.length === 0 && fittings.length === 0) return false
  if (!isFinite(degrees) || degrees % 360 === 0) return false
  noteNext(`turn ${axis.toUpperCase()} ${degrees}°`)
  const pivot = selectionPivot(profiles, connectors, useToolStore.getState().pivotMode, panels, fittings, allProfiles)
  const rot = new THREE.Quaternion().setFromAxisAngle(AXES[axis], THREE.MathUtils.degToRad(degrees))
  const spin = (pos: [number, number, number], quat: [number, number, number, number]) => {
    const p = new THREE.Vector3(...pos).sub(pivot).applyQuaternion(rot).add(pivot)
    const q = rot.clone().multiply(new THREE.Quaternion(...quat)).normalize()
    return {
      position: [round3(p.x), round3(p.y), round3(p.z)] as [number, number, number],
      quaternion: [q.x, q.y, q.z, q.w] as [number, number, number, number],
    }
  }
  const spunProfiles = profiles.map((p) => ({ id: p.id, updates: spin(p.position, p.quaternion) }))
  const spunConnectors = connectors.map((c) => ({ id: c.id, updates: spin(c.position, c.quaternion) }))
  const spunPanels = panels.map((p) => ({ id: p.id, updates: spin(p.position, p.quaternion) }))
  const spunFittings = fittings.map((f) => ({ id: f.id, updates: spin(f.position, f.quaternion) }))

  // a turn must not bury the parts: lift the whole selection back onto the floor
  const rotated = profiles.map((p, i) => ({ ...p, ...spunProfiles[i].updates }))
  const sink = sinkBelowFloor(rotated, [0, 0, 0])
  if (sink < 0) {
    for (const u of spunProfiles) u.updates.position = [u.updates.position![0], round3(u.updates.position![1] - sink), u.updates.position![2]]
    for (const u of spunConnectors) u.updates.position = [u.updates.position![0], round3(u.updates.position![1] - sink), u.updates.position![2]]
    for (const u of spunPanels) u.updates.position = [u.updates.position![0], round3(u.updates.position![1] - sink), u.updates.position![2]]
    for (const u of spunFittings) u.updates.position = [u.updates.position![0], round3(u.updates.position![1] - sink), u.updates.position![2]]
  }

  const before = conflictPairsNow()
  useStore.getState().commitTransform({ profiles: spunProfiles, connectors: spunConnectors, panels: spunPanels, fittings: spunFittings })
  warnIfNewConflicts(before)
  return true
}

/**
 * Finish the move in progress at an exact distance.
 *
 * Dragging gets a part roughly where it belongs; frames are built to the millimetre. The
 * direction is the one the drag is already going — along the locked axis when a gizmo arrow
 * owns the drag, otherwise straight from where the part started to where it is now — so the
 * number only has to answer "how far", which is the part the mouse is bad at.
 */
export function commitExactMove(distance: number): boolean {
  const ts = useToolStore.getState()
  const store = useStore.getState()
  if (!ts.isDragging || !ts.dragMoved || !ts.dragProfileId) return false
  if (!isFinite(distance)) return false

  const origins = ts.dragGroupOrigins
  const leadOrigin = origins[ts.dragProfileId] ?? ts.dragOriginPos?.toArray() as [number, number, number] | undefined
  if (!leadOrigin) return false
  const lead = store.profiles.find((p) => p.id === ts.dragProfileId)
    ?? store.connectors.find((c) => c.id === ts.dragProfileId)
    ?? store.panels.find((b) => b.id === ts.dragProfileId)
    ?? store.fittings.find((f) => f.id === ts.dragProfileId)
  if (!lead || lead.locked) return false
  const movingIds = new Set(Object.keys(origins))
  movingIds.add(lead.id)
  if (store.connectors.some((c) => c.id === lead.id) && movingIds.size < 2) return false

  const travelled = new THREE.Vector3(...lead.position).sub(new THREE.Vector3(...leadOrigin))
  if (ts.dragAxis) {
    const keep = { x: 0, y: 1, z: 2 }[ts.dragAxis]
    travelled.set(keep === 0 ? travelled.x : 0, keep === 1 ? travelled.y : 0, keep === 2 ? travelled.z : 0)
  }
  if (travelled.length() < 0.5) { toast(t().toastNeedDirection, 'info'); return false }
  const delta = travelled.normalize().multiplyScalar(distance)

  const profiles = store.profiles.filter((p) => movingIds.has(p.id) && !p.locked)
  const sink = sinkBelowFloor(profiles.map((p) => ({ ...p, position: origins[p.id] ?? leadOrigin })), [delta.x, delta.y, delta.z])
  if (sink < 0) delta.y -= sink

  const at = (id: string, fallback: [number, number, number]): [number, number, number] => {
    const o = origins[id] ?? (id === lead.id ? leadOrigin : fallback)
    return [round3(o[0] + delta.x), round3(o[1] + delta.y), round3(o[2] + delta.z)]
  }
  store.updateParts({
    profiles: profiles.map((p) => ({ id: p.id, updates: { position: at(p.id, p.position) } })),
    connectors: store.connectors.filter((c) => movingIds.has(c.id) && !c.locked)
      .map((c) => ({ id: c.id, updates: { position: at(c.id, c.position) } })),
    panels: store.panels.filter((b) => movingIds.has(b.id) && !b.locked)
      .map((b) => ({ id: b.id, updates: { position: at(b.id, b.position) } })),
    fittings: store.fittings.filter((f) => movingIds.has(f.id) && !f.locked)
      .map((f) => ({ id: f.id, updates: { position: at(f.id, f.position) } })),
  })
  ts.stopDrag()
  return true
}

/** Finish at the physical length displayed by the handle, keeping the opposite cut face fixed. */
export function commitExactLength(length: number): boolean {
  const ts = useToolStore.getState()
  const rs = ts.resize
  if (!rs) return false
  const store = useStore.getState()
  const profile = store.profiles.find((p) => p.id === rs.id)
  if (!profile || profile.locked) return false
  if (!isFinite(length) || length < 10) { toast(t().toastTooShort); return false }
  const fixedProfile = withFixedProfileCuts(store.profiles).find((p) => p.id === profile.id)!
  const fixedTrims = { ...fixedProfile.fixedTrims! }
  const rawModelLength = round3(length + fixedTrims.start + fixedTrims.end)
  const modelLength = Math.max(10, rawModelLength)
  // A long extension must not impose an extra minimum on the requested physical
  // length. Keep the model span valid by adjusting only the end being stretched;
  // the opposite cut offset and its world face remain fixed.
  fixedTrims[rs.end] = round3(fixedTrims[rs.end] + modelLength - rawModelLength)
  if (!validFixedProfileCut({ length: modelLength, fixedTrims })) {
    toast(t().toastTooShort); return false
  }

  const dir = getProfileDir(profile)
  const origin = new THREE.Vector3(...rs.origin)
  const fixed = rs.end === 'start' ? origin.clone().addScaledVector(dir, rs.length) : origin.clone()
  const position: [number, number, number] = rs.end === 'start'
    ? [round3(fixed.x - dir.x * modelLength), round3(fixed.y - dir.y * modelLength), round3(fixed.z - dir.z * modelLength)]
    : [round3(fixed.x), round3(fixed.y), round3(fixed.z)]

  // the pointer may never have travelled, so this gesture may have no history entry yet
  const changed = modelLength !== profile.length || position.some((v, i) => v !== profile.position[i])
    || fixedTrims.start !== fixedProfile.fixedTrims!.start || fixedTrims.end !== fixedProfile.fixedTrims!.end
  if (changed) {
    if (!ts.dragMoved) store.snapshotHistory()
    store.updateProfile(rs.id, { length: modelLength, position, fixedTrims })
  }
  ts.stopResize()
  ts.setDragConflict(false)
  return true
}

/** Everything in the document, so Ctrl+A means what it means everywhere else */
export function selectAll(): boolean {
  const { profiles, connectors, panels, fittings, selectItems } = useStore.getState()
  const ids = [...profiles.map((p) => p.id), ...connectors.map((c) => c.id),
    ...panels.map((b) => b.id), ...fittings.map((f) => f.id)]
  if (ids.length === 0) return false
  selectItems(ids)
  return true
}

/** how close two members have to be to count as joined, for walking a sub-assembly (mm) */
const LINKED_TOL = 30

/** Find profiles reachable from the seed members through inferred joints. */
export function connectedTo(seed: string[], profiles: ProfileData[]): Set<string> {
  const ends = new Map(profiles.map((p) => [p.id, getProfileEndpoints(p)]))
  const joined = (a: string, b: string) => {
    const ea = ends.get(a), eb = ends.get(b)
    if (!ea || !eb) return false
    return [ea.start, ea.end].some((pt) => closestOnSegment(pt, eb.start, eb.end).point.distanceTo(pt) <= LINKED_TOL)
      || [eb.start, eb.end].some((pt) => closestOnSegment(pt, ea.start, ea.end).point.distanceTo(pt) <= LINKED_TOL)
  }
  const seen = new Set(seed.filter((id) => ends.has(id)))
  const queue = [...seen]
  while (queue.length) {
    const cur = queue.shift()!
    for (const p of profiles) {
      if (seen.has(p.id) || !joined(cur, p.id)) continue
      seen.add(p.id)
      queue.push(p.id)
    }
  }
  return seen
}

export function selectConnected(id: string): boolean {
  const { profiles, selectItems } = useStore.getState()
  if (!profiles.some((p) => p.id === id)) return false
  selectItems([...connectedTo([id], profiles)])
  return true
}

/** Reverse a member's direction (swap its start and end) */
export function flipProfile(id: string): boolean {
  const p = withFixedProfileCuts(useStore.getState().profiles).find((q) => q.id === id)
  if (!p) return false
  const { end } = getProfileEndpoints(p)
  const q = new THREE.Quaternion(...p.quaternion)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)).normalize()
  return applyProfiles([{ ...p, position: [round3(end.x), round3(end.y), round3(end.z)], quaternion: [q.x, q.y, q.z, q.w],
    fixedTrims: { start: p.fixedTrims!.end, end: p.fixedTrims!.start } }])
}

export function setProfileLength(id: string, length: number): boolean {
  const p = useStore.getState().profiles.find((q) => q.id === id)
  if (!p) return false
  if (!isFinite(length) || length < 10) { toast(t().toastTooShort); return false }
  return applyProfiles([{ ...p, length: Math.round(length * 100) / 100 }])
}

export function setProfilePosition(id: string, position: [number, number, number]): boolean {
  const p = useStore.getState().profiles.find((q) => q.id === id)
  if (!p) return false
  if (position.some((v) => !isFinite(v))) return false
  return applyProfiles([{ ...p, position: position.map(round3) as [number, number, number] }])
}

/**
 * Move a member's far endpoint while keeping its start fixed.
 * Each coordinate commits independently; zero-length results are rejected.
 */
export function setProfileEnd(id: string, end: [number, number, number]): boolean {
  const p = useStore.getState().profiles.find((q) => q.id === id)
  if (!p) return false
  if (p.locked) { toast(t().toastLocked); return false }
  if (end.some((v) => !isFinite(v))) return false
  const { start } = getProfileEndpoints(p)
  const target = new THREE.Vector3(...end)
  const rebuilt = buildProfile(start, target, p.spec)
  if (!rebuilt) { toast(t().toastTooShort); return false }
  return applyProfiles([{ ...p, length: rebuilt.length, position: rebuilt.position, quaternion: rebuilt.quaternion }])
}

export function setProfileSpec(id: string, spec: ProfileSpec): boolean {
  const p = useStore.getState().profiles.find((q) => q.id === id)
  if (!p) return false
  const cand = { ...p, spec }
  if (getProfileAxis(cand) === 'x' || getProfileAxis(cand) === 'z') {
    cand.position = [cand.position[0], Math.max(cand.position[1], floorY(spec)), cand.position[2]]
  }
  return applyProfiles([cand])
}

/** Change which extrusion series a connector is made for */
export function setConnectorSeries(id: string, series: 20 | 30 | 40): boolean {
  const c = useStore.getState().connectors.find((q) => q.id === id)
  if (!c || c.locked || ![20, 30, 40].includes(series)) return false
  useStore.getState().commitTransform({ connectors: [{ id, updates: { series } }] })
  return true
}

/** Direction label like "+X" for the properties panel; free rotations show the vector */
export function directionLabel(p: ProfileData): string {
  const d = getProfileDir(p)
  const axis = getProfileAxis(p)
  if (axis) return `${d[axis] >= 0 ? '+' : '−'}${axis.toUpperCase()}`
  return `(${d.x.toFixed(2)}, ${d.y.toFixed(2)}, ${d.z.toFixed(2)})`
}

/** Read orientation as X/Y/Z degrees using YXZ Euler decomposition. */
export function orientationDegrees(quaternion: [number, number, number, number]): [number, number, number] {
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...quaternion).normalize(), 'YXZ')
  const deg = (r: number) => { const d = Math.round(THREE.MathUtils.radToDeg(r) * 10) / 10; return d === 0 ? 0 : d }
  return [deg(e.x), deg(e.y), deg(e.z)]
}


/**
 * Apply live edits without adding individual history entries.
 * beginLiveEdit supplies the snapshot used to undo the completed edit as one step.
 */
export function beginLiveEdit(): void {
  useStore.getState().snapshotHistory()
}

const PART_FIELDS = {
  profiles: ['spec', 'length', 'position', 'quaternion', 'miterCuts', 'holes'],
  connectors: ['type', 'series', 'position', 'quaternion'],
  panels: ['width', 'height', 'thickness', 'material', 'position', 'quaternion'],
  fittings: ['kind', 'width', 'height', 'depth', 'frame', 'material', 'open', 'hinge', 'hingeType', 'overlay', 'swing', 'meeting', 'stacked', 'drawer', 'position', 'quaternion'],
}

const finiteTuple = (value: unknown, length: number): value is number[] => Array.isArray(value)
  && value.length === length && value.every((v) => typeof v === 'number' && Number.isFinite(v))
const materialValid = (value: unknown) => ['mdf', 'ply', 'acrylic', 'alu'].includes(value as string)

/** Preview and final input use the same bounds, rounding and lock rules. */
function validLiveUpdates(kind: keyof PartDocument, part: { locked?: boolean }, updates: Record<string, unknown>): Record<string, unknown> | null {
  if (part.locked || Object.keys(updates).some((key) => !PART_FIELDS[kind].includes(key))) return null
  const next: Record<string, unknown> = { ...part, ...updates }
  const normalised = { ...updates }
  if ('position' in updates) {
    if (!finiteTuple(updates.position, 3)) return null
    normalised.position = updates.position.map(round3)
  }
  if ('quaternion' in updates) {
    if (!finiteTuple(updates.quaternion, 4) || Math.hypot(...updates.quaternion) < 1e-9) return null
    normalised.quaternion = new THREE.Quaternion(...updates.quaternion as [number, number, number, number]).normalize().toArray()
  }
  const numberField = (field: string, min: number, digits = 1, strict = false) => {
    const value = next[field]
    if (typeof value !== 'number' || !Number.isFinite(value) || (strict ? value <= min : value < min)) return false
    if (field in updates) {
      const scale = 10 ** digits
      const rounded = Math.round(value * scale) / scale
      if (!Number.isFinite(rounded) || (strict ? rounded <= min : rounded < min)) return false
      normalised[field] = rounded
    }
    return true
  }
  if (kind === 'profiles') {
    if (!numberField('length', 10, 2) || !ALL_SPECS.includes(next.spec as ProfileSpec)) return null
    if ('holes' in updates && (!Array.isArray(updates.holes) || updates.holes.some((hole) =>
      !hole || typeof hole.id !== 'string' || !finiteTuple(hole.position, 3)
      || typeof hole.diameter !== 'number' || !Number.isFinite(hole.diameter) || hole.diameter <= 0))) return null
    if ('miterCuts' in updates && (!Array.isArray(updates.miterCuts) || updates.miterCuts.some((cut) =>
      !cut || !['start', 'end'].includes(cut.side) || typeof cut.angle !== 'number' || !Number.isFinite(cut.angle)))) return null
  } else if (kind === 'connectors') {
    if (!connectorEntry(next.type as string) || ![20, 30, 40].includes((next.series ?? 20) as number)) return null
  } else if (kind === 'panels') {
    if (!numberField('width', 20) || !numberField('height', 20) || !numberField('thickness', 0, 1, true) || !materialValid(next.material)) return null
  } else {
    if (!['width', 'height', 'depth'].every((field) => numberField(field, MIN_FITTING_OPENING))) return null
    if ('frame' in updates && !numberField('frame', 0)) return null
    if ('open' in updates && (!numberField('open', 0, 3) || (next.open as number) > 1)) return null
    if ('swing' in updates && (!numberField('swing', 0, 3, true) || (next.swing as number) > 180)) return null
    if (!validFitting({ ...part, ...normalised })) return null
  }
  const changed = Object.entries(normalised).some(([key, value]) => JSON.stringify((part as Record<string, unknown>)[key]) !== JSON.stringify(value))
  return changed ? normalised : {}
}

/** Apply one valid preview to all selected targets; take history only on its first real change. */
export function liveParts(ids: string[], updates: Record<string, unknown>, pushHistory = false): boolean {
  const store = useStore.getState()
  const selected = new Set(ids)
  const edits: Parameters<typeof store.updateParts>[0] = {}
  for (const kind of Object.keys(PART_FIELDS) as Array<keyof PartDocument>) {
    const changes: Array<{ id: string; updates: Record<string, unknown> }> = []
    for (const part of store[kind]) {
      if (!selected.has(part.id) || part.locked) continue
      const validated = validLiveUpdates(kind, part, updates)
      if (!validated) {
        if (kind === 'fittings') toast(t().toastInvalidFittingGeometry)
        return false
      }
      if (Object.keys(validated).length) changes.push({ id: part.id, updates: validated })
    }
    if (changes.length) edits[kind] = changes
  }
  if (Object.keys(edits).length === 0) return false
  if (edits.profiles?.length) {
    const fixed = new Map(withFixedProfileCuts(store.profiles).map((p) => [p.id, p]))
    if (edits.profiles.some(({ id, updates }) => !validFixedProfileCut({ ...fixed.get(id)!, ...updates }))) {
      toast(t().toastTooShort); return false
    }
  }
  if (pushHistory) store.snapshotHistory()
  store.updateParts(edits)
  return true
}

export function livePart(id: string, updates: Record<string, unknown>, pushHistory = false): boolean {
  return liveParts([id], updates, pushHistory)
}
