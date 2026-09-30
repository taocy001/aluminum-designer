import * as THREE from 'three'
import type { ProfileData } from '../store/useStore'
import type { Axis3, SnapGuide } from './dragSnap'
import type { ProfileTrims } from './jointUtils'
import { getProfileEndpoints } from './geometryCore'
import { profileBodyEndpoints, profileFace, profileFaceForWorldAxis, type FacePoint, type ProfileFace } from './profileFaces'

const EPS = 0.001
const v = (p: FacePoint) => new THREE.Vector3(...p)
const tuple = (p: THREE.Vector3) => p.toArray() as FacePoint

export interface EditAlignment {
  axis: Axis3 | null
  kind: SnapGuide['kind']
  movingId: string
  refId: string
  movingFace: ProfileFace | null
  referenceFace: ProfileFace | null
  from: FacePoint
  to: FacePoint
  /** Extend through both bodies so coincident contact centres still have a visible guide. */
  line: [FacePoint, FacePoint]
}

export interface EditAlignmentRequest {
  movingIds: string[]
  axes?: readonly Axis3[]
  guides?: readonly SnapGuide[]
  resize?: { id: string; end: 'start' | 'end' } | null
}

function extendedLine(from: FacePoint, to: FacePoint, faces: Array<ProfileFace | null>, normal?: THREE.Vector3): [FacePoint, FacePoint] {
  const origin = v(from), along = v(to).sub(origin)
  if (normal) along.addScaledVector(normal, -along.dot(normal))
  if (along.lengthSq() < EPS ** 2) {
    const face = faces.find((item) => item !== null)
    if (face) along.copy(v(face.corners[1]).sub(v(face.corners[0])))
    else {
      along.set(1, 0, 0)
      if (normal && Math.abs(normal.x) > 0.9) along.set(0, 0, 1)
    }
  }
  along.normalize()
  const points = [from, to, ...faces.flatMap((face) => face?.corners ?? [])]
  const distances = points.map((point) => v(point).sub(origin).dot(along))
  const low = Math.min(...distances), high = Math.max(...distances)
  const padding = THREE.MathUtils.clamp((high - low) * 0.08, 20, 60)
  return [tuple(origin.clone().addScaledVector(along, low - padding)), tuple(origin.addScaledVector(along, high + padding))]
}

function coplanar(a: ProfileFace, b: ProfileFace): boolean {
  const normal = v(a.normal)
  return Math.abs(normal.dot(v(b.normal))) > 1 - 1e-6
    && b.corners.every((point) => Math.abs(v(point).sub(v(a.center)).dot(normal)) < EPS)
}

function faceRelation(moving: ProfileFace, reference: ProfileFace, axis: Axis3 | null, kind: SnapGuide['kind']): EditAlignment {
  return { axis, kind, movingId: moving.profileId, refId: reference.profileId,
    movingFace: moving, referenceFace: reference, from: moving.center, to: reference.center,
    line: extendedLine(moving.center, reference.center, [moving, reference], v(reference.normal)) }
}

