import * as THREE from 'three'
import type { ProfileData } from '../store/useStore'
import { specDims } from './specUtils'
import { getProfileEndpoints, getProfileDir, getProfileAxis, crossExtentAlong, round3, endContactsBody, closestOnSegment, JOINT_EPS, profileGeometry, type ProfileGeometry, type Axis } from './geometryCore'

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
function faceTrimAgainst(endPt: THREE.Vector3, d: THREE.Vector3, r: ProfileData, geometry?: ProfileGeometry): number {
  const { start, end } = geometry ?? getProfileEndpoints(r)
  const { point } = closestOnSegment(endPt, start, end)
  const along = endPt.clone().sub(point).dot(d)
  return round3(along + crossExtentAlong(r, d, geometry))
}

/** a corner is shared when two members reach for the same end of the same post */
const CORNER_TOL = 45
/** an end this close to the ground is standing on it (mm) */
const FLOOR_EPS = 1

function resolveEnd(self: ProfileData, endPt: THREE.Vector3, pDir: THREE.Vector3, pAxis: Axis | null, others: ProfileData[], geometry?: Map<ProfileData, ProfileGeometry>, rule: ThroughRule = throughRule): EndJoint {
  let buttTrim = -Infinity
  let anyButt = false
  let extend = 0
  let partners = 0
  let continues = false
  /** the corner points we would run out over, so the space there can be contested */
  const cornersClaimed: THREE.Vector3[] = []

  for (const q of others) {
    const qGeometry = geometry?.get(q)
    const qAxis = qGeometry ? qGeometry.axis : getProfileAxis(q)
    if (pAxis && qAxis && pAxis === qAxis) {
      // coaxial continuation: a parallel member whose end meets ours → plain end-to-end, never trimmed or extended
      const { start: qs, end: qe } = qGeometry ?? getProfileEndpoints(q)
      if (endPt.distanceTo(qs) <= JOINT_EPS || endPt.distanceTo(qe) <= JOINT_EPS) { continues = true; partners++ }
      continue
    }
    const c = endContactsBody(endPt, pDir, q, 1, qGeometry)
    if (!c) continue
    partners++
    const toNearFace = round3(c.along + c.extentAlong)   // cut back so our end sits on Q's near face
    const toFarFace = round3(c.extentAlong - c.along)    // extend so our end reaches Q's far face

    const table = PRIORITY[rule]
    const pPri = pAxis ? table[pAxis] : 0
    const qPri = qAxis ? table[qAxis] : 0
    /** Preserve the lower end of a vertical member on the floor, regardless of the corner policy. */
    const theyStand = (() => {
      if (qAxis !== 'y') return false
      const { start: qLo, end: qHi } = qGeometry ?? getProfileEndpoints(q)
      const low = qLo.y <= qHi.y ? qLo : qHi
      return low.y <= FLOOR_EPS && endPt.distanceTo(low) <= CORNER_TOL
    })()
    const weStand = pAxis === 'y' && endPt.y <= FLOOR_EPS
    /** Classify the contact at Q's end using this member's section extent, symmetrically with Q. */
    const { start: qS, end: qE } = qGeometry ?? getProfileEndpoints(q)
    const reach = crossExtentAlong(self, qGeometry?.dir ?? getProfileDir(q), geometry?.get(self)) + 1
    const atQEnd = c.atQEnd || c.axisPoint.distanceTo(qS) <= reach || c.axisPoint.distanceTo(qE) <= reach
    // A finished neighbour cannot give up material to the automatic through rule.
    // Fit the incoming end to its near face even when that end normally outranks it.
    const weButt = !!q.fixedTrims || theyStand || (!weStand && (!atQEnd || qPri > pPri))
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
    const table = PRIORITY[rule]
    const pPri = table[pAxis]
    let cornerTrim = -Infinity
    for (const r of others) {
      const rGeometry = geometry?.get(r)
      const rAxis = rGeometry ? rGeometry.axis : getProfileAxis(r)
      if (!rAxis || rAxis === pAxis || table[rAxis] <= pPri) continue
      const { start: rs, end: re } = rGeometry ?? getProfileEndpoints(r)
      const shares = cornersClaimed.some((c) => c.distanceTo(rs) <= CORNER_TOL || c.distanceTo(re) <= CORNER_TOL)
      if (!shares) continue
      cornerTrim = Math.max(cornerTrim, faceTrimAgainst(endPt, pDir, r, rGeometry))
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
export function computeTrims(profile: ProfileData, all: ProfileData[], rule: ThroughRule = throughRule): ProfileTrims {
  return computeTrimsWithGeometry(profile, all, undefined, all, undefined, rule)
}

function computeTrimsWithGeometry(
  profile: ProfileData, all: ProfileData[], geometry?: Map<ProfileData, ProfileGeometry>,
  contactScene = all, contactCache?: Map<ProfileData, ProfileGeometry>, rule: ThroughRule = throughRule,
): ProfileTrims {
  const others = all.filter((o) => o.id !== profile.id)
  const own = geometry?.get(profile)
  const { start, end } = own ?? getProfileEndpoints(profile)
  const dir = own?.dir ?? getProfileDir(profile)
  const axis = own ? own.axis : getProfileAxis(profile)
  if (profile.fixedTrims) {
    // Finished parts contact at their visible cut faces. Their design endpoints can
    // remain inside a neighbour even after the real bodies have moved apart.
    const contacts = contactCache ?? new Map<ProfileData, ProfileGeometry>()
    for (const p of [profile, ...others]) {
      if (contacts.has(p)) continue
      const g = geometry?.get(p) ?? profileGeometry(p)
      // Automatic neighbours still use the existing manufacturing calculation. This
      // does not recurse into physical contacts because these neighbours are not fixed.
      const automatic = p.fixedTrims ? null : computeTrimsWithGeometry(p, contactScene, geometry, contactScene, undefined, rule)
      const startTrim = p.fixedTrims?.start ?? automatic!.start.trim
      const cut = p.fixedTrims ? round3(p.length - p.fixedTrims.start - p.fixedTrims.end) : automatic!.cutLength
      const bodyStart = g.start.clone().addScaledVector(g.dir, startTrim)
      const bodyEnd = bodyStart.clone().addScaledVector(g.dir, Number.isFinite(cut) && cut > 0.1 ? cut : 1)
      contacts.set(p, { ...g, start: bodyStart, end: bodyEnd })
    }
    const body = contacts.get(profile)!
    const s = resolveEnd(profile, body.start, dir.clone().negate(), axis, others, contacts, rule)
    const e = resolveEnd(profile, body.end, dir, axis, others, contacts, rule)
    return { start: { ...s, trim: profile.fixedTrims.start }, end: { ...e, trim: profile.fixedTrims.end },
      cutLength: round3(profile.length - profile.fixedTrims.start - profile.fixedTrims.end) }
  }
  // A new/recalculated member still starts from its design endpoints, but a finished
  // neighbour offers only its actual body, including material cut off or extended.
  let references = geometry
  if (others.some((p) => p.fixedTrims)) {
    references = new Map<ProfileData, ProfileGeometry>()
    for (const p of all) {
      const g = geometry?.get(p) ?? profileGeometry(p)
      if (!p.fixedTrims) { references.set(p, g); continue }
      const bodyStart = g.start.clone().addScaledVector(g.dir, p.fixedTrims.start)
      const cut = round3(p.length - p.fixedTrims.start - p.fixedTrims.end)
      references.set(p, { ...g, start: bodyStart, end: bodyStart.clone().addScaledVector(g.dir, cut) })
    }
  }
  const s = resolveEnd(profile, start, dir.clone().negate(), axis, others, references, rule)
  const e = resolveEnd(profile, end, dir, axis, others, references, rule)
  let cutLength = round3(profile.length - s.trim - e.trim)
  if (!isFinite(cutLength) || cutLength < 1) cutLength = Math.max(1, profile.length)
  return { start: s, end: e, cutLength }
}

/** how far from an end anything that can decide its trim can be: a corner claim reaches
 *  CORNER_TOL past the partner's end, and no section is wider than 40 (mm) */
const REACH = CORNER_TOL + 60

/** Reuse neighbours and geometry only within one unchanged scene, resolving requested
 * members lazily. A moved member or changed joint rule requires a new resolver. */
export function createTrimResolver(all: ProfileData[], rule: ThroughRule = throughRule): (profile: ProfileData) => ProfileTrims {
  const geometry = new Map(all.map((p) => [p, profileGeometry(p)]))
  // Resolve member ends against spatially nearby members.
  const boxes = all.map((p) => {
    const { start, end, dir } = geometry.get(p)!
    const box = new THREE.Box3().setFromPoints([start, end])
    // A determined extension can reach beyond its original design segment. Keep both
    // spans: automatic calculations use design points, fixed contacts use cut faces.
    if (p.fixedTrims) {
      box.expandByPoint(start.clone().addScaledVector(dir, p.fixedTrims.start))
      box.expandByPoint(end.clone().addScaledVector(dir, -p.fixedTrims.end))
    }
    return box.expandByScalar(REACH)
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
  const indices = new Map(all.map((p, i) => [p, i]))
  const resolved = new Map<ProfileData, ProfileTrims>()
  const contacts = new Map<ProfileData, ProfileGeometry>()
  return (p) => {
    const cached = resolved.get(p)
    if (cached) return cached
    const i = indices.get(p)
    // Preserve drawing order when resolving ties.
    const mine = i === undefined ? all : [...near[i], i].sort((a, b) => a - b).map((k) => all[k])
    const trims = computeTrimsWithGeometry(p, mine, geometry, all, contacts, rule)
    resolved.set(p, trims)
    return trims
  }
}

export function computeAllTrims(all: ProfileData[], rule: ThroughRule = throughRule): Map<string, ProfileTrims> {
  const resolve = createTrimResolver(all, rule)
  return new Map(all.map((p) => [p.id, resolve(p)]))
}

/** Store the visible cut faces before an edit, without changing geometry or the input. */
export function withFixedProfileCuts(all: ProfileData[], ids?: ReadonlySet<string>, rule: ThroughRule = throughRule): ProfileData[] {
  const needsCut = (p: ProfileData) => !p.fixedTrims && (!ids || ids.has(p.id))
  if (!all.some(needsCut)) return all
  const resolve = createTrimResolver(all, rule)
  return all.map((p) => {
    if (!needsCut(p)) return p
    const t = resolve(p)
    // Preserve the renderer's actual span, including the legacy short-cut fallback.
    return { ...p, fixedTrims: { start: t.start.trim, end: round3(p.length - t.start.trim - t.cutLength) } }
  })
}

/** A fixed cut may extend either end, but it must leave a finite, visible part. */
export function validFixedProfileCut(p: Pick<ProfileData, 'length' | 'fixedTrims'>): boolean {
  if (!p.fixedTrims) return true
  const { start, end } = p.fixedTrims
  return Number.isFinite(start) && Number.isFinite(end)
    && Number.isFinite(p.length - start - end) && p.length - start - end >= 1 - 1e-7
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
