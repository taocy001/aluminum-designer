import * as THREE from 'three'
import type { ProfileData } from '../store/useStore'
import { computeAllTrims, computeTrims, type ProfileTrims } from './jointUtils'
import { getProfileDir } from './geometryCore'
import { specDims } from './specUtils'
import { makeOBB, obbPenetration, obbCorners, type OBB } from './obb'
import { findSpecMismatches, type SpecMismatch } from './specCompat'

/** members closer than this are considered touching, not interfering (mm) */
const TOUCH_TOL = 1

export interface Conflict {
  a: string
  b: string
  depth: number
  /** world-space box around the overlapping region, for highlighting */
  region: THREE.Box3
}

export interface FrameAnalysis {
  trims: Map<string, ProfileTrims>
  conflicts: Conflict[]
  conflictIds: Set<string>
  /** joints whose two profiles cannot be bolted together as drawn */
  mismatches: SpecMismatch[]
  mismatchIds: Set<string>
}

/** As-built oriented box of a member (after joint trimming) */
export function trimmedOBB(p: ProfileData, t: ProfileTrims): OBB {
  const quat = new THREE.Quaternion(...p.quaternion).normalize()
  const dir = getProfileDir(p)
  const start = new THREE.Vector3(...p.position).addScaledVector(dir, t.start.trim)
  const center = start.clone().addScaledVector(dir, t.cutLength / 2)
  const { hw, hh } = specDims(p.spec)
  return makeOBB(center, new THREE.Vector3(hw, hh, t.cutLength / 2), quat)
}

function regionOf(a: OBB, b: OBB): THREE.Box3 {
  // approximate the overlap with the intersection of the two world boxes
  const boxA = new THREE.Box3().setFromPoints(obbCorners(a))
  const boxB = new THREE.Box3().setFromPoints(obbCorners(b))
  const region = boxA.clone().intersect(boxB)
  return region.isEmpty() ? boxA.clone().union(boxB) : region
}

/**
 * Members are allowed to interfere — the tool reports it instead of refusing the edit.
 * Detection runs on the as-built bodies with an oriented-box test, so freely rotated
 * members are judged by their real shape rather than an axis-aligned envelope.
 */
export function findConflicts(profiles: ProfileData[], trims: Map<string, ProfileTrims>): Conflict[] {
  const boxes = profiles.map((p) => ({ id: p.id, obb: trimmedOBB(p, trims.get(p.id)!) }))
  const out: Conflict[] = []
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const depth = obbPenetration(boxes[i].obb, boxes[j].obb, TOUCH_TOL)
      if (depth <= 0) continue
      out.push({
        a: boxes[i].id, b: boxes[j].id,
        depth: Math.round(depth * 100) / 100,
        region: regionOf(boxes[i].obb, boxes[j].obb),
      })
    }
  }
  return out
}

let cacheKey: ProfileData[] | null = null
let cacheValue: FrameAnalysis | null = null

/**
 * Do the moving members interfere with anything? Used while dragging, where re-running the
 * whole O(n²) analysis every frame would stall a large frame: only the moved parts are tested,
 * and their trims are computed against the current document.
 */
export function movingPartsConflict(all: ProfileData[], movingIds: Set<string>): boolean {
  if (movingIds.size === 0) return false
  const trims = new Map<string, ProfileTrims>()
  const need = all.filter((p) => movingIds.has(p.id))
  for (const p of need) trims.set(p.id, computeTrims(p, all))
  const others = all.filter((p) => !movingIds.has(p.id))
  for (const p of need) {
    const a = trimmedOBB(p, trims.get(p.id)!)
    for (const q of others) {
      const qt = trims.get(q.id) ?? computeTrims(q, all)
      trims.set(q.id, qt)
      if (obbPenetration(a, trimmedOBB(q, qt), TOUCH_TOL) > 0) return true
    }
  }
  return false
}

/** Trims + interference for the current document, memoised on the profiles array identity */
export function analyzeFrame(profiles: ProfileData[]): FrameAnalysis {
  if (cacheKey === profiles && cacheValue) return cacheValue
  const trims = computeAllTrims(profiles)
  const conflicts = findConflicts(profiles, trims)
  const conflictIds = new Set<string>()
  for (const c of conflicts) { conflictIds.add(c.a); conflictIds.add(c.b) }
  const mismatches = findSpecMismatches(profiles)
  const mismatchIds = new Set<string>()
  for (const m of mismatches) { mismatchIds.add(m.a); mismatchIds.add(m.b) }
  cacheKey = profiles
  cacheValue = { trims, conflicts, conflictIds, mismatches, mismatchIds }
  return cacheValue
}
