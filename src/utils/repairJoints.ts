import * as THREE from 'three'
import { useStore, type ProfileData } from '../store/useStore'
import { getProfileDir, getProfileEndpoints, closestOnSegment } from './geometryCore'
import { seatFor } from './bracketSeat'
import { sharedEdge } from './specCompat'
import { computeAllTrims } from './jointUtils'
import { findConflicts } from './analysis'
import { rollProfile } from './faceAlign'

/**
 * Put right the joints that cannot take a bracket.
 *
 * The tool has been able to say "twenty-one of these joints have nowhere to bolt" for a
 * while, and been no help whatever about it. Drawing eight cabinets by hand hit it thirty-two
 * times, which is thirty-two times somebody would have had to work out for themselves which
 * member to nudge and by how much.
 *
 * Two moves, in that order:
 *
 *  1. **Turn a member a quarter.** A 2040 offers a 20 edge and a 40 edge; which one faces its
 *     neighbour decides whether their slots line up. Turning costs nothing — the member stays
 *     on its line and keeps its length — so it is always tried first.
 *  2. **Slide it across.** Only when turning cannot do it, and only the smaller of the two,
 *     and only far enough to reach the nearest line that is a slot on both.
 *
 * Every step is measured before it is kept. A step that fixes one joint and breaks another,
 * or that puts two members through each other, is undone. That is what makes this safe to
 * offer as a button: the worst it can do is nothing.
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

/**
 * How bad the drawing is around one member.
 *
 * Whole-drawing scoring is exact and far too slow to put behind a button — eight cabinets
 * took fifteen seconds. It is also more than is needed: moving one member can only change
 * the joints that member is in and the clashes it is part of, so counting those is not an
 * approximation, it is the same answer for a fraction of the work.
 */
function scoreAround(profiles: ProfileData[], id: string): { bad: number; clashes: number } {
  const me = profiles.find((p) => p.id === id)
  if (!me) return { bad: 0, clashes: 0 }
  const near = profiles.filter((p) => p.id === id || touching(me, p))
  const bad = joints(near).filter((j) =>
    (j.a.id === id || j.b.id === id) && sharedEdge(j.a.spec, j.b.spec) && !seatFor('bracket', j.a, j.b, j.at)).length
  // trims for the neighbourhood, not the document: a member's trim is decided by what it
  // meets, and everything it meets is in `near` by construction
  const clashes = findConflicts(near, computeAllTrims(near)).filter((c) => c.a === id || c.b === id).length
  return { bad, clashes }
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

/** How bad the whole drawing is, for the before-and-after the caller is told */
function score(profiles: ProfileData[]): { bad: number; clashes: number } {
  return {
    bad: unbuildable(profiles).length,
    clashes: findConflicts(profiles, computeAllTrims(profiles)).length,
  }
}

const worse = (before: { bad: number; clashes: number }, after: { bad: number; clashes: number }) =>
  after.bad > before.bad || after.clashes > before.clashes
const better = (before: { bad: number; clashes: number }, after: { bad: number; clashes: number }) =>
  after.bad < before.bad && after.clashes <= before.clashes

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

/**
 * Work through the unbuildable joints, keeping only the changes that help.
 *
 * Greedy, and deliberately so: a joint is between two members and each member is in several
 * joints, so there is no order that is right for every drawing. What makes greed safe here is
 * that every step is scored — it goes in only if the whole drawing got better — so the worst
 * case is that it stops early rather than that it wanders.
 */
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
        if (better(now, scoreAround(turned, who.id))) {
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
