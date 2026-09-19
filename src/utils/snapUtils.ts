import * as THREE from 'three'
import { ProfileData } from '../store/useStore'
import { getProfileEndpoints, getProfileDir, endContactsBody } from './geometryCore'

export { getProfileEndpoints }

// Returns the nearest snap endpoint within threshold, optionally excluding a point
export function findSnapPoint(
  point: THREE.Vector3,
  profiles: ProfileData[],
  threshold = 20,
  exclude?: THREE.Vector3 | null
): THREE.Vector3 | null {
  let closest: THREE.Vector3 | null = null
  let minDist = threshold
  for (const profile of profiles) {
    const { start, end } = getProfileEndpoints(profile)
    for (const candidate of [start, end]) {
      if (exclude && candidate.distanceTo(exclude) < 1) continue
      const d = point.distanceTo(candidate)
      if (d < minDist) { minDist = d; closest = candidate.clone() }
    }
  }
  return closest
}

// Constrain end so start→end is axis-aligned (X, Y, or Z)
export function snapToAxis(start: THREE.Vector3, end: THREE.Vector3): THREE.Vector3 {
  const d = end.clone().sub(start)
  const ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z)
  const result = start.clone()
  if (ax >= ay && ax >= az) result.x = end.x
  else if (ay >= ax && ay >= az) result.y = end.y
  else result.z = end.z
  return result
}

// ── AABB-based overlap detection ──────────────────────────────────────────

interface AABB { min: THREE.Vector3; max: THREE.Vector3 }

/**
 * Compute the world-space axis-aligned bounding box of a profile.
 * Accounts for actual cross-section dimensions (w × h from spec).
 */
function getAABB(profile: ProfileData): AABB {
  const pos = new THREE.Vector3(...profile.position)
  const quat = new THREE.Quaternion(...profile.quaternion).normalize()

  const w = Number(profile.spec.substring(0, 2))
  const h = Number(profile.spec.substring(2)) || w
  const hw = w / 2  // half-width in local X
  const hh = h / 2  // half-height in local Y

  // Local basis vectors in world space
  const lx = new THREE.Vector3(1, 0, 0).applyQuaternion(quat)
  const ly = new THREE.Vector3(0, 1, 0).applyQuaternion(quat)
  const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(quat)  // extrusion direction

  // AABB contribution from cross-section (|lx| * hw  +  |ly| * hh on each world axis)
  // plus extrusion along dir * length
  const min = new THREE.Vector3(
    pos.x - Math.abs(lx.x) * hw - Math.abs(ly.x) * hh + Math.min(0, dir.x * profile.length),
    pos.y - Math.abs(lx.y) * hw - Math.abs(ly.y) * hh + Math.min(0, dir.y * profile.length),
    pos.z - Math.abs(lx.z) * hw - Math.abs(ly.z) * hh + Math.min(0, dir.z * profile.length),
  )
  const max = new THREE.Vector3(
    pos.x + Math.abs(lx.x) * hw + Math.abs(ly.x) * hh + Math.max(0, dir.x * profile.length),
    pos.y + Math.abs(lx.y) * hw + Math.abs(ly.y) * hh + Math.max(0, dir.y * profile.length),
    pos.z + Math.abs(lx.z) * hw + Math.abs(ly.z) * hh + Math.max(0, dir.z * profile.length),
  )
  return { min, max }
}

/** True if two AABBs strictly overlap (not just touching — tolerance = 1 mm) */
function aabbsOverlap(a: AABB, b: AABB, tol = 1): boolean {
  return (
    a.min.x < b.max.x - tol && a.max.x > b.min.x + tol &&
    a.min.y < b.max.y - tol && a.max.y > b.min.y + tol &&
    a.min.z < b.max.z - tol && a.max.z > b.min.z + tol
  )
}

// ── 1-D interval overlap (for coaxial same-line check) ────────────────────

const PERP_EPS = 2   // mm — "same centerline" perpendicular tolerance
const TOUCH_EPS = 2  // mm — touching endpoints are allowed

interface Seg { axis: 'x'|'y'|'z'; perp1: number; perp2: number; min: number; max: number }

