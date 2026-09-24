import * as THREE from 'three'
import type { ProfileData } from '../store/useStore'
import { specDims } from './specUtils'
import { getProfileEndpoints, getProfileDir, getProfileAxis, crossExtentAlong, round3, endContactsBody, closestOnSegment, JOINT_EPS, type Axis } from './geometryCore'

export type { Axis }
export { getProfileDir, getProfileAxis, crossExtentAlong }

/**
 * Which member "runs through" a corner joint. Uprights (Y) are through members,
 * X beams run through Z beams. Lower-priority members butt against
 * higher-priority ones and are trimmed back to the partner's face.
 */
/**
 * Which member runs through a corner and which one butts into it.
 *
 * Only corners need this — where an end lands mid-span the answer is obvious. Two ways are
 * both built every day and they are not equivalent: a rail sitting on top of a post carries
 * its load straight down the post in compression, while a post running past the rail leaves
 * the rail hanging on its bolts. `rails` is the first, `posts` the second.
 */
export type ThroughRule = 'rails' | 'posts'

const PRIORITY: Record<ThroughRule, Record<Axis, number>> = {
  posts: { y: 3, x: 2, z: 1 },
  rails: { x: 3, z: 2, y: 1 },
}

let throughRule: ThroughRule = 'rails'
export function setThroughRule(rule: ThroughRule) { throughRule = rule }
export function getThroughRule(): ThroughRule { return throughRule }

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

/** how far along `d` this end sits from the near face of `r`'s body: + cut back, − extend */
function faceTrimAgainst(endPt: THREE.Vector3, d: THREE.Vector3, r: ProfileData): number {
  const { start, end } = getProfileEndpoints(r)
  const { point } = closestOnSegment(endPt, start, end)
  const along = endPt.clone().sub(point).dot(d)
  return round3(along + crossExtentAlong(r, d))
}

/** a corner is shared when two members reach for the same end of the same post */
const CORNER_TOL = 45
/** an end this close to the ground is standing on it (mm) */
const FLOOR_EPS = 1

function resolveEnd(self: ProfileData, endPt: THREE.Vector3, pDir: THREE.Vector3, pAxis: Axis | null, others: ProfileData[]): EndJoint {
  let buttTrim = -Infinity
  let anyButt = false
  let extend = 0
  let partners = 0
  let continues = false
  /** the corner points we would run out over, so the space there can be contested */
  const cornersClaimed: THREE.Vector3[] = []

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

    const table = PRIORITY[throughRule]
    const pPri = pAxis ? table[pAxis] : 0
    const qPri = qAxis ? table[qAxis] : 0
    /**
     * An end standing on the floor gives way to nobody.
     *
     * "Rails run through" is about the top of a frame: the rail sits across the post and the
     * load goes straight down it. Applied to the bottom corner it says the same thing, and
     * there it is nonsense — it cuts forty millimetres off the foot of the post and leaves it
     * hanging, because nothing can pass underneath a post that is standing on the ground.
     *
     * So a vertical member's lower end holds its ground, and whatever meets it there butts
     * into it instead. Everything above the floor is decided by the rule as before.
     */
    const theyStand = (() => {
      if (qAxis !== 'y') return false
      const { start: qLo, end: qHi } = getProfileEndpoints(q)
      const low = qLo.y <= qHi.y ? qLo : qHi
      return low.y <= FLOOR_EPS && endPt.distanceTo(low) <= CORNER_TOL
    })()
    const weStand = pAxis === 'y' && endPt.y <= FLOOR_EPS
    /**
     * Whether this is Q's end is asked the way Q asks it about us.
     *
     * A rail across the top of a post has its centre line half its own section below the
     * post's end. Seen from the post, the rail's end is right there, so the post gives way.
     * Seen from the rail with only the bare end-point test, it lands twenty short of the end
     * — mid-span — so it butts and cuts back as well. Both gave way, and every such corner
     * was left an empty block the size of the post's section. Q's end counts as reached when
     * it lies within our own section, which is exactly when Q would say we reached it.
     */
    const { start: qS, end: qE } = getProfileEndpoints(q)
    const reach = crossExtentAlong(self, getProfileDir(q)) + 1
    const atQEnd = c.atQEnd || c.axisPoint.distanceTo(qS) <= reach || c.axisPoint.distanceTo(qE) <= reach
    const weButt = theyStand || (!weStand && (!atQEnd || qPri > pPri))
    if (weButt) { anyButt = true; buttTrim = Math.max(buttTrim, toNearFace) }
    else if (pPri > qPri) {
      extend = Math.max(extend, toFarFace)
      cornersClaimed.push(endPt.distanceTo(qS) <= endPt.distanceTo(qE) ? qS : qE)
    }
  }

  // Three members meet at a corner post, and every one that outranks the post wants to run
  // out to its far face — but only one can have that space. Their own ends never touch each
  // other, so the contact test above cannot see the contest: what gives it away is that they
  // reach for the same corner. The one the rule ranks highest runs through; we stop at its
  // face, which is a cut back on one side of the post and no extension at all on the other.
  if (!anyButt && cornersClaimed.length > 0 && pAxis) {
    const table = PRIORITY[throughRule]
    const pPri = table[pAxis]
    let cornerTrim = -Infinity
    for (const r of others) {
      const rAxis = getProfileAxis(r)
      if (!rAxis || rAxis === pAxis || table[rAxis] <= pPri) continue
      const { start: rs, end: re } = getProfileEndpoints(r)
      const shares = cornersClaimed.some((c) => c.distanceTo(rs) <= CORNER_TOL || c.distanceTo(re) <= CORNER_TOL)
      if (!shares) continue
      cornerTrim = Math.max(cornerTrim, faceTrimAgainst(endPt, pDir, r))
    }
    if (isFinite(cornerTrim)) return { trim: cornerTrim, partners, butt: cornerTrim > 0, continues }
  }

  // A butt against a perpendicular partner still applies when a coaxial member carries on
  // from this end: two rails meeting end to end at a post both butt into the post. Letting
  // the continuation win left every such corner uncut, overlapping by half a section.
  // An extension is different — a member that already continues through the joint has
  // nothing to reach for, and extending it would drive it into its own coaxial neighbour.
  if (anyButt) return { trim: round3(buttTrim), partners, butt: true, continues }
  if (continues) return { trim: 0, partners, butt: false, continues: true }
  if (extend > 0) return { trim: round3(-extend), partners, butt: false, continues: false }
  return { trim: 0, partners, butt: false, continues: false }
}

