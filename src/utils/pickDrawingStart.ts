import * as THREE from 'three'
import type { ProfileData } from '../store/useStore'
import { getProfileDir } from './geometryCore'
import { createTrimResolver } from './jointUtils'
import { profileBodyEndpoints, profileFace, type ProfileFace, type ProfileFaceRef } from './profileFaces'
import { pickPoint, referenceFaceFromHit, toScreen, type MeshHit, type PickResult, type ScreenSize } from './pickUtils'

export interface DrawingStartPick extends PickResult {
  /** A second plane: an end cap or the supporting member's side at a real T joint. */
  alignmentFace?: ProfileFaceRef
}

const EDGE_PX = 12
const EDGE_MM = 20
const PLANE_TOL = 0.5
const FACE_EPS = 0.001

function distanceToEdge(cursor: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2): number {
  const edge = b.clone().sub(a)
  const t = edge.lengthSq() > 1e-9 ? THREE.MathUtils.clamp(cursor.clone().sub(a).dot(edge) / edge.lengthSq(), 0, 1) : 0
  return cursor.distanceTo(a.clone().addScaledVector(edge, t))
}

function interval(face: ProfileFace, axis: THREE.Vector3): [number, number] {
  const coordinates = face.corners.map((point) => new THREE.Vector3(...point).dot(axis))
  return [Math.min(...coordinates), Math.max(...coordinates)]
}

/**
 * First-click edge placement has two independent references: the horizontal surface
 * receiving the new end and the physical cap its outer side should align with. Keep
 * this separate from ordinary endpoint picking, which also serves connectors and
 * second-click corner joints and deliberately uses the construction centreline.
 */
