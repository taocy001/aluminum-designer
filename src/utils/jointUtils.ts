import * as THREE from 'three'
import type { ProfileData } from '../store/useStore'
import { specDims } from './specUtils'
import { getProfileEndpoints, getProfileDir, getProfileAxis, crossExtentAlong, round3, endContactsBody, JOINT_EPS, type Axis } from './geometryCore'

export type { Axis }
export { getProfileDir, getProfileAxis, crossExtentAlong }

/**
 * Which member "runs through" a corner joint. Uprights (Y) are through members,
 * X beams run through Z beams. Lower-priority members butt against
 * higher-priority ones and are trimmed back to the partner's face.
 */
const AXIS_PRIORITY: Record<Axis, number> = { y: 3, x: 2, z: 1 }

export interface EndJoint {
  /** positive → this end is cut back (butt joint); negative → extended to the far face */
  trim: number
  /** how many other members meet here */
  partners: number
  /** true when this end butts against another member */
  butt: boolean
  /** true when a coaxial member continues from this end */
  continues: boolean
}

export interface ProfileTrims {
  start: EndJoint
  end: EndJoint
  cutLength: number
}

function resolveEnd(endPt: THREE.Vector3, pDir: THREE.Vector3, pAxis: Axis | null, others: ProfileData[]): EndJoint {
  let buttTrim = -Infinity
  let anyButt = false
  let extend = 0
  let partners = 0
  let continues = false

  for (const q of others) {
    const qAxis = getProfileAxis(q)
    if (pAxis && qAxis && pAxis === qAxis) {
      // coaxial continuation: a parallel member whose end meets ours → plain end-to-end, never trimmed or extended
      const { start: qs, end: qe } = getProfileEndpoints(q)
      if (endPt.distanceTo(qs) <= JOINT_EPS || endPt.distanceTo(qe) <= JOINT_EPS) { continues = true; partners++ }
      continue
    }
    const c = endContactsBody(endPt, pDir, q)
    if (!c) continue
    partners++
    const toNearFace = round3(c.along + c.extentAlong)   // cut back so our end sits on Q's near face
    const toFarFace = round3(c.extentAlong - c.along)    // extend so our end reaches Q's far face

    const pPri = pAxis ? AXIS_PRIORITY[pAxis] : 0
    const qPri = qAxis ? AXIS_PRIORITY[qAxis] : 0
    const weButt = !c.atQEnd || qPri > pPri   // T-joint, or corner where Q has priority
    if (weButt) { anyButt = true; buttTrim = Math.max(buttTrim, toNearFace) }
    else if (pPri > qPri) extend = Math.max(extend, toFarFace)
  }

  if (continues) return { trim: 0, partners, butt: false, continues: true }
  if (anyButt) return { trim: round3(buttTrim), partners, butt: true, continues: false }
  if (extend > 0) return { trim: round3(-extend), partners, butt: false, continues: false }
  return { trim: 0, partners, butt: false, continues: false }
}

/** Compute how each end of `profile` should be trimmed/extended so members butt cleanly. */
export function computeTrims(profile: ProfileData, all: ProfileData[]): ProfileTrims {
  const others = all.filter((o) => o.id !== profile.id)
  const { start, end } = getProfileEndpoints(profile)
  const dir = getProfileDir(profile)
  const axis = getProfileAxis(profile)
  const s = resolveEnd(start, dir.clone().negate(), axis, others)
  const e = resolveEnd(end, dir, axis, others)
  let cutLength = round3(profile.length - s.trim - e.trim)
  if (!isFinite(cutLength) || cutLength < 1) cutLength = Math.max(1, profile.length)
  return { start: s, end: e, cutLength }
}

export function computeAllTrims(all: ProfileData[]): Map<string, ProfileTrims> {
  const map = new Map<string, ProfileTrims>()
  for (const p of all) map.set(p.id, computeTrims(p, all))
  return map
}

/** Trimmed (as-built) axis-aligned box of a member */
export function trimmedBox(p: ProfileData, t: ProfileTrims): THREE.Box3 {
  const dir = getProfileDir(p)
  const s = new THREE.Vector3(...p.position).addScaledVector(dir, t.start.trim)
  const e = s.clone().addScaledVector(dir, t.cutLength)
  const quat = new THREE.Quaternion(...p.quaternion).normalize()
  const { hw, hh } = specDims(p.spec)
  const lx = new THREE.Vector3(1, 0, 0).applyQuaternion(quat).multiplyScalar(hw)
  const ly = new THREE.Vector3(0, 1, 0).applyQuaternion(quat).multiplyScalar(hh)
  const box = new THREE.Box3()
  for (const c of [s, e]) for (const sx of [-1, 1]) for (const sy of [-1, 1]) box.expandByPoint(c.clone().addScaledVector(lx, sx).addScaledVector(ly, sy))
  return box
}

/** World-space bounding box of the real (trimmed) geometry of all profiles */
export function computeFrameBounds(all: ProfileData[], trims?: Map<string, ProfileTrims>): THREE.Box3 | null {
  if (all.length === 0) return null
  const box = new THREE.Box3()
  for (const p of all) box.union(trimmedBox(p, trims?.get(p.id) ?? computeTrims(p, all)))
  return box
}
