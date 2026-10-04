import * as THREE from 'three'
import { useStore, type ProfileData } from '../store/useStore'
import { getProfileDir, getProfileEndpoints, closestOnSegment } from './geometryCore'
import { actualTouching, supportsProfileJoint, unsupportedProfileJoint } from './connectorSupport'
import { computeAllTrims, withFixedProfileCuts, type ProfileTrims } from './jointUtils'
import { findConflicts } from './analysis'
import { rollProfile } from './faceAlign'
import { reportEditResult } from './editFeedback'

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
export function joints(profiles: ProfileData[], trims = computeAllTrims(profiles)): Joint[] {
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
        // Count actual links as well as mismatch faults: otherwise sliding apart
        // within the old 30 mm search radius could falsely improve the repair score.
        if (!supportsProfileJoint(a, b, at, trims) && !actualTouching(a, b, trims)) continue
        out.push({ a, b, at: at.clone() })
      }
    }
  }
  return out
}

const unsupported = (j: Joint, trims: Map<string, ProfileTrims>) => unsupportedProfileJoint(j.a, j.b, j.at, trims)

/** Unsupported joints remain visible even when rotation or translation cannot fix their slot family. */
export function unbuildable(profiles: ProfileData[], trims = computeAllTrims(profiles)): Joint[] {
  return joints(profiles, trims).filter((j) => unsupported(j, trims))
}

/** Score joints and clashes involving this member within its nearby-member set. */
function scoreAround(profiles: ProfileData[], id: string): Score {
  const me = profiles.find((p) => p.id === id)
  if (!me) return { bad: 0, clashes: 0, links: 0 }
  const near = profiles.filter((p) => p.id === id || touching(me, p))
  const trims = computeAllTrims(near)
  const mine = joints(near, trims).filter((j) => j.a.id === id || j.b.id === id)
  const bad = mine.filter((j) => unsupported(j, trims)).length
  // Keep the inferred-link count so disconnecting members cannot improve the score.
  const links = mine.length
  // trims for the neighbourhood, not the document: a member's trim is decided by what it
  // meets, and everything it meets is in `near` by construction
  const clashes = findConflicts(near, trims).filter((c) => c.a === id || c.b === id).length
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
  const trims = computeAllTrims(profiles)
  return {
    bad: unbuildable(profiles, trims).length,
    clashes: findConflicts(profiles, trims).length,
    links: joints(profiles, trims).length,
  }
}

const worse = (before: Score, after: Score) =>
  after.bad > before.bad || after.clashes > before.clashes || after.links < before.links
const better = (before: Score, after: Score) =>
  after.bad < before.bad && after.clashes <= before.clashes && after.links >= before.links

/** Rotate 90° around local Z without changing centerline endpoints. */
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

/** Collect collinear members connected end-to-end so alignment can move the full run together. */
function runOf(profiles: ProfileData[], who: ProfileData): Set<string> {
  const run = new Set([who.id])
  const dir = getProfileDir(who)
  const queue = [who]
  while (queue.length) {
    const m = queue.pop()!
    const em = getProfileEndpoints(m)
    for (const p of profiles) {
      if (run.has(p.id) || Math.abs(getProfileDir(p).dot(dir)) < 0.999) continue
      const ep = getProfileEndpoints(p)
      const meets = [em.start, em.end].some((a) => [ep.start, ep.end].some((b) => a.distanceTo(b) <= 1.5))
      if (meets) { run.add(p.id); queue.push(p) }
    }
  }
  return run
}

/** how bad the drawing is around several members at once */
function scoreRun(profiles: ProfileData[], ids: Set<string>): Score {
  const total: Score = { bad: 0, clashes: 0, links: 0 }
  for (const id of ids) {
    const s = scoreAround(profiles, id)
    total.bad += s.bad; total.clashes += s.clashes; total.links += s.links
  }
  return total
}

export interface Repair {
  /** The proposed changes could not be applied to the current document. */
  rejected?: boolean
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
      const order = [joint.a, joint.b].filter((p) => !p.locked).sort((p, q) =>
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
        // alone first; then, if it is one of a line of members end to end, the whole line
        const run = runOf(profiles, who)
        const groups = run.size > 1 ? [new Set([who.id]), run] : [new Set([who.id])]
        for (const group of groups) {
          if (profiles.some((p) => group.has(p.id) && p.locked)) continue
          const was = scoreRun(profiles, group)
          for (const by of [5, -5, 10, -10, 15, -15, 20, -20, 30, -30, MAX_SHIFT, -MAX_SHIFT]) {
            const shifted = profiles.map((p) => (group.has(p.id) ? slid(p, across, by) : p))
            const after = scoreRun(shifted, group)
            if (better(was, after) && !worse(was, after)) {
              profiles = shifted
              for (const id of group) steps.push({ id, how: 'slid', by })
              movedSomething = true; done = true; break
            }
          }
          if (done) break
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
  const { profiles, repair } = planRepair(withFixedProfileCuts(store.profiles))
  if (repair.steps.length === 0) return repair
  const result = store.commitTransform({
    profiles: profiles.map((p) => ({ id: p.id, updates: { position: p.position, quaternion: p.quaternion } })),
  })
  if (!reportEditResult(result)) return { ...repair, after: repair.before, steps: [], rejected: result.status === 'rejected' }
  void rollProfile
  return repair
}
