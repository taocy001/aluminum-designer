import * as THREE from 'three'
import type { ProfileData } from '../store/useStore'
import { specDims } from './specUtils'

export type Axis = 'x' | 'y' | 'z'

export function getProfileDir(profile: ProfileData): THREE.Vector3 {
  const quat = new THREE.Quaternion(...profile.quaternion).normalize()
  return new THREE.Vector3(0, 0, 1).applyQuaternion(quat)
}

export function getProfileEndpoints(profile: ProfileData): { start: THREE.Vector3; end: THREE.Vector3 } {
  const start = new THREE.Vector3(...profile.position)
  const end = start.clone().addScaledVector(getProfileDir(profile), profile.length)
  return { start, end }
}

export function getProfileAxis(profile: ProfileData): Axis | null {
  const d = getProfileDir(profile)
  if (Math.abs(d.x) > 0.99) return 'x'
  if (Math.abs(d.y) > 0.99) return 'y'
  if (Math.abs(d.z) > 0.99) return 'z'
  return null
}

export function round3(v: number): number {
  const r = Math.round(v * 1000) / 1000
  return r === 0 ? 0 : r
}

/** Half extent of a profile's cross-section measured along world direction `dir` (unit) */
export function crossExtentAlong(profile: ProfileData, dir: THREE.Vector3): number {
  const { hw, hh } = specDims(profile.spec)
  const quat = new THREE.Quaternion(...profile.quaternion).normalize()
  const lx = new THREE.Vector3(1, 0, 0).applyQuaternion(quat)
  const ly = new THREE.Vector3(0, 1, 0).applyQuaternion(quat)
  return round3(Math.abs(lx.dot(dir)) * hw + Math.abs(ly.dot(dir)) * hh)
}

/** Closest point on segment [a,b] to pt, plus the clamped parameter t∈[0,1] */
export function closestOnSegment(pt: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): { point: THREE.Vector3; t: number } {
  const ab = b.clone().sub(a)
  const lenSq = ab.lengthSq()
  if (lenSq < 1e-9) return { point: a.clone(), t: 0 }
  const t = THREE.MathUtils.clamp(pt.clone().sub(a).dot(ab) / lenSq, 0, 1)
  return { point: a.clone().addScaledVector(ab, t), t }
}

export const JOINT_EPS = 1.5

export interface BodyContact {
  /** closest point on Q's centerline */
  axisPoint: THREE.Vector3
  /** signed overshoot of E past Q's axis along d (positive = went past) */
  along: number
  /** Q's half extent along d */
  extentAlong: number
  /** true when the contact is at one of Q's ends (corner) rather than mid-span (T) */
  atQEnd: boolean
}

/**
 * Does end point E of a member heading along unit `d` land inside the body of member Q?
 * (lateral offset within Q's half section, along-offset within Q's half extent along d).
 * Returns the contact geometry or null.
 */
export function endContactsBody(E: THREE.Vector3, d: THREE.Vector3, Q: ProfileData, slack = 1): BodyContact | null {
  const { start: qs, end: qe } = getProfileEndpoints(Q)
  const qDir = getProfileDir(Q)
  if (Math.abs(qDir.dot(d)) > 0.99) return null // parallel members never form a butt/T joint
  const { point: C, t } = closestOnSegment(E, qs, qe)
  const v = E.clone().sub(C)
  const along = v.dot(d)
  const lateralVec = v.clone().addScaledVector(d, -along)
  const lateral = lateralVec.length()
  const extentAlong = crossExtentAlong(Q, d)
  if (Math.abs(along) > extentAlong + slack) return null
  if (lateral > slack) {
    // lateral offset must stay inside Q's section (measured along the lateral direction) — but a point beyond
    // Q's end along its own axis is not "inside the body" unless it is a genuine corner (handled by atQEnd)
    const lateralExtent = crossExtentAlong(Q, lateralVec.clone().normalize())
    if (lateral > lateralExtent + slack) return null
  }
  const atQEnd = t <= 1e-6 || t >= 1 - 1e-6 || C.distanceTo(qs) <= JOINT_EPS || C.distanceTo(qe) <= JOINT_EPS
  // if the closest param was clamped, E may be beyond Q's end along Q's axis: allow only a small overshoot
  const overshootAlongQ = Math.abs(E.clone().sub(C).dot(qDir))
  if (atQEnd && overshootAlongQ > crossExtentAlong(Q, qDir) + slack) return null
  return { axisPoint: C, along, extentAlong, atQEnd }
}
