import * as THREE from 'three'
import { useStore, type ProfileData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { getProfileDir, getProfileEndpoints, closestOnSegment, crossExtentAlong, round3 } from './geometryCore'
import { bracketNormal, flushFace, sharedEdge } from './specCompat'
import { unsupportedProfileJoint } from './connectorSupport'
import { specDims } from './specUtils'
import { translations } from './translations'
import { computeAllTrims, computeTrims, withFixedProfileCuts, type ProfileTrims } from './jointUtils'
import { profileBodyEndpoints, profileFace, type ProfileFaceRef } from './profileFaces'
import { reportEditResult } from './editFeedback'

const JOINT_TOL = 30
const FLUSH_TOL = 0.5
/** a shift bigger than this is a different design decision, not a correction (mm) */
const MAX_SHIFT = 60

interface Shift { axis: THREE.Vector3; amount: number }
type Endpoints = ReturnType<typeof getProfileEndpoints>

/** Equal distances keep the starting endpoint, matching the original stable sort. */
function closestTouch(start: THREE.Vector3, end: THREE.Vector3, other: Endpoints, startOnly: boolean) {
  const startDistance = closestOnSegment(start, other.start, other.end).point.distanceTo(start)
  if (startOnly) return { pt: start, d: startDistance }
  const endDistance = closestOnSegment(end, other.start, other.end).point.distanceTo(end)
  return endDistance < startDistance ? { pt: end, d: endDistance } : { pt: start, d: startDistance }
}

export interface DrawingFaceOptions {
  startFace?: ProfileFaceRef | null
  /** A boundary plane the new section shares while its end seats on startFace. */
  startAlignmentFace?: ProfileFaceRef | null
  endFace?: ProfileFaceRef | null
  /** For a face-constrained drawing, this is the actual cut length requested by the user. */
  exactLength?: number
}

export type DrawingFaceIssue = 'face-direction' | 'face-oblique' | 'face-end-conflict' | 'face-too-short'
export interface DrawingFacePlacement {
  profile: ProfileData
  issue: DrawingFaceIssue | null
  blocked: boolean
  /** Existing solids whose accepted attachment faces must survive adding this member. */
  referenceProfiles?: ProfileData[]
}

/**
 * How far a member would have to move, perpendicular to itself, for a bracket to lie flat
 * across this joint. Zero when it already does, null when no face pair is close enough to
 * be worth reaching for.
 */
function shiftForJoint(a: ProfileData, b: ProfileData, at: THREE.Vector3): Shift | null {
  // This operation only aligns matching outside dimensions; hardware compatibility is checked separately.
  if (!sharedEdge(a.spec, b.spec)) return null
  const n = bracketNormal(a, b)
  if (!n) return null
  const ea = crossExtentAlong(a, n)
  const eb = crossExtentAlong(b, n)
  const aBase = new THREE.Vector3(...a.position).sub(at).dot(n)
  const bBase = new THREE.Vector3(...b.position).sub(at).dot(n)

  // Only a step caused by the two sections being different sizes is ours to close. When the
  // centrelines already sit apart, the gap is where the member was put, not how thick it is —
  // correcting that would turn a five-millimetre slip of the mouse into an authoritative
  // position, and it would outvote the real correction because it is smaller.
  if (Math.abs(aBase - bBase) > FLUSH_TOL) return null

  // Prefer the outside plane when two corrections have the same distance.
  let best: { delta: number; outward: number } | null = null
  for (const sa of [1, -1]) {
    for (const sb of [1, -1]) {
      const delta = (bBase + sb * eb) - (aBase + sa * ea)
      if (Math.abs(delta) > MAX_SHIFT) continue
      const outward = Math.abs(bBase + sb * eb)   // how far the shared plane is from the partner's axis
      if (!best || outward > best.outward + 0.01
        || (Math.abs(outward - best.outward) < 0.01 && Math.abs(delta) < Math.abs(best.delta))) {
        best = { delta, outward }
      }
    }
  }
  return best === null ? null : { axis: n, amount: best.delta }
}

/**
 * Turn the section a quarter turn if that makes more of its joints flush than leaving it.
 * Returns the turned member, or null when turning is no help or there is nothing to turn.
 */
function tryRoll(candidate: ProfileData, others: ProfileData[], otherEnds: Endpoints[], startOnly: boolean): ProfileData | null {
  const { w, h } = specDims(candidate.spec)
  if (w === h) return null                      // square: nothing to turn

  const flushCount = (p: ProfileData) => {
    const { start, end } = getProfileEndpoints(p)
    let n = 0
    for (let i = 0; i < others.length; i++) {
      const b = others[i]
      const touch = closestTouch(start, end, otherEnds[i], startOnly)
      if (touch.d > JOINT_TOL) continue
      if (!sharedEdge(p.spec, b.spec)) continue
      if (flushFace(p, b, touch.pt)) n++
    }
    return n
  }

  const asIs = flushCount(candidate)
  const axis = getProfileDir(candidate)
  const spin = new THREE.Quaternion().setFromAxisAngle(axis, Math.PI / 2)
  const q = spin.multiply(new THREE.Quaternion(...candidate.quaternion)).normalize()
  const turned: ProfileData = { ...candidate, quaternion: [q.x, q.y, q.z, q.w] }
  return flushCount(turned) > asIs ? turned : null
}

/**
 * Align a new member's bracket faces with the existing members it meets.
 * Apply the adjustment at creation without moving existing members.
 */
export function faceAlignOnCreate(candidate: ProfileData, others: ProfileData[], startOnly = false): ProfileData {
  if (others.length === 0) return candidate
  // Both roll choices and the final shift use the same unchanged neighbours.
  const otherEnds = others.map(getProfileEndpoints)

  // Try a quarter-turn of rectangular sections before shifting them to align slot planes.
  const rolled = tryRoll(candidate, others, otherEnds, startOnly)
  if (rolled) return rolled

  const { start, end } = getProfileEndpoints(candidate)
  const votes: THREE.Vector3[] = []

  for (let i = 0; i < others.length; i++) {
    const b = others[i]
    const touch = closestTouch(start, end, otherEnds[i], startOnly)
    if (touch.d > JOINT_TOL) continue
    const shift = shiftForJoint(candidate, b, touch.pt)
    if (!shift || Math.abs(shift.amount) <= FLUSH_TOL) continue
    votes.push(shift.axis.clone().multiplyScalar(shift.amount))
  }
  if (votes.length === 0) return candidate

  // the shift the most joints agree on; the smallest wins a tie, because a correction is
  // meant to be the nearest way to make the part fit, not a relocation
  const buckets = new Map<string, { v: THREE.Vector3; n: number }>()
  for (const v of votes) {
    const key = v.toArray().map((x) => Math.round(x * 10) / 10).join(',')
    const cur = buckets.get(key)
    if (cur) cur.n++
    else buckets.set(key, { v, n: 1 })
  }
  const pick = [...buckets.values()].sort((x, y) => y.n - x.n || x.v.length() - y.v.length())[0]
  const p = new THREE.Vector3(...candidate.position).add(pick.v)
  return { ...candidate, position: [round3(p.x), round3(p.y), round3(p.z)] }
}

/** Make an explicitly picked face a geometric constraint, after the usual section roll.
 * Sideways drawing aligns the outward section face. Drawing out of a face pins the
 * actual cut end to it. An end-cap pick followed by a sideways draw keeps the existing
 * corner/through-member convention instead of inventing another constraint. */
export function constrainDrawingFaces(
  candidate: ProfileData, others: ProfileData[], options: DrawingFaceOptions,
): DrawingFacePlacement {
  let profile = candidate
  let issue: DrawingFaceIssue | null = null
  const dir = getProfileDir(candidate)
  type Constraint = { normal: THREE.Vector3; plane: number; kind: 'side' | 'end'; direction: number }
  const constraint = (ref: ProfileFaceRef | null | undefined, end: boolean, alignCap = false): Constraint | 'oblique' | null => {
    const target = ref && others.find((p) => p.id === ref.profileId)
    if (!ref || !target) return null
    const face = profileFace(target, ref, computeTrims(target, others))
    const normal = new THREE.Vector3(...face.normal)
    const direction = normal.dot(dir)
    // Endpoints used only as remote alignment references are not physical attachments.
    if (end) {
      const point = getProfileEndpoints(profile).end
      const center = new THREE.Vector3(...face.center)
      for (const [a, b] of [[0, 1], [1, 2]]) {
        const edge = new THREE.Vector3(...face.corners[b]).sub(new THREE.Vector3(...face.corners[a]))
        const half = edge.length() / 2
        edge.normalize()
        if (Math.abs(point.clone().sub(center).dot(edge)) > half + crossExtentAlong(profile, edge) + 0.001) return null
      }
    }
    if (!alignCap && ref.axis === 2 && Math.abs(direction) < 1 - 1e-6) return null
    if (Math.abs(direction) > 1 - 1e-6) return { normal, plane: centerPlane(face.center, normal), kind: 'end', direction }
    if (Math.abs(direction) < 1e-6) {
      const rotation = new THREE.Quaternion(...profile.quaternion).normalize()
      const parallelSide = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)]
        .some((axis) => Math.abs(axis.applyQuaternion(rotation).dot(normal)) > 1 - 1e-6)
      if (!parallelSide) return 'oblique'
      return { normal, plane: centerPlane(face.center, normal), kind: 'side', direction }
    }
    return 'oblique'
  }
  const start = constraint(options.startFace, false)
  if (start === 'oblique') return { profile, issue: 'face-oblique', blocked: true }
  if (start?.kind === 'end' && start.direction < 0) return { profile, issue: 'face-direction', blocked: true }

  const moveSideTo = (face: Constraint, preserve?: Constraint | null): boolean => {
    const target = face.plane - crossExtentAlong(profile, face.normal)
    const delta = target - new THREE.Vector3(...profile.position).dot(face.normal)
    if (Math.abs(delta) <= 0.001) return true
    // Once the first face and point have been chosen, another face may not slide the
    // whole member along that first face. Its normal alone is not the user's full intent.
    if (preserve) return false
    const position = new THREE.Vector3(...profile.position).addScaledVector(face.normal, delta)
    profile = { ...profile, position: position.toArray().map(round3) as [number, number, number] }
    return true
  }
  if (start?.kind === 'side') moveSideTo(start)
  // A side-face edge pick carries two separate choices: the new cut end rests on
  // that face, and its outer section side is flush with the target's actual end.
  // Keep ordinary cap picks on their legacy corner/through-member path above.
  if (start?.kind === 'end' && options.startAlignmentFace
    && options.startAlignmentFace.profileId === options.startFace?.profileId) {
    const alignment = constraint(options.startAlignmentFace, false, true)
    if (alignment && alignment !== 'oblique' && alignment.kind === 'side') moveSideTo(alignment)
  }
  const end = constraint(options.endFace, true)
  let acceptedEnd: Constraint | null = null
  if (end === 'oblique' || (end?.kind === 'end' && end.direction > 0)) issue = 'face-end-conflict'
  else if (end) {
    if (end.kind === 'side' && !moveSideTo(end, start)) issue = 'face-end-conflict'
    else acceptedEnd = end
  }

  const hasConstraint = !!start || !!acceptedEnd
  const exact = hasConstraint && Number.isFinite(options.exactLength) ? options.exactLength : undefined
  const preserveReferences = () => {
    if (!start && !acceptedEnd) return undefined
    // Resolve before introducing the new member: its joint must not move the face
    // the user has already selected. Snapshot the whole existing scene together:
    // fixing only that reference could recut its still-automatic neighbours.
    return withFixedProfileCuts(others)
  }
  let referenceProfiles = preserveReferences()
  const sideAttachmentTrim = (face: Constraint | null, ref: ProfileFaceRef | null | undefined, atEnd: boolean): number | null => {
    const target = ref && referenceProfiles?.find((p) => p.id === ref.profileId)
    if (face?.kind !== 'side' || !target) return null
    const targetDir = getProfileDir(target)
    if (Math.abs(targetDir.dot(dir)) > 1e-6) return null
    const ends = profileBodyEndpoints(target)
    const center = ends.start.clone().add(ends.end).multiplyScalar(0.5)
    const point = atEnd ? getProfileEndpoints(profile).end : new THREE.Vector3(...profile.position)
    // Only the actual finite side can receive the new end. A shared outer plane
    // alone does not make a remote alignment reference a physical attachment.
    for (const [axis, half] of [[targetDir, ends.start.distanceTo(ends.end) / 2],
      [face.normal, crossExtentAlong(target, face.normal)]] as const) {
      if (Math.abs(point.clone().sub(center).dot(axis)) >= half + crossExtentAlong(profile, axis) - 1e-6) return null
    }
    const half = crossExtentAlong(target, dir)
    const along = point.clone().sub(center).dot(dir)
    if (Math.abs(along) > half + 0.001) return null
    // A chosen side fixes the existing solid. The incoming member must butt against
    // its perpendicular face, even where the automatic through rule would extend it.
    return atEnd ? along + half : half - along
  }
  const startSideTrim = sideAttachmentTrim(start, options.startFace, false)
  let endSideTrim = sideAttachmentTrim(acceptedEnd, options.endFace, true)
  // Side constraints change the location used by the joint analysis; only analyse after
  // resolving them so the preview and the committed part get the same cuts.
  if (start?.kind === 'end' || acceptedEnd?.kind === 'end' || startSideTrim !== null || endSideTrim !== null || exact !== undefined) {
    const trims = computeTrims(profile, [...(referenceProfiles ?? others), profile])
    const position = new THREE.Vector3(...profile.position)
    let startTrim = start?.kind === 'end' ? (start.plane - position.dot(start.normal)) / start.direction : startSideTrim ?? trims.start.trim
    let endTrim = acceptedEnd?.kind === 'end'
      ? (position.clone().addScaledVector(dir, profile.length).dot(acceptedEnd.normal) - acceptedEnd.plane) / acceptedEnd.direction
      : endSideTrim ?? trims.end.trim
    if (exact !== undefined) {
      if ((acceptedEnd?.kind === 'end' || endSideTrim !== null) && Math.abs(profile.length - startTrim - endTrim - exact) > 0.001) {
        issue = 'face-end-conflict'
        acceptedEnd = null
        endSideTrim = null
        referenceProfiles = preserveReferences()
        if (start?.kind !== 'end') startTrim = startSideTrim ?? computeTrims(profile, [...(referenceProfiles ?? others), profile]).start.trim
      }
      // A typed physical length owns the far end; an unrelated automatic cut there must
      // not shorten it again. The attachment at the chosen start face remains fixed.
      endTrim = acceptedEnd?.kind === 'end' || endSideTrim !== null ? endTrim : 0
      profile = { ...profile, length: round3(exact + startTrim + endTrim) }
    }
    startTrim = round3(startTrim); endTrim = round3(endTrim)
    if (profile.length - startTrim - endTrim < 10) return { profile, issue: 'face-too-short', blocked: true }
    profile = { ...profile, fixedTrims: { start: startTrim, end: endTrim } }
  }
  return { profile, issue, blocked: false, referenceProfiles }
}

