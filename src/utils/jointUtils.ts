import * as THREE from 'three'
import type { ProfileData } from '../store/useStore'
import { specDims } from './specUtils'
import { getProfileEndpoints } from './snapUtils'

export type Axis = 'x' | 'y' | 'z'

/**
 * Which member "runs through" a joint. Uprights (Y) are through members,
 * X beams run through Z beams. Lower-priority members butt against
 * higher-priority ones and are trimmed by half of their cross-section.
 */
const AXIS_PRIORITY: Record<Axis, number> = { y: 3, x: 2, z: 1 }

const JOINT_EPS = 1.5 // mm — endpoint must lie this close to the other centerline

export function getProfileDir(profile: ProfileData): THREE.Vector3 {
  const quat = new THREE.Quaternion(...profile.quaternion).normalize()
  return new THREE.Vector3(0, 0, 1).applyQuaternion(quat)
}

export function getProfileAxis(profile: ProfileData): Axis | null {
  const d = getProfileDir(profile)
  if (Math.abs(d.x) > 0.99) return 'x'
  if (Math.abs(d.y) > 0.99) return 'y'
  if (Math.abs(d.z) > 0.99) return 'z'
  return null
}

/** Half extent of a profile's cross-section measured along world direction `dir` */
export function crossExtentAlong(profile: ProfileData, dir: THREE.Vector3): number {
  const { hw, hh } = specDims(profile.spec)
  const quat = new THREE.Quaternion(...profile.quaternion).normalize()
  const lx = new THREE.Vector3(1, 0, 0).applyQuaternion(quat)
  const ly = new THREE.Vector3(0, 1, 0).applyQuaternion(quat)
  return round3(Math.abs(lx.dot(dir)) * hw + Math.abs(ly.dot(dir)) * hh)
}

function round3(v: number): number {
  const r = Math.round(v * 1000) / 1000
  return r === 0 ? 0 : r
}

function closestParamOnSegment(pt: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const ab = b.clone().sub(a)
  const lenSq = ab.lengthSq()
  if (lenSq < 1e-6) return 0
  return THREE.MathUtils.clamp(pt.clone().sub(a).dot(ab) / lenSq, 0, 1)
}

export interface EndJoint {
  /** positive → this end is cut back (butt joint); negative → extended to the far face */
  trim: number
  /** how many other members meet here */
  partners: number
  /** true when this end butts against another member */
  butt: boolean
}

export interface ProfileTrims {
  start: EndJoint
  end: EndJoint
  cutLength: number
}

function resolveEnd(
  p: ProfileData,
  endPt: THREE.Vector3,
  pDir: THREE.Vector3,
  pAxis: Axis | null,
  others: ProfileData[],
): EndJoint {
  let trim = 0
  let extend = 0
  let partners = 0

  for (const q of others) {
    const qAxis = getProfileAxis(q)
    if (pAxis && qAxis && pAxis === qAxis) continue // parallel members never form a butt joint
    const { start: qs, end: qe } = getProfileEndpoints(q)
    const t = closestParamOnSegment(endPt, qs, qe)
    const closest = qs.clone().lerp(qe, t)
    if (closest.distanceTo(endPt) > JOINT_EPS) continue

    partners++
    const extent = crossExtentAlong(q, pDir)
    const atQEnd = endPt.distanceTo(qs) <= JOINT_EPS || endPt.distanceTo(qe) <= JOINT_EPS

    if (!atQEnd) {
      // T-joint: we end on Q's body → Q runs through, we butt against it
      trim = Math.max(trim, extent)
      continue
    }

    // Corner joint: priority decides who runs through
    const pPri = pAxis ? AXIS_PRIORITY[pAxis] : 0
    const qPri = qAxis ? AXIS_PRIORITY[qAxis] : 0
    if (qPri > pPri) trim = Math.max(trim, extent)
    else if (pPri > qPri) extend = Math.max(extend, extent)
  }

  if (trim > 0) return { trim, partners, butt: true }
  if (extend > 0) return { trim: -extend, partners, butt: false }
  return { trim: 0, partners, butt: false }
}

/** Compute how each end of `profile` should be trimmed/extended so members butt cleanly. */
export function computeTrims(profile: ProfileData, all: ProfileData[]): ProfileTrims {
  const others = all.filter((o) => o.id !== profile.id)
  const { start, end } = getProfileEndpoints(profile)
  const dir = getProfileDir(profile)
  const axis = getProfileAxis(profile)

  const s = resolveEnd(profile, start, dir, axis, others)
  const e = resolveEnd(profile, end, dir, axis, others)
  let cutLength = round3(profile.length - s.trim - e.trim)
  if (!isFinite(cutLength) || cutLength < 1) cutLength = Math.max(1, profile.length)
  return { start: s, end: e, cutLength }
}

export function computeAllTrims(all: ProfileData[]): Map<string, ProfileTrims> {
  const map = new Map<string, ProfileTrims>()
  for (const p of all) map.set(p.id, computeTrims(p, all))
  return map
}

/** World-space bounding box of the real (trimmed) geometry of all profiles */
export function computeFrameBounds(all: ProfileData[], trims?: Map<string, ProfileTrims>): THREE.Box3 | null {
  if (all.length === 0) return null
  const box = new THREE.Box3()
  for (const p of all) {
    const t = trims?.get(p.id) ?? computeTrims(p, all)
    const dir = getProfileDir(p)
    const s = new THREE.Vector3(...p.position).addScaledVector(dir, t.start.trim)
    const e = s.clone().addScaledVector(dir, t.cutLength)
    const quat = new THREE.Quaternion(...p.quaternion).normalize()
    const { hw, hh } = specDims(p.spec)
    const lx = new THREE.Vector3(1, 0, 0).applyQuaternion(quat).multiplyScalar(hw)
    const ly = new THREE.Vector3(0, 1, 0).applyQuaternion(quat).multiplyScalar(hh)
    for (const c of [s, e]) {
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
        box.expandByPoint(c.clone().addScaledVector(lx, sx).addScaledVector(ly, sy))
      }
    }
  }
  return box
}
