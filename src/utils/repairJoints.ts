import * as THREE from 'three'
import { useStore, type ProfileData } from '../store/useStore'
import { getProfileDir, getProfileEndpoints, closestOnSegment } from './geometryCore'
import { seatFor } from './bracketSeat'
import { sharedEdge } from './specCompat'
import { computeAllTrims } from './jointUtils'
import { findConflicts } from './analysis'
import { rollProfile } from './faceAlign'

/**
 * Repair unsupported joint seats by trying a quarter-turn first, then a lateral shift.
 * Accept fewer unsupported seats without increasing clash count or decreasing inferred-link count.
 */

/** how close an end has to be to another member's centreline to be its joint (mm) */
const JOINT_TOL = 30
/** the furthest a member is slid to reach a slot line (mm) */
const MAX_SHIFT = 40

export interface Joint {
  a: ProfileData
  b: ProfileData
  at: THREE.Vector3
}

/** Every place one member's end lands on another, which is every place a bracket goes */
export function joints(profiles: ProfileData[]): Joint[] {
  const out: Joint[] = []
  const ends = new Map(profiles.map((p) => [p.id, getProfileEndpoints(p)]))
  for (const a of profiles) {
    const ea = ends.get(a.id)!
    for (const at of [ea.start, ea.end]) {
      for (const b of profiles) {
        if (b.id === a.id) continue
        if (Math.abs(getProfileDir(a).dot(getProfileDir(b))) > 0.9) continue
        const eb = ends.get(b.id)!
        if (closestOnSegment(at, eb.start, eb.end).point.distanceTo(at) > JOINT_TOL) continue
        out.push({ a, b, at: at.clone() })
      }
    }
  }
  return out
}

/** The joints no bracket can be bolted to, ignoring the pairs no part is made for */
export function unbuildable(profiles: ProfileData[]): Joint[] {
  return joints(profiles).filter((j) => sharedEdge(j.a.spec, j.b.spec) && !seatFor('bracket', j.a, j.b, j.at))
}

/** Score joints and clashes involving this member within its nearby-member set. */
function scoreAround(profiles: ProfileData[], id: string): Score {
  const me = profiles.find((p) => p.id === id)
  if (!me) return { bad: 0, clashes: 0, links: 0 }
  const near = profiles.filter((p) => p.id === id || touching(me, p))
  const mine = joints(near).filter((j) => j.a.id === id || j.b.id === id)
  const bad = mine.filter((j) => sharedEdge(j.a.spec, j.b.spec) && !seatFor('bracket', j.a, j.b, j.at)).length
  // Keep the inferred-link count so disconnecting members cannot improve the score.
  const links = mine.length
  // trims for the neighbourhood, not the document: a member's trim is decided by what it
  // meets, and everything it meets is in `near` by construction
  const clashes = findConflicts(near, computeAllTrims(near)).filter((c) => c.a === id || c.b === id).length
  return { bad, clashes, links }
}

/** near enough that one could be in the other's way */
function touching(a: ProfileData, b: ProfileData): boolean {
  if (a.id === b.id) return false
  const ea = getProfileEndpoints(a), eb = getProfileEndpoints(b)
  const pts = [ea.start, ea.end]
  for (const pt of pts) {
    if (closestOnSegment(pt, eb.start, eb.end).point.distanceTo(pt) < 200) return true
  }
  for (const pt of [eb.start, eb.end]) {
    if (closestOnSegment(pt, ea.start, ea.end).point.distanceTo(pt) < 200) return true
  }
  return false
}

/** How bad the drawing is: joints with nowhere to bolt, members through each other, and
 *  how much is still joined to anything at all. */
interface Score { bad: number; clashes: number; links: number }

/** How bad the whole drawing is, for the before-and-after the caller is told */
function score(profiles: ProfileData[]): Score {
  return {
    bad: unbuildable(profiles).length,
    clashes: findConflicts(profiles, computeAllTrims(profiles)).length,
    links: joints(profiles).length,
  }
}

const worse = (before: Score, after: Score) =>
  after.bad > before.bad || after.clashes > before.clashes || after.links < before.links
const better = (before: Score, after: Score) =>
  after.bad < before.bad && after.clashes <= before.clashes && after.links >= before.links

/** a quarter turn about the member's own axis, which moves nothing */
function rolled(p: ProfileData): ProfileData {
  const q = new THREE.Quaternion(...p.quaternion).normalize()
  const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)
  const next = q.multiply(turn)
  return { ...p, quaternion: [next.x, next.y, next.z, next.w] }
}

/** the member slid across the joint by `by` millimetres */
function slid(p: ProfileData, axis: THREE.Vector3, by: number): ProfileData {
  const at = new THREE.Vector3(...p.position).addScaledVector(axis, by)
  return { ...p, position: [Math.round(at.x * 10) / 10, Math.round(at.y * 10) / 10, Math.round(at.z * 10) / 10] }
}

export interface Repair {
  /** joints that could not be bolted before, and after */
  before: number
  after: number
  /** what was done, in the order it was done */
  steps: Array<{ id: string; how: 'turned' | 'slid'; by?: number }>
}

/** Greedily retain joint adjustments that improve the score and satisfy the acceptance checks. */
export function planRepair(input: ProfileData[]): { profiles: ProfileData[]; repair: Repair } {
  let profiles = input.map((p) => ({ ...p }))
  const steps: Repair['steps'] = []
  const before = score(profiles)

  for (let pass = 0; pass < 8; pass++) {
    const bad = unbuildable(profiles)
    if (bad.length === 0) break
    let movedSomething = false

    for (const joint of bad) {
      // whichever of the two is the smaller section is the one to move: a post carries the
      // frame and a rail is hung off it
      const order = [joint.a, joint.b].sort((p, q) =>
        (Number(p.spec.slice(0, 2)) + Number(p.spec.slice(2))) - (Number(q.spec.slice(0, 2)) + Number(q.spec.slice(2))))

      let done = false
      for (const who of order) {
        const now = scoreAround(profiles, who.id)
        // 1. turn it
        const turned = profiles.map((p) => (p.id === who.id ? rolled(p) : p))
        const afterTurn = scoreAround(turned, who.id)
        if (better(now, afterTurn) && !worse(now, afterTurn)) {
          profiles = turned
          steps.push({ id: who.id, how: 'turned' })
          movedSomething = true; done = true; break
        }
        // 2. slide it, across the joint, by the least that helps
        const across = new THREE.Vector3().crossVectors(getProfileDir(joint.a), getProfileDir(joint.b))
        if (across.lengthSq() < 1e-6) continue
        across.normalize()
        for (const by of [5, -5, 10, -10, 15, -15, 20, -20, 30, -30, MAX_SHIFT, -MAX_SHIFT]) {
          const shifted = profiles.map((p) => (p.id === who.id ? slid(p, across, by) : p))
          const after = scoreAround(shifted, who.id)
          if (better(now, after) && !worse(now, after)) {
            profiles = shifted
            steps.push({ id: who.id, how: 'slid', by })
            movedSomething = true; done = true; break
          }
        }
        if (done) break
      }
    }
    if (!movedSomething) break
  }

  return { profiles, repair: { before: before.bad, after: score(profiles).bad, steps } }
}

/** Apply the repair to the document, as one undo step */
export function repairJoints(): Repair {
  const store = useStore.getState()
  const { profiles, repair } = planRepair(store.profiles)
  if (repair.steps.length === 0) return repair
  store.commitTransform({
    profiles: profiles.map((p) => ({ id: p.id, updates: { position: p.position, quaternion: p.quaternion } })),
  })
  void rollProfile
  return repair
}