function toSeg(profile: ProfileData): Seg | null {
  const pos = new THREE.Vector3(...profile.position)
  const quat = new THREE.Quaternion(...profile.quaternion).normalize()
  const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(quat)
  const end = pos.clone().addScaledVector(dir, profile.length)
  const ax = Math.abs(dir.x), ay = Math.abs(dir.y), az = Math.abs(dir.z)
  if (ax > 0.9) return { axis: 'x', perp1: pos.y, perp2: pos.z, min: Math.min(pos.x, end.x), max: Math.max(pos.x, end.x) }
  if (ay > 0.9) return { axis: 'y', perp1: pos.x, perp2: pos.z, min: Math.min(pos.y, end.y), max: Math.max(pos.y, end.y) }
  if (az > 0.9) return { axis: 'z', perp1: pos.x, perp2: pos.y, min: Math.min(pos.z, end.z), max: Math.max(pos.z, end.z) }
  return null
}

function intervalsOverlap(min1: number, max1: number, min2: number, max2: number): boolean {
  return min1 < max2 - TOUCH_EPS && max1 > min2 + TOUCH_EPS
}

// ── Main overlap check ────────────────────────────────────────────────────

/**
 * Returns true if placing `candidate` would cause it to physically overlap
 * with any existing profile.
 *
 * Rules:
 *  1. Coaxial same-line profiles: precise 1-D interval check.
 *  2. All other pairs: 3-D AABB intersection.
 *     Exception: two profiles that share an endpoint are a legal corner joint
 *     and their touching AABBs are allowed.
 */
export function wouldOverlap(candidate: ProfileData, existing: ProfileData[]): boolean {
  const candSeg  = toSeg(candidate)
  const candAABB = getAABB(candidate)
  const candEps  = getProfileEndpoints(candidate)

  for (const prof of existing) {
    const exSeg = toSeg(prof)

    // ── Case 1: same axis, same centerline → exact 1-D check ──────────
    if (
      candSeg && exSeg &&
      candSeg.axis === exSeg.axis &&
      Math.abs(exSeg.perp1 - candSeg.perp1) <= PERP_EPS &&
      Math.abs(exSeg.perp2 - candSeg.perp2) <= PERP_EPS
    ) {
      if (intervalsOverlap(candSeg.min, candSeg.max, exSeg.min, exSeg.max)) return true
      continue   // same line, no interval overlap → definitely no overlap
    }

    // ── Case 2: AABB intersection (handles cross-section width) ───────
    const exAABB = getAABB(prof)
    if (!aabbsOverlap(candAABB, exAABB)) continue

    // Joint exceptions — only for non-coaxial profiles.
    // Coaxial profiles are NEVER granted exceptions; their 1D check above handles
    // the legitimate end-to-end case.
    const isCoaxial = (() => {
      if (!candSeg || !exSeg) return false
      if (candSeg.axis !== exSeg.axis) return false
      return Math.abs(candSeg.perp1 - exSeg.perp1) <= PERP_EPS &&
             Math.abs(candSeg.perp2 - exSeg.perp2) <= PERP_EPS
    })()

    if (!isCoaxial) {
      const exEps = getProfileEndpoints(prof)

      // Corner joint: two profiles share exactly one endpoint (L-joint, T-end)
      const CORNER_EPS = 0.5
      const cornerJoint = (
        candEps.start.distanceTo(exEps.start) < CORNER_EPS ||
        candEps.start.distanceTo(exEps.end)   < CORNER_EPS ||
        candEps.end.distanceTo(exEps.start)   < CORNER_EPS ||
        candEps.end.distanceTo(exEps.end)     < CORNER_EPS
      )
      if (cornerJoint) continue

      // T-joint: one member's end lands inside the body of a non-parallel member (it will be trimmed
      // to that member's face by jointUtils, so the as-built parts do not penetrate)
      const candDir = getProfileDir(candidate)
      const exDir = getProfileDir(prof)
      const tJoint =
        endContactsBody(candEps.end, candDir, prof) !== null ||
        endContactsBody(candEps.start, candDir.clone().negate(), prof) !== null ||
        endContactsBody(exEps.end, exDir, candidate) !== null ||
        endContactsBody(exEps.start, exDir.clone().negate(), candidate) !== null
      if (tJoint) continue
    }

    return true   // real physical overlap
  }

  return false
}
