import * as THREE from 'three'
import { noteNext } from './opLog'
import { useStore, type ConnectorData, type FittingData, type PanelData, type ProfileData, type ProfileSpec } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { closestOnSegment, getProfileEndpoints } from './geometryCore'
import { getProfileAxis, getProfileDir } from './jointUtils'
import { analyzeFrame } from './analysis'
import { buildProfile, floorY, lowestPointY, nextId } from './profileFactory'
import { translations } from './translations'

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

/**
 * Connectors are never transformed, so this is always empty.
 *
 * Once two members are aligned there is exactly one bracket that fits and exactly one way
 * it goes on: astride the joint, on the face the two share. Moving or turning it can only
 * make it wrong, and a wrong bracket is worse than a missing one because it still looks
 * fitted. So a connector can be placed and it can be deleted, and that is the whole set.
 * The signature is kept so the transforms keep reading as "and the connectors" — they just
 * never get any.
 */
function selectedConnectors(_includeLocked = false): ConnectorData[] {
  return []
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

/** Shift a part's centre by a world delta, rounded the way everything else is */
const shifted = (pos: [number, number, number], d: THREE.Vector3): [number, number, number] =>
  [round3(pos[0] + d.x), round3(pos[1] + d.y), round3(pos[2] + d.z)]

/**
 * Interference is allowed: edits always go through and the affected members are flagged
 * in red instead. This reports newly created conflicts so the user notices them.
 * Pairs are compared, not ids — a new conflict between two already-flagged members counts.
 */
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

/**
 * Move the selection by a world-space delta (mm). The floor limits the move as a whole,
 * so a group keeps its shape instead of individual members being clamped out of line.
 */
export function nudgeSelected(delta: [number, number, number]): boolean {
  noteNext('nudge')
  const profiles = selectedProfiles()
  const connectors = selectedConnectors()
  const panels = selectedPanels()
  const fittings = selectedFittings()
  if (profiles.length === 0 && connectors.length === 0 && panels.length === 0 && fittings.length === 0) return false

  const d: [number, number, number] = [...delta]
  const sink = sinkBelowFloor(profiles, d)
  if (sink < 0) d[1] -= sink
  if (d.every((v) => Math.abs(v) < 1e-6)) return false   // fully clamped: no move, no history entry

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

/** Duplicate the selection (profiles and connectors) and select the copies */
export function duplicateSelected(): boolean {
  noteNext('duplicate')
  const profiles = selectedProfiles(true)
  const connectors = selectedConnectors(true)
  const panels = selectedPanels(true)
  if (profiles.length === 0 && connectors.length === 0 && panels.length === 0) return false
  const axis = profiles[0] ? getProfileAxis(profiles[0]) : 'y'
  const d: [number, number, number] = axis === 'x' ? [0, 0, 50] : [50, 0, 0]
  const before = conflictPairsNow()
  const store = useStore.getState()
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
  store.addItems(newProfiles, newConnectors, true)
  if (newPanels.length) store.addPanels(newPanels, false)
  toast(t().toastDuplicated(newProfiles.length + newConnectors.length + newPanels.length), 'success')
  warnIfNewConflicts(before)
  return true
}

/** Centre of everything in the document, which is the plane a mirror reflects across */
function documentCentre(): THREE.Vector3 {
  const { profiles, connectors } = useStore.getState()
  const min = new THREE.Vector3(Infinity, Infinity, Infinity)
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
  const add = (v: THREE.Vector3) => { min.min(v); max.max(v) }
  for (const p of profiles) { const { start, end } = getProfileEndpoints(p); add(start); add(end) }
  for (const c of connectors) add(new THREE.Vector3(...c.position))
  for (const b of useStore.getState().panels) add(new THREE.Vector3(...b.position))
  if (!isFinite(min.x)) return new THREE.Vector3()
  return min.add(max).multiplyScalar(0.5)
}

/**
 * Mirror the selection across the plane through the centre of the whole frame.
 *
 * The plane is the frame's, not the selection's: building a cabinet means drawing one side
 * and mirroring it to get the other, and a plane through the selection's own centre would
 * only drop the copy back on top of it. With everything selected the two coincide, which
 * turns the gesture into flipping the whole frame — also a reasonable reading.
 *
 * A reflection is not a rotation, so members are rebuilt from their reflected endpoints
 * rather than having their quaternion flipped; the sections are symmetric, nothing is lost.
 */
export function mirrorSelected(axis: RotAxis = 'x'): boolean {
  noteNext(`mirror ${axis.toUpperCase()}`)
  const profiles = selectedProfiles(true)
  const connectors = selectedConnectors(true)
  const panels = selectedPanels(true)
  if (profiles.length === 0 && connectors.length === 0 && panels.length === 0) return false

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
  const copies: ProfileData[] = []
  for (const p of profiles) {
    const { start, end } = getProfileEndpoints(p)
    const built = buildProfile(flip(start), flip(end), p.spec)
    if (built) copies.push({ ...built, miterCuts: p.miterCuts, holes: p.holes })
  }
  // A connector's own orientation cannot be mirrored without turning it inside out, so the
  // copy is placed mirrored and left facing the way the original does; a quarter turn in
  // the panel fixes the rare case where that is wrong.
  const connectorCopies: ConnectorData[] = connectors.map((c2) => {
    const at = flip(new THREE.Vector3(...c2.position))
    return { ...c2, id: nextId('c'), locked: false, position: [round3(at.x), round3(at.y), round3(at.z)] as [number, number, number] }
  })
  const panelCopies: PanelData[] = panels.map((b) => {
    const at = flip(new THREE.Vector3(...b.position))
    return { ...b, id: nextId('b'), locked: false, position: [round3(at.x), round3(at.y), round3(at.z)] as [number, number, number] }
  })
  if (copies.length === 0 && connectorCopies.length === 0 && panelCopies.length === 0) return false

  useStore.getState().addItems(copies, connectorCopies, true)
  if (panelCopies.length) useStore.getState().addPanels(panelCopies, false)
  toast(t().toastMirrored(copies.length + connectorCopies.length + panelCopies.length), 'success')
  warnIfNewConflicts(before)
  return true
}

/**
 * Repeat the selection along a world axis: `count` copies, `spacing` millimetres apart.
 * Shelves, uprights and drawer rails are all this move, and doing it by hand means placing
 * the same part five times and getting one of them wrong.
 */
export function arraySelected(axis: RotAxis, count: number, spacing: number): boolean {
  noteNext(`array ${axis.toUpperCase()} ×${count} @${spacing}`)
  const profiles = selectedProfiles(true)
  const connectors = selectedConnectors(true)
  const panels = selectedPanels(true)
  if (profiles.length === 0 && connectors.length === 0 && panels.length === 0) return false
  if (!isFinite(count) || count < 1 || !isFinite(spacing) || Math.abs(spacing) < 1) return false
  const n = Math.min(Math.floor(count), 50)   // a slip of the keyboard must not make 5000 parts

  const step = new THREE.Vector3(
    axis === 'x' ? spacing : 0, axis === 'y' ? spacing : 0, axis === 'z' ? spacing : 0,
  )
  const before = conflictPairsNow()
  const copies: ProfileData[] = []
  const connectorCopies: ConnectorData[] = []
  const panelCopies: PanelData[] = []
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
  }
  // the whole array is lifted as one, so the copies stay in line instead of being clamped apart
  const sink = sinkBelowFloor(copies, [0, 0, 0])
  if (sink < 0) {
    for (const p of copies) p.position = [p.position[0], round3(p.position[1] - sink), p.position[2]]
    for (const c of connectorCopies) c.position = [c.position[0], round3(c.position[1] - sink), c.position[2]]
    for (const b of panelCopies) b.position = [b.position[0], round3(b.position[1] - sink), b.position[2]]
  }

  useStore.getState().addItems(copies, connectorCopies, true)
  if (panelCopies.length) useStore.getState().addPanels(panelCopies, false)
  toast(t().toastArrayed(copies.length + connectorCopies.length + panelCopies.length), 'success')
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
): THREE.Vector3 {
  if (mode !== 'center' && profiles.length === 1 && connectors.length === 0) {
    const { start, end } = getProfileEndpoints(profiles[0])
    return mode === 'start' ? start : end
  }
  const pts: THREE.Vector3[] = []
  for (const p of profiles) {
    const { start, end } = getProfileEndpoints(p)
    pts.push(start, end)
  }
  for (const c of connectors) pts.push(new THREE.Vector3(...c.position))
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
  noteNext(`turn ${axis.toUpperCase()} ${degrees}°`)
  const profiles = selectedProfiles()
  const connectors = selectedConnectors()
  const panels = selectedPanels()
  const fittings = selectedFittings()
  if (profiles.length === 0 && connectors.length === 0 && panels.length === 0 && fittings.length === 0) return false
  if (!isFinite(degrees) || degrees % 360 === 0) return false
  const pivot = selectionPivot(profiles, connectors, useToolStore.getState().pivotMode)
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
  if (!lead) return false

  const travelled = new THREE.Vector3(...lead.position).sub(new THREE.Vector3(...leadOrigin))
  if (ts.dragAxis) {
    const keep = { x: 0, y: 1, z: 2 }[ts.dragAxis]
    travelled.set(keep === 0 ? travelled.x : 0, keep === 1 ? travelled.y : 0, keep === 2 ? travelled.z : 0)
  }
  if (travelled.length() < 0.5) { toast(t().toastNeedDirection, 'info'); return false }
  const delta = travelled.normalize().multiplyScalar(distance)

  const profiles = store.profiles.filter((p) => origins[p.id])
  const sink = sinkBelowFloor(profiles.map((p) => ({ ...p, position: origins[p.id] })), [delta.x, delta.y, delta.z])
  if (sink < 0) delta.y -= sink

  const at = (id: string, fallback: [number, number, number]): [number, number, number] => {
    const o = origins[id] ?? fallback
    return [round3(o[0] + delta.x), round3(o[1] + delta.y), round3(o[2] + delta.z)]
  }
  store.updateParts({
    profiles: profiles.map((p) => ({ id: p.id, updates: { position: at(p.id, p.position) } })),
    connectors: store.connectors.filter((c) => origins[c.id])
      .map((c) => ({ id: c.id, updates: { position: at(c.id, c.position) } })),
  })
  ts.stopDrag()
  return true
}

/** Finish the stretch in progress at an exact length, the fixed end staying put */
export function commitExactLength(length: number): boolean {
  const ts = useToolStore.getState()
  const rs = ts.resize
  if (!rs) return false
  const store = useStore.getState()
  const profile = store.profiles.find((p) => p.id === rs.id)
  if (!profile) return false
  if (!isFinite(length) || length < 10) { toast(t().toastTooShort); return false }

  const dir = getProfileDir(profile)
  const origin = new THREE.Vector3(...rs.origin)
  const fixed = rs.end === 'start' ? origin.clone().addScaledVector(dir, rs.length) : origin.clone()
  const position: [number, number, number] = rs.end === 'start'
    ? [round3(fixed.x - dir.x * length), round3(fixed.y - dir.y * length), round3(fixed.z - dir.z * length)]
    : [round3(fixed.x), round3(fixed.y), round3(fixed.z)]

  // the pointer may never have travelled, so this gesture may have no history entry yet
  if (!ts.dragMoved) store.snapshotHistory()
  store.updateProfile(rs.id, { length: Math.round(length * 100) / 100, position })
  ts.stopResize()
  ts.setDragConflict(false)
  return true
}

/** Everything in the document, so Ctrl+A means what it means everywhere else */
export function selectAll(): boolean {
  const { profiles, connectors, panels, selectItems } = useStore.getState()
  const ids = [...profiles.map((p) => p.id), ...connectors.map((c) => c.id), ...panels.map((b) => b.id)]
  if (ids.length === 0) return false
  selectItems(ids)
  return true
}

/** how close two members have to be to count as joined, for walking a sub-assembly (mm) */
const LINKED_TOL = 30

/**
 * The whole sub-assembly a member belongs to: everything reachable through its joints.
 *
 * A cabinet is not one part and it is not the whole drawing either. Double-clicking one rail
 * and getting the carcass it belongs to is the difference between moving a cabinet and
 * moving forty members one at a time.
 */
/**
 * Every member reachable from these through joints — one piece of furniture.
 *
 * "Which cabinet is this?" has no answer in a box query: two cabinets standing in a row are
 * one box, and asking what is behind a door found every cabinet in the room. What separates
 * them is that they are not bolted together.
 */
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
  const p = useStore.getState().profiles.find((q) => q.id === id)
  if (!p) return false
  const { end } = getProfileEndpoints(p)
  const q = new THREE.Quaternion(...p.quaternion)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)).normalize()
  return applyProfiles([{ ...p, position: [round3(end.x), round3(end.y), round3(end.z)], quaternion: [q.x, q.y, q.z, q.w] }])
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
 * Move a member's far end, keeping the start where it is.
 *
 * People think of a member as running from A to B; the model stores a start, a direction and
 * a length. Without this you have to do that conversion in your head every time a span
 * changes — work out the new length, type it, then check the direction did not flip.
 *
 * Each coordinate commits on its own, so a path that passes through a zero-length member is
 * refused rather than silently collapsing it: to swing a member onto another axis, give it
 * the new coordinate before clearing the old one.
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
  if (!c) return false
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