export function pickDrawingStart(
  ray: THREE.Ray, cursor: THREE.Vector2, camera: THREE.Camera, size: ScreenSize, profiles: ProfileData[],
  meshHit?: MeshHit | null, planeY = 0, previousFace?: ProfileFaceRef | null,
): DrawingStartPick {
  const fallback = () => pickPoint(ray, cursor, camera, size, profiles, meshHit, planeY, previousFace)
  const target = meshHit && profiles.find((profile) => profile.id === meshHit.profileId)
  if (!target || !meshHit) return fallback()
  const dir = getProfileDir(target)
  if (Math.abs(dir.y) > 1e-6) return fallback()
  // Drawing remains world-axis constrained. A vertical member cannot put one of its
  // side faces flush against an oblique cap without changing its section rotation.
  if (Math.max(Math.abs(dir.x), Math.abs(dir.z)) < 1 - 1e-6) return fallback()

  // A groove wall can face sideways while belonging to the top. Classify its owning
  // outer face before checking its world normal, and retain the actual triangle normal.
  const face = referenceFaceFromHit(target, meshHit)
  if (face.axis === 2) return fallback()
  const resolveTrims = createTrimResolver(profiles)
  const trims = resolveTrims(target)
  const surface = profileFace(target, face, trims)
  if (Math.abs(surface.normal[1]) < 1 - 1e-6) return fallback()
  const ends = profileBodyEndpoints(target, trims)
  if (planeY !== 0 && Math.abs(ends.start.y - planeY) > PLANE_TOL) return fallback()

  type Candidate = { point: THREE.Vector3; alignmentFace: ProfileFaceRef; px: number; mm: number }
  let best: Candidate | null = null
  const consider = (candidate: Candidate) => {
    if (!best || candidate.px < best.px - 1e-6
      || (Math.abs(candidate.px - best.px) <= 1e-6 && candidate.mm < best.mm)) best = candidate
  }
  for (const [point, side] of [[ends.start, -1], [ends.end, 1]] as const) {
    const mm = Math.abs(meshHit.point.clone().sub(point).dot(dir))
    if (mm > EDGE_MM) continue
    const edge = surface.corners.map((corner) => new THREE.Vector3(...corner))
      .filter((corner) => Math.abs(corner.clone().sub(point).dot(dir)) < 0.001)
    if (edge.length !== 2) continue
    const px = distanceToEdge(cursor, toScreen(edge[0], camera, size), toScreen(edge[1], camera, size))
    if (px > EDGE_PX) continue
    consider({ point, alignmentFace: { profileId: target.id, axis: 2, side }, px, mm })
  }

  // At a T joint the visible top belongs to the through member, whose ends can be
  // far away. The approaching member's real cap identifies a local interface on one
  // of its sides. Use the supporting side's normal so the new foot stays above the
  // surface the user picked, rather than jumping across the seam onto the other rail.
  const up = new THREE.Vector3(0, 1, 0)
  const sideFaces = ([0, 1] as const).filter((axis) => axis !== face.axis)
    .flatMap((axis) => ([-1, 1] as const).map((side) => profileFace(target, { profileId: target.id, axis, side }, trims)))
  for (const other of profiles) {
    if (other.id === target.id) continue
    const otherDir = getProfileDir(other)
    if (Math.abs(otherDir.y) > 1e-6 || Math.abs(otherDir.dot(dir)) > 1e-6) continue
    for (const capSide of [-1, 1] as const) {
      const cap = profileFace(other, { profileId: other.id, axis: 2, side: capSide }, resolveTrims(other))
      const capNormal = new THREE.Vector3(...cap.normal)
      // Interval overlap is exact for these rectangular, axis-aligned sections.
      // Do not turn a rolled cap's bounding rectangle into a false contact edge.
      const capEdges = [1, 3].map((i) => new THREE.Vector3(...cap.corners[i]).sub(new THREE.Vector3(...cap.corners[0])).normalize())
      if (capEdges.some((edge) => Math.max(Math.abs(edge.dot(dir)), Math.abs(edge.y)) < 1 - 1e-6)) continue
      for (const sideFace of sideFaces) {
        const normal = new THREE.Vector3(...sideFace.normal)
        if (normal.dot(capNormal) > -1 + 1e-6) continue
        if (Math.abs(new THREE.Vector3(...cap.center).sub(new THREE.Vector3(...sideFace.center)).dot(normal)) > FACE_EPS) continue
        const [capLo, capHi] = interval(cap, dir), [sideLo, sideHi] = interval(sideFace, dir)
        const lo = Math.max(capLo, sideLo), hi = Math.min(capHi, sideHi)
        const [capBottom, capTop] = interval(cap, up), [sideBottom, sideTop] = interval(sideFace, up)
        // Both the side contact and its intersection with the selected top/bottom
        // must exist. A shorter neighbouring rail cannot invent an upper interface.
        if (hi - lo <= FACE_EPS || Math.min(capTop, sideTop) - Math.max(capBottom, sideBottom) <= FACE_EPS) continue
        if (surface.center[1] < capBottom - FACE_EPS || surface.center[1] > capTop + FACE_EPS) continue
        const a = new THREE.Vector3(...sideFace.center)
        a.addScaledVector(dir, lo - a.dot(dir)); a.y = surface.center[1]
        const b = a.clone().addScaledVector(dir, hi - lo)
        const center = (lo + hi) / 2
        const point = ends.start.clone().addScaledVector(dir, center - ends.start.dot(dir))
        const anchor = point.clone(); anchor.y = surface.center[1]
        // The joint center is also an intentional target, especially on wider rails.
        // A hit inside a top slot must not make its depth count as missing that surface.
        const onSurface = meshHit.point.clone(); onSurface.y = surface.center[1]
        const nearest = new THREE.Line3(a, b).closestPointToPoint(onSurface, true, new THREE.Vector3())
        const mm = Math.max(Math.min(onSurface.distanceTo(nearest), onSurface.distanceTo(anchor)),
          Math.abs(onSurface.dot(dir) - center))
        if (mm > EDGE_MM) continue
        const px = Math.min(distanceToEdge(cursor, toScreen(a, camera, size), toScreen(b, camera, size)),
          cursor.distanceTo(toScreen(anchor, camera, size)))
        if (px > EDGE_PX) continue
        consider({ point, alignmentFace: { profileId: target.id, axis: sideFace.axis, side: sideFace.side }, px, mm })
      }
    }
  }
  if (!best) return fallback()
  const chosen = best as Candidate
  return {
    point: chosen.point.clone(), kind: 'endpoint', profileId: target.id, normal: meshHit.normal.clone(), face,
    alignmentFace: chosen.alignmentFace,
  }
}