/** Feedback only: inspect the final cut solids without moving, stretching or re-cutting them. */
export function editAlignments(profiles: ProfileData[], trims: Map<string, ProfileTrims>, request: EditAlignmentRequest): EditAlignment[] {
  const movingIds = new Set(request.movingIds)
  const moving = profiles.filter((p) => movingIds.has(p.id))
  const references = profiles.filter((p) => !movingIds.has(p.id))
  if (!moving.length || !references.length) return []
  const byId = new Map(profiles.map((p) => [p.id, p]))
  const faces = new Map<string, ProfileFace[]>()
  const allFaces = (p: ProfileData) => {
    let result = faces.get(p.id)
    if (!result) {
      result = ([0, 1, 2] as const).flatMap((axis) => ([-1, 1] as const)
        .map((side) => profileFace(p, { profileId: p.id, axis, side }, trims.get(p.id))))
      faces.set(p.id, result)
    }
    return result
  }
  const center = (p: ProfileData) => {
    const ends = profileBodyEndpoints(p, trims.get(p.id))
    return ends.start.add(ends.end).multiplyScalar(0.5)
  }
  const boundary = (p: ProfileData, axis: Axis3, side: -1 | 1) => {
    const coords = allFaces(p).flatMap((face) => face.corners.map((point) => point[axis]))
    return side < 0 ? Math.min(...coords) : Math.max(...coords)
  }
  const nearest = (candidates: EditAlignment[]) => candidates.sort((a, b) => {
    const rank = (c: EditAlignment) => c.kind === 'end' ? 0 : c.kind === 'center' ? 2 : 1
    return v(a.from).distanceTo(v(a.to)) + rank(a) * 10 - v(b.from).distanceTo(v(b.to)) - rank(b) * 10
  })[0]
  const coordinateRelation = (p: ProfileData, ref: ProfileData, axis: Axis3, coord: number, kind: SnapGuide['kind'], at?: THREE.Vector3): EditAlignment => {
    const normal = new THREE.Vector3().setComponent(axis, 1)
    const from = tuple((at ?? center(p)).setComponent(axis, coord))
    const to = tuple(center(ref).setComponent(axis, coord))
    return { axis, kind, movingId: p.id, refId: ref.id, movingFace: null, referenceFace: null,
      from, to, line: extendedLine(from, to, [], normal) }
  }

  if (request.resize) {
    const p = moving.find((part) => part.id === request.resize!.id)
    if (!p) return []
    const cap = allFaces(p).find((face) => face.axis === 2 && face.side === (request.resize!.end === 'start' ? -1 : 1))!
    const candidates: EditAlignment[] = []
    for (const ref of references) for (const face of allFaces(ref)) {
      if (!coplanar(cap, face)) continue
      const axis = cap.normal.findIndex((component) => Math.abs(component) > 1 - 1e-6)
      candidates.push(faceRelation(cap, face, axis < 0 ? null : axis as Axis3, face.axis === 2 ? 'end' : 'align'))
    }
    const best = nearest(candidates)
    return best ? [best] : []
  }

  const result: EditAlignment[] = []
  const handled = new Set<Axis3>()
  for (const guide of request.guides ?? []) {
    const ref = byId.get(guide.refId), p = byId.get(guide.movingId ?? moving[0].id)
    if (!ref || !p || !movingIds.has(p.id)) continue
    if (guide.kind === 'endpoint') {
      const a = getProfileEndpoints(p), b = getProfileEndpoints(ref)
      for (const side of [-1, 1] as const) for (const refSide of [-1, 1] as const) {
        if ((side < 0 ? a.start : a.end).distanceTo(refSide < 0 ? b.start : b.end) > EPS) continue
        const first = profileFace(p, { profileId: p.id, axis: 2, side }, trims.get(p.id))
        const second = profileFace(ref, { profileId: ref.id, axis: 2, side: refSide }, trims.get(ref.id))
        const relation = faceRelation(first, second, null, 'endpoint')
        relation.line = extendedLine(first.center, second.center, [])
        result.push(relation)
      }
      continue
    }
    const first = guide.movingSide === undefined ? null : profileFaceForWorldAxis(p, guide.axis, guide.movingSide, trims.get(p.id))
    const second = guide.refSide === undefined ? null : profileFaceForWorldAxis(ref, guide.axis, guide.refSide, trims.get(ref.id))
    if (first && second) {
      // The floor or a late exact edit can invalidate a previously computed snap.
      if (!coplanar(first, second)) continue
      result.push(faceRelation(first, second, guide.axis, guide.kind))
    } else {
      if (guide.movingSide !== undefined && Math.abs(boundary(p, guide.axis, guide.movingSide) - guide.coord) > EPS) continue
      if (guide.refSide !== undefined && Math.abs(boundary(ref, guide.axis, guide.refSide) - guide.coord) > EPS) continue
      let at = center(p)
      if (guide.kind === 'center' && moving.length > 1) {
        const bounds = new THREE.Box3()
        for (const part of moving) for (const face of allFaces(part)) for (const point of face.corners) bounds.expandByPoint(v(point))
        at = bounds.getCenter(new THREE.Vector3())
      }
      if (guide.kind === 'center' && (Math.abs(at.getComponent(guide.axis) - guide.coord) > EPS
        || Math.abs(center(ref).getComponent(guide.axis) - guide.coord) > EPS)) continue
      result.push(coordinateRelation(p, ref, guide.axis, guide.coord, guide.kind, at))
    }
    handled.add(guide.axis)
  }

  // Snapping deliberately omits a zero correction. Still show a true final alignment
  // when a grid step landed exactly on the plane before any snap had to engage.
  for (const axis of request.axes ?? [0, 2]) {
    if (handled.has(axis)) continue
    const candidates: EditAlignment[] = []
    for (const p of moving) for (const ref of references) {
      for (const side of [-1, 1] as const) for (const refSide of [-1, 1] as const) {
        const first = profileFaceForWorldAxis(p, axis, side, trims.get(p.id))
        const second = profileFaceForWorldAxis(ref, axis, refSide, trims.get(ref.id))
        if (!first || !second || !coplanar(first, second)) continue
        const kind = first.axis === 2 && second.axis === 2 ? 'end' : 'align'
        candidates.push(faceRelation(first, second, axis, kind))
      }
      const a = center(p), b = center(ref)
      if (Math.abs(a.getComponent(axis) - b.getComponent(axis)) < EPS) {
        candidates.push(coordinateRelation(p, ref, axis, a.getComponent(axis), 'center', a))
      }
    }
    const best = nearest(candidates)
    if (best) result.push(best)
  }
  return result
}