/**
 * Orientation in degrees for the panel, read as X / Y / Z.
 * Decomposed in YXZ order because members are usually turned about the vertical axis,
 * which keeps the common cases as a single readable number instead of a gimbal triple.
 */
export function orientationDegrees(quaternion: [number, number, number, number]): [number, number, number] {
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...quaternion).normalize(), 'YXZ')
  const deg = (r: number) => { const d = Math.round(THREE.MathUtils.radToDeg(r) * 10) / 10; return d === 0 ? 0 : d }
  return [deg(e.x), deg(e.y), deg(e.z)]
}


/**
 * A change you can watch, before it is a change you can undo.
 *
 * Typing a size used to show nothing until Enter, so you could not tell 560 from 650 without
 * committing to one. This writes straight through with no history entry of its own — the same
 * thing a drag does every frame — and `beginLiveEdit` takes the one snapshot that makes the
 * whole edit a single step. Without that snapshot the change is on screen and not in the
 * history, and undo steps over it to whatever came before.
 */
export function beginLiveEdit(): void {
  useStore.getState().snapshotHistory()
}

export function livePart(id: string, updates: Record<string, unknown>): void {
  const s = useStore.getState()
  if (s.profiles.some((p) => p.id === id)) s.updateParts({ profiles: [{ id, updates }] })
  else if (s.panels.some((p) => p.id === id)) s.updateParts({ panels: [{ id, updates }] })
  else if (s.fittings.some((f) => f.id === id)) s.updateParts({ fittings: [{ id, updates }] })
  else if (s.connectors.some((c) => c.id === id)) s.updateParts({ connectors: [{ id, updates }] })
}
