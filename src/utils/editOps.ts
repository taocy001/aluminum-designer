import * as THREE from 'three'
import { useStore, type ProfileData, type ProfileSpec } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { getProfileEndpoints, wouldOverlap } from './snapUtils'
import { getProfileAxis, getProfileDir } from './jointUtils'
import { floorY, nextId } from './profileFactory'
import { translations } from './translations'

function t() { return translations[useToolStore.getState().language] }
function toast(msg: string, kind: 'error' | 'info' | 'success' = 'error') { useToolStore.getState().showToast(msg, kind) }

function selectedProfiles(): ProfileData[] {
  const { profiles, selectedIds } = useStore.getState()
  const ids = new Set(selectedIds)
  return profiles.filter((p) => ids.has(p.id))
}

function violatesFloor(p: ProfileData): boolean {
  const { start, end } = getProfileEndpoints(p)
  if (getProfileAxis(p) === 'y') return Math.min(start.y, end.y) < -0.01
  return p.position[1] < floorY(p.spec) - 0.01
}

/** Apply a set of candidate profiles (same ids) if none overlaps anything outside the set. */
function applyCandidates(cands: ProfileData[]): boolean {
  const all = useStore.getState().profiles
  const ids = new Set(cands.map((c) => c.id))
  const others = all.filter((p) => !ids.has(p.id))
  for (const c of cands) {
    if (violatesFloor(c)) { toast(t().toastBelowFloor); return false }
    if (wouldOverlap(c, others)) { toast(t().toastOverlap); return false }
  }
  useStore.getState().commitProfilesEdit(cands.map((c) => ({ id: c.id, updates: c })))
  return true
}

/** Move selection by a world-space delta (mm) */
export function nudgeSelected(delta: [number, number, number]): boolean {
  const sel = selectedProfiles()
  if (sel.length === 0) return false
  return applyCandidates(sel.map((p) => ({
    ...p,
    position: [p.position[0] + delta[0], p.position[1] + delta[1], p.position[2] + delta[2]] as [number, number, number],
  })))
}

/** Duplicate selection, offset so the copies are visible, and select the copies */
export function duplicateSelected(): boolean {
  const sel = selectedProfiles()
  if (sel.length === 0) return false
  const all = useStore.getState().profiles
  // Offset perpendicular to the first member, stepping until the copies fit
  const first = sel[0]
  const axis = getProfileAxis(first)
  const base: [number, number, number] = axis === 'x' ? [0, 0, 50] : [50, 0, 0]
  for (let k = 1; k <= 20; k++) {
    const d: [number, number, number] = [base[0] * k, 0, base[2] * k]
    const copies = sel.map((p) => ({
      ...p, id: nextId('p'),
      position: [p.position[0] + d[0], p.position[1] + d[1], p.position[2] + d[2]] as [number, number, number],
    }))
    const ok = copies.every((c) => !wouldOverlap(c, all) && !wouldOverlap(c, copies.filter((o) => o.id !== c.id)))
    if (ok) {
      useStore.getState().addProfiles(copies, true)
      toast(t().toastDuplicated(copies.length), 'success')
      return true
    }
  }
  toast(t().toastOverlap)
  return false
}

/** Rotate selection 90° about the world Y axis around the first member's start point */
export function rotateSelected(): boolean {
  const sel = selectedProfiles()
  if (sel.length === 0) return false
  const pivot = new THREE.Vector3(...sel[0].position)
  const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
  return applyCandidates(sel.map((p) => {
    const pos = new THREE.Vector3(...p.position).sub(pivot).applyQuaternion(rot).add(pivot)
    const q = rot.clone().multiply(new THREE.Quaternion(...p.quaternion)).normalize()
    return {
      ...p,
      position: [Math.round(pos.x * 1000) / 1000, Math.round(pos.y * 1000) / 1000, Math.round(pos.z * 1000) / 1000],
      quaternion: [q.x, q.y, q.z, q.w],
    }
  }))
}

/** Reverse a member's direction (swap its start and end) — useful before changing the length */
export function flipProfile(id: string): boolean {
  const p = useStore.getState().profiles.find((q) => q.id === id)
  if (!p) return false
  const { end } = getProfileEndpoints(p)
  const q = new THREE.Quaternion(...p.quaternion).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)).normalize()
  return applyCandidates([{ ...p, position: [end.x, end.y, end.z], quaternion: [q.x, q.y, q.z, q.w] }])
}

export function setProfileLength(id: string, length: number): boolean {
  const p = useStore.getState().profiles.find((q) => q.id === id)
  if (!p) return false
  if (!isFinite(length) || length < 10) { toast(t().toastTooShort); return false }
  return applyCandidates([{ ...p, length: Math.round(length * 100) / 100 }])
}

export function setProfilePosition(id: string, position: [number, number, number]): boolean {
  const p = useStore.getState().profiles.find((q) => q.id === id)
  if (!p) return false
  if (position.some((v) => !isFinite(v))) return false
  return applyCandidates([{ ...p, position }])
}

export function setProfileSpec(id: string, spec: ProfileSpec): boolean {
  const p = useStore.getState().profiles.find((q) => q.id === id)
  if (!p) return false
  const cand = { ...p, spec }
  if (getProfileAxis(cand) !== 'y') cand.position = [cand.position[0], Math.max(cand.position[1], floorY(spec)), cand.position[2]]
  return applyCandidates([cand])
}

/** Direction label like "+X" for the properties panel */
export function directionLabel(p: ProfileData): string {
  const d = getProfileDir(p)
  const axis = getProfileAxis(p)
  if (!axis) return '?'
  const sign = d[axis] >= 0 ? '+' : '−'
  return `${sign}${axis.toUpperCase()}`
}
