import * as THREE from 'three'
import type { ProfileData } from '../store/useStore'
import { getProfileDir } from './geometryCore'
import { computeTrims } from './jointUtils'
import { profileBodyEndpoints, profileFace, type ProfileFaceRef } from './profileFaces'
import { pickPoint, referenceFaceFromHit, toScreen, type MeshHit, type PickResult, type ScreenSize } from './pickUtils'

export interface DrawingStartPick extends PickResult {
  /** A second plane: the new member's outer side should be flush with this end cap. */
  alignmentFace?: ProfileFaceRef
}

const EDGE_PX = 12
const EDGE_MM = 20
const PLANE_TOL = 0.5

function distanceToEdge(cursor: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2): number {
  const edge = b.clone().sub(a)
  const t = edge.lengthSq() > 1e-9 ? THREE.MathUtils.clamp(cursor.clone().sub(a).dot(edge) / edge.lengthSq(), 0, 1) : 0
  return cursor.distanceTo(a.clone().addScaledVector(edge, t))
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
  const trims = computeTrims(target, profiles)
  const surface = profileFace(target, face, trims)
  if (Math.abs(surface.normal[1]) < 1 - 1e-6) return fallback()
  const ends = profileBodyEndpoints(target, trims)
  if (planeY !== 0 && Math.abs(ends.start.y - planeY) > PLANE_TOL) return fallback()

  let best: { point: THREE.Vector3; side: -1 | 1; px: number; mm: number } | null = null
  for (const [point, side] of [[ends.start, -1], [ends.end, 1]] as const) {
    const mm = Math.abs(meshHit.point.clone().sub(point).dot(dir))
    if (mm > EDGE_MM) continue
    const edge = surface.corners.map((corner) => new THREE.Vector3(...corner))
      .filter((corner) => Math.abs(corner.clone().sub(point).dot(dir)) < 0.001)
    if (edge.length !== 2) continue
    const px = distanceToEdge(cursor, toScreen(edge[0], camera, size), toScreen(edge[1], camera, size))
    if (px > EDGE_PX) continue
    if (!best || px < best.px - 1e-6 || (Math.abs(px - best.px) <= 1e-6 && mm < best.mm)) best = { point, side, px, mm }
  }
  if (!best) return fallback()
  return {
    point: best.point.clone(), kind: 'endpoint', profileId: target.id, normal: meshHit.normal.clone(), face,
    alignmentFace: { profileId: target.id, axis: 2, side: best.side },
  }
}
