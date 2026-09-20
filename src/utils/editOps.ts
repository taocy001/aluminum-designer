import * as THREE from 'three'
import { useStore, type ConnectorData, type ProfileData, type ProfileSpec } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { getProfileEndpoints } from './geometryCore'
import { getProfileAxis, getProfileDir } from './jointUtils'
import { analyzeFrame } from './analysis'
import { floorY, lowestPointY, nextId } from './profileFactory'
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

function selectedProfiles(): ProfileData[] {
  const { profiles, selectedIds } = useStore.getState()
  const ids = new Set(selectedIds)
  return profiles.filter((p) => ids.has(p.id))
}

function selectedConnectors(): ConnectorData[] {
  const { connectors, selectedIds } = useStore.getState()
  const ids = new Set(selectedIds)
  return connectors.filter((c) => ids.has(c.id))
}

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
  const { conflicts } = analyzeFrame(useStore.getState().profiles)
  return new Set(conflicts.map((c) => [c.a, c.b].sort().join('|')))
}

/** Apply edited profiles (same ids) as one undoable step */
function applyProfiles(cands: ProfileData[]): boolean {
  if (cands.length === 0) return false
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
  const profiles = selectedProfiles()
  const connectors = selectedConnectors()
  if (profiles.length === 0 && connectors.length === 0) return false

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
  })
  warnIfNewConflicts(before)
  return true
}

/** Duplicate the selection (profiles and connectors) and select the copies */
export function duplicateSelected(): boolean {
  const profiles = selectedProfiles()
  const connectors = selectedConnectors()
  if (profiles.length === 0 && connectors.length === 0) return false
  const axis = profiles[0] ? getProfileAxis(profiles[0]) : 'y'
  const d: [number, number, number] = axis === 'x' ? [0, 0, 50] : [50, 0, 0]
  const before = conflictPairsNow()
  const store = useStore.getState()
  const newProfiles = profiles.map((p) => ({
    ...p, id: nextId('p'),
    position: [p.position[0] + d[0], p.position[1] + d[1], p.position[2] + d[2]] as [number, number, number],
  }))
  const newConnectors = connectors.map((c) => ({
    ...c, id: nextId('c'),
    position: [c.position[0] + d[0], c.position[1] + d[1], c.position[2] + d[2]] as [number, number, number],
  }))
  store.addItems(newProfiles, newConnectors, true)
  toast(t().toastDuplicated(newProfiles.length + newConnectors.length), 'success')
  warnIfNewConflicts(before)
  return true
}

/** Centre of the current selection, used as the default rotation pivot */
export function selectionPivot(profiles: ProfileData[], connectors: ConnectorData[]): THREE.Vector3 {
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

/**
 * Rotate the whole selection by any angle about a world axis, around the selection centre.
 * Profiles and connectors alike — nothing is restricted to 90° steps or to the Y axis.
 */
export function rotateSelected(axis: RotAxis = 'y', degrees = 90): boolean {
  const profiles = selectedProfiles()
  const connectors = selectedConnectors()
  if (profiles.length === 0 && connectors.length === 0) return false
  if (!isFinite(degrees) || degrees % 360 === 0) return false
  const pivot = selectionPivot(profiles, connectors)
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

  // a turn must not bury the parts: lift the whole selection back onto the floor
  const rotated = profiles.map((p, i) => ({ ...p, ...spunProfiles[i].updates }))
  const sink = sinkBelowFloor(rotated, [0, 0, 0])
  if (sink < 0) {
    for (const u of spunProfiles) u.updates.position = [u.updates.position![0], round3(u.updates.position![1] - sink), u.updates.position![2]]
    for (const u of spunConnectors) u.updates.position = [u.updates.position![0], round3(u.updates.position![1] - sink), u.updates.position![2]]
  }

  const before = conflictPairsNow()
  useStore.getState().commitTransform({ profiles: spunProfiles, connectors: spunConnectors })
  warnIfNewConflicts(before)
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

export function setProfileSpec(id: string, spec: ProfileSpec): boolean {
  const p = useStore.getState().profiles.find((q) => q.id === id)
  if (!p) return false
  const cand = { ...p, spec }
  if (getProfileAxis(cand) === 'x' || getProfileAxis(cand) === 'z') {
    cand.position = [cand.position[0], Math.max(cand.position[1], floorY(spec)), cand.position[2]]
  }
  return applyProfiles([cand])
}

export function setConnectorPosition(id: string, position: [number, number, number]): boolean {
  const c = useStore.getState().connectors.find((q) => q.id === id)
  if (!c || position.some((v) => !isFinite(v))) return false
  const before = conflictPairsNow()
  useStore.getState().commitTransform({ connectors: [{ id, updates: { position: position.map(round3) as [number, number, number] } }] })
  warnIfNewConflicts(before)
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
