import * as THREE from 'three'
import type { ProfileData } from '../store/useStore'
import type { DrawingFaceOptions, DrawingFacePlacement } from './faceAlign'
import { createTrimResolver, type ProfileTrims } from './jointUtils'
import { profileFace, type FacePoint, type ProfileFace } from './profileFaces'

export interface DrawingContact {
  end: 'start' | 'end'
  kind: 'contact' | 'flush' | 'align' | 'rejected'
  referenceFace: ProfileFace
  memberFace: ProfileFace | null
  referenceAnchor: FacePoint
  memberAnchor: FacePoint
  /** World-space, finite positive-area intersection; absent for an alignment or refusal. */
  patch: FacePoint[] | null
}

const FACE_EPS = 0.001
const NORMAL_EPS = 1e-6
type Point2 = [number, number]
const vector = (point: FacePoint | THREE.Vector3) => point instanceof THREE.Vector3 ? point.clone() : new THREE.Vector3(...point)
const tuple = (point: THREE.Vector3) => point.toArray() as FacePoint

function faceFrame(face: ProfileFace) {
  const origin = vector(face.corners[0])
  const u = vector(face.corners[1]).sub(origin)
  const v = vector(face.corners[3]).sub(origin)
  const width = u.length(), height = v.length()
  u.normalize(); v.normalize()
  return { origin, u, v, width, height }
}

/** Project onto the actual finite rectangle, including its trimmed ends and section roll. */
export function closestPointOnFace(face: ProfileFace, point: FacePoint | THREE.Vector3): FacePoint {
  const { origin, u, v, width, height } = faceFrame(face)
  const relative = vector(point).sub(origin)
  return tuple(origin.addScaledVector(u, THREE.MathUtils.clamp(relative.dot(u), 0, width))
    .addScaledVector(v, THREE.MathUtils.clamp(relative.dot(v), 0, height)))
}

function clip(poly: Point2[], axis: 0 | 1, bound: number, lower: boolean): Point2[] {
  const out: Point2[] = []
  if (!poly.length) return out
  const inside = (point: Point2) => lower ? point[axis] >= bound : point[axis] <= bound
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    const aIn = inside(a), bIn = inside(b)
    if (aIn) out.push(a)
    if (aIn !== bIn) {
      const t = (bound - a[axis]) / (b[axis] - a[axis])
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
    }
  }
  return out
}

function samePlane(reference: ProfileFace, member: ProfileFace): boolean {
  const normal = vector(reference.normal)
  if (Math.abs(normal.dot(vector(member.normal))) < 1 - NORMAL_EPS) return false
  const origin = vector(reference.corners[0])
  return member.corners.every((point) => Math.abs(vector(point).sub(origin).dot(normal)) <= FACE_EPS)
}

/** Clip the real face quadrilaterals in their own plane; AABB overlap is insufficient. */
function intersection(reference: ProfileFace, member: ProfileFace): { patch: FacePoint[]; center: FacePoint } | null {
  if (!samePlane(reference, member)) return null
  const { origin, u, v, width, height } = faceFrame(reference)
  const relative = member.corners.map((point) => vector(point).sub(origin))
  let poly: Point2[] = relative.map((point) => [point.dot(u), point.dot(v)])
  poly = clip(clip(clip(clip(poly, 0, 0, true), 0, width, false), 1, 0, true), 1, height, false)
  // Boundary intersections can repeat a vertex. Keep a clean polygon for the renderer.
  poly = poly.filter((point, i) => !poly.slice(0, i).some((other) => Math.hypot(point[0] - other[0], point[1] - other[1]) < 1e-7))
  if (poly.length < 3) return null
  let area2 = 0, centerU = 0, centerV = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    const cross = a[0] * b[1] - b[0] * a[1]
    area2 += cross; centerU += (a[0] + b[0]) * cross; centerV += (a[1] + b[1]) * cross
  }
  if (Math.abs(area2) < FACE_EPS * FACE_EPS
    || Math.max(...poly.map((p) => p[0])) - Math.min(...poly.map((p) => p[0])) <= FACE_EPS
    || Math.max(...poly.map((p) => p[1])) - Math.min(...poly.map((p) => p[1])) <= FACE_EPS) return null
  const world = (point: Point2) => tuple(origin.clone().addScaledVector(u, point[0]).addScaledVector(v, point[1]))
  return { patch: poly.map(world), center: world([centerU / (3 * area2), centerV / (3 * area2)]) }
}