/** Compute how each end of `profile` should be trimmed/extended so members butt cleanly. */
export function computeTrims(profile: ProfileData, all: ProfileData[]): ProfileTrims {
  const others = all.filter((o) => o.id !== profile.id)
  const { start, end } = getProfileEndpoints(profile)
  const dir = getProfileDir(profile)
  const axis = getProfileAxis(profile)
  const s = resolveEnd(profile, start, dir.clone().negate(), axis, others)
  const e = resolveEnd(profile, end, dir, axis, others)
  let cutLength = round3(profile.length - s.trim - e.trim)
  if (!isFinite(cutLength) || cutLength < 1) cutLength = Math.max(1, profile.length)
  return { start: s, end: e, cutLength }
}

/** how far from an end anything that can decide its trim can be: a corner claim reaches
 *  CORNER_TOL past the partner's end, and no section is wider than 40 (mm) */
const REACH = CORNER_TOL + 60

export function computeAllTrims(all: ProfileData[]): Map<string, ProfileTrims> {
  // Each end only ever meets what is near it, so each member is resolved against its
  // neighbours rather than the whole drawing: every member against every other took 81 ms
  // on the twelve-cabinet flat, on every frame of a drag. The answer is the same.
  const boxes = all.map((p) => {
    const { start, end } = getProfileEndpoints(p)
    return new THREE.Box3().setFromPoints([start, end]).expandByScalar(REACH)
  })
  const order = all.map((_, i) => i).sort((a, b) => boxes[a].min.x - boxes[b].min.x)
  const near: number[][] = all.map(() => [])
  for (let a = 0; a < order.length; a++) {
    const A = boxes[order[a]]
    for (let b = a + 1; b < order.length && boxes[order[b]].min.x <= A.max.x; b++) {
      if (!A.intersectsBox(boxes[order[b]])) continue
      near[order[a]].push(order[b]); near[order[b]].push(order[a])
    }
  }
  const map = new Map<string, ProfileTrims>()
  all.forEach((p, i) => {
    // neighbours in drawing order, so ties are broken exactly as before
    const mine = [...near[i], i].sort((a, b) => a - b).map((k) => all[k])
    map.set(p.id, computeTrims(p, mine))
  })
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
