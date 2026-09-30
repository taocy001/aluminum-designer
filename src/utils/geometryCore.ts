import * as THREE from 'three'
import type { ProfileData } from '../store/useStore'
import { specDims } from './specUtils'

export type Axis = 'x' | 'y' | 'z'

/** Geometry reused within one calculation, never retained across document edits. */
export interface ProfileGeometry {
  start: THREE.Vector3
  end: THREE.Vector3
  dir: THREE.Vector3
  axis: Axis | null
  x: THREE.Vector3
  y: THREE.Vector3
  hw: number
  hh: number
}

export function profileGeometry(profile: ProfileData): ProfileGeometry {
  const q = new THREE.Quaternion(...profile.quaternion).normalize()
  const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(q)
  const start = new THREE.Vector3(...profile.position)
  const { hw, hh } = specDims(profile.spec)
  return { start, end: start.clone().addScaledVector(dir, profile.length), dir,
    axis: Math.abs(dir.x) > 0.99 ? 'x' : Math.abs(dir.y) > 0.99 ? 'y' : Math.abs(dir.z) > 0.99 ? 'z' : null,
    x: new THREE.Vector3(1, 0, 0).applyQuaternion(q),
    y: new THREE.Vector3(0, 1, 0).applyQuaternion(q), hw, hh }
}

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
export function crossExtentAlong(profile: ProfileData, dir: THREE.Vector3, geometry?: ProfileGeometry): number {
  if (geometry) return round3(Math.abs(geometry.x.dot(dir)) * geometry.hw + Math.abs(geometry.y.dot(dir)) * geometry.hh)
  const { hw, hh } = specDims(profile.spec)
  const quat = new THREE.Quaternion(...profile.quaternion).normalize()
  const lx = new THREE.Vector3(1, 0, 0).applyQuaternion(quat)
  const ly = new THREE.Vector3(0, 1, 0).applyQuaternion(quat)
  return round3(Math.abs(lx.dot(dir)) * hw + Math.abs(ly.dot(dir)) * hh)
}

/** Closest point on segment [a,b] to pt, plus the clamped parameter t∈[0,1] */
export function closestOnSegment(pt: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): { point: THREE.Vector3; t: number } {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
  const lenSq = dx * dx + dy * dy + dz * dz
  if (lenSq < 1e-9) return { point: a.clone(), t: 0 }
  const t = THREE.MathUtils.clamp(((pt.x - a.x) * dx + (pt.y - a.y) * dy + (pt.z - a.z) * dz) / lenSq, 0, 1)
  return { point: new THREE.Vector3(a.x + dx * t, a.y + dy * t, a.z + dz * t), t }
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
export function endContactsBody(E: THREE.Vector3, d: THREE.Vector3, Q: ProfileData, slack = 1, geometry?: ProfileGeometry): BodyContact | null {
  const { start: qs, end: qe } = geometry ?? getProfileEndpoints(Q)
  const qDir = geometry?.dir ?? getProfileDir(Q)
  if (Math.abs(qDir.dot(d)) > 0.99) return null // parallel members never form a butt/T joint
  const { point: C, t } = closestOnSegment(E, qs, qe)
  const vx = E.x - C.x, vy = E.y - C.y, vz = E.z - C.z
  const along = vx * d.x + vy * d.y + vz * d.z
  const lx = vx + d.x * -along, ly = vy + d.y * -along, lz = vz + d.z * -along
  const lateral = Math.sqrt(lx * lx + ly * ly + lz * lz)
  const extentAlong = crossExtentAlong(Q, d, geometry)
  if (Math.abs(along) > extentAlong + slack) return null
  if (lateral > slack) {
    // lateral offset must stay inside Q's section (measured along the lateral direction) — but a point beyond
    // Q's end along its own axis is not "inside the body" unless it is a genuine corner (handled by atQEnd)
    const lateralExtent = crossExtentAlong(Q, new THREE.Vector3(lx, ly, lz).normalize(), geometry)
    if (lateral > lateralExtent + slack) return null
  }
  const atQEnd = t <= 1e-6 || t >= 1 - 1e-6 || C.distanceTo(qs) <= JOINT_EPS || C.distanceTo(qe) <= JOINT_EPS
  // if the closest param was clamped, E may be beyond Q's end along Q's axis: allow only a small overshoot
  const overshootAlongQ = Math.abs(vx * qDir.x + vy * qDir.y + vz * qDir.z)
  if (atQEnd && overshootAlongQ > crossExtentAlong(Q, qDir, geometry) + slack) return null
  return { axisPoint: C, along, extentAlong, atQEnd }
}