/** Closest pair on two finite segments, also handling parallel edges. */
function closestEdges(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) {
  const u = b.clone().sub(a), v = d.clone().sub(c), w = a.clone().sub(c)
  const aa = u.dot(u), bb = u.dot(v), cc = v.dot(v), dd = u.dot(w), ee = v.dot(w)
  const denominator = aa * cc - bb * bb
  let s = denominator > 1e-12 ? THREE.MathUtils.clamp((bb * ee - cc * dd) / denominator, 0, 1) : 0
  let t = cc > 1e-12 ? (bb * s + ee) / cc : 0
  if (t < 0) { t = 0; s = aa > 1e-12 ? THREE.MathUtils.clamp(-dd / aa, 0, 1) : 0 }
  else if (t > 1) { t = 1; s = aa > 1e-12 ? THREE.MathUtils.clamp((bb - dd) / aa, 0, 1) : 0 }
  return [a.clone().addScaledVector(u, s), c.clone().addScaledVector(v, t)] as const
}

function closestAnchors(reference: ProfileFace, member: ProfileFace) {
  let distance = Infinity
  let referenceAnchor = reference.center, memberAnchor = member.center
  const consider = (a: FacePoint, b: FacePoint) => {
    const squared = vector(a).distanceToSquared(vector(b))
    if (squared >= distance) return
    distance = squared; referenceAnchor = a; memberAnchor = b
  }
  for (const point of reference.corners) consider(point, closestPointOnFace(member, point))
  for (const point of member.corners) consider(closestPointOnFace(reference, point), point)
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    const [a, b] = closestEdges(vector(reference.corners[i]), vector(reference.corners[(i + 1) % 4]),
      vector(member.corners[j]), vector(member.corners[(j + 1) % 4]))
    consider(tuple(a), tuple(b))
  }
  return { referenceAnchor, memberAnchor }
}

function facesOf(profile: ProfileData, trims: ProfileTrims): ProfileFace[] {
  return ([0, 1, 2] as const).flatMap((axis) => ([-1, 1] as const)
    .map((side) => profileFace(profile, { profileId: profile.id, axis, side }, trims)))
}

/** Describe the final solids, rather than repeating the face the pointer initially chose. */
export function drawingContacts(
  profile: ProfileData, trims: ProfileTrims, referenceProfiles: ProfileData[], faces: DrawingFaceOptions,
  status: Pick<DrawingFacePlacement, 'issue' | 'blocked'> = { issue: null, blocked: false },
): DrawingContact[] {
  if (!faces.startFace && !faces.endFace) return []
  const resolve = createTrimResolver([...referenceProfiles, profile])
  const memberFaces = facesOf(profile, trims)
  const contacts: DrawingContact[] = []
  for (const end of ['start', 'end'] as const) {
    const selected = end === 'start' ? faces.startFace : faces.endFace
    const target = selected && referenceProfiles.find((p) => p.id === selected.profileId)
    if (!selected || !target) continue
    const referenceFaces = facesOf(target, resolve(target))
    const reference = referenceFaces.find((face) => face.axis === selected.axis && face.side === selected.side)!
    const cap = memberFaces.find((face) => face.axis === 2 && face.side === (end === 'start' ? -1 : 1))!
    const fallback = (kind: 'align' | 'rejected', memberFace = cap): DrawingContact => ({ end, kind, referenceFace: reference,
      memberFace, ...closestAnchors(reference, memberFace), patch: null })
    if (status.blocked || (end === 'end' && status.issue === 'face-end-conflict')) {
      contacts.push(fallback('rejected'))
      continue
    }
    const match = (referenceFace: ProfileFace, memberFace: ProfileFace, kind: 'contact' | 'flush'): DrawingContact | null => {
      const dot = vector(referenceFace.normal).dot(vector(memberFace.normal))
      if (kind === 'contact' ? dot > -1 + NORMAL_EPS : dot < 1 - NORMAL_EPS) return null
      const overlap = intersection(referenceFace, memberFace)
      if (!overlap) return null
      return { end, kind, referenceFace, memberFace, referenceAnchor: overlap.center,
        memberAnchor: closestPointOnFace(memberFace, overlap.center), patch: kind === 'contact' ? overlap.patch : null }
    }
    // The picked outer side can be a flush reference while the real new end butts
    // against another face of that same target. Report the actual attachment first.
    let contact = referenceFaces.map((face) => match(face, cap, 'contact')).find((value) => value !== null)
    // The legacy through-member corner seats a new side on the selected end cap.
    contact ??= memberFaces.map((face) => match(reference, face, 'contact')).find((value) => value !== null)
    contact ??= memberFaces.map((face) => match(reference, face, 'flush')).find((value) => value !== null)
    const aligned = samePlane(reference, cap) ? cap : memberFaces.find((face) =>
      vector(reference.normal).dot(vector(face.normal)) > 1 - NORMAL_EPS && samePlane(reference, face))
    contacts.push(contact ?? (aligned ? fallback('align', aligned) : fallback('rejected')))
  }
  return contacts
}