function centerPlane(center: [number, number, number], normal: THREE.Vector3): number {
  return new THREE.Vector3(...center).dot(normal)
}

/**
 * Count each inferred joint once when no supported connector type can seat there.
 * Check seating directly, independently of whether shiftForJoint offers a correction.
 */
export function countUnflush(profiles: ProfileData[]): number {
  return unflushPairs(profiles).length
}

/** Return the identities of joints for which no supported connector seat is found. */
export function unflushPairs(profiles: ProfileData[], trims: Map<string, ProfileTrims> = computeAllTrims(profiles)): Array<{ a: string; b: string; at: [number, number, number] }> {
  const ends = new Map(profiles.map((p) => [p.id, getProfileEndpoints(p)]))
  const seen = new Map<string, { a: string; b: string; at: [number, number, number] }>()
  for (const a of profiles) {
    const ea = ends.get(a.id)!
    for (const b of profiles) {
      if (a.id === b.id) continue
      const eb = ends.get(b.id)!
      const touch = [ea.start, ea.end]
        .map((pt) => ({ pt, d: closestOnSegment(pt, eb.start, eb.end).point.distanceTo(pt) }))
        .sort((x, y) => x.d - y.d)[0]
      if (touch.d > JOINT_TOL) continue
      if (!bracketNormal(a, b)) continue
      if (!unsupportedProfileJoint(a, b, touch.pt, trims)) continue
      const key = [a.id, b.id].sort().join('|')
      if (!seen.has(key)) seen.set(key, { a: a.id, b: b.id, at: touch.pt.toArray() as [number, number, number] })
    }
  }
  return [...seen.values()]
}

/** Turn a member's section a quarter turn about its own axis (2040 on edge ↔ lying flat) */
export function rollProfile(id: string, quarters = 1): boolean {
  const store = useStore.getState()
  const p = store.profiles.find((q) => q.id === id)
  const t = translations[useToolStore.getState().language]
  if (!p) return false
  if (p.locked) { useToolStore.getState().showToast(t.toastLocked, 'error'); return false }
  const axis = getProfileDir(p)
  const spin = new THREE.Quaternion().setFromAxisAngle(axis, (Math.PI / 2) * quarters)
  const q = spin.multiply(new THREE.Quaternion(...p.quaternion)).normalize()
  return reportEditResult(store.commitTransform({ profiles: [{ id, updates: { quaternion: [q.x, q.y, q.z, q.w] } }] }))
}

/** Which way a rectangular section is turned, for the panel: the direction its long side faces */
export function sectionFacing(p: ProfileData): THREE.Vector3 {
  const quat = new THREE.Quaternion(...p.quaternion).normalize()
  const { w, h } = { w: Number(p.spec.slice(0, 2)), h: Number(p.spec.slice(2)) }
  const long = h >= w ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
  return long.applyQuaternion(quat)
}
