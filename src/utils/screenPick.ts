import * as THREE from 'three'
import type { ProfileData, ConnectorData, PanelData } from '../store/useStore'
import { getProfileEndpoints, getProfileDir, crossExtentAlong } from './geometryCore'
import { toScreen, closestParamLineToRay, type ScreenSize } from './pickUtils'
import { panelCorners } from './panelOps'

/** Extra pixels of slack around a member's rendered body, so thin beams stay easy to hit */
export const PICK_SLACK_PX = 7
const CONNECTOR_RADIUS_PX = 14
/**
 * Connectors sit exactly on member endpoints, so they share the member's depth.
 * Bias them forward, otherwise the member always wins and they can never be picked.
 */
const CONNECTOR_DEPTH_BIAS = 60
/** anything nearer than this to the camera plane cannot be projected meaningfully */
const NEAR_EPS = 1

/** Winding test on the projected quad, which stays correct however the board is turned */
function insideQuad(q: THREE.Vector2[], p: THREE.Vector2): boolean {
  let sign = 0
  for (let i = 0; i < q.length; i++) {
    const a = q[i], b = q[(i + 1) % q.length]
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
    if (Math.abs(cross) < 1e-9) continue
    const s = cross > 0 ? 1 : -1
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return sign !== 0
}

function segmentDistancePx(a: THREE.Vector2, b: THREE.Vector2, p: THREE.Vector2): { dist: number; t: number } {
  const ab = b.clone().sub(a)
  const lenSq = ab.lengthSq()
  if (lenSq < 1e-6) return { dist: p.distanceTo(a), t: 0 }
  const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / lenSq, 0, 1)
  return { dist: p.distanceTo(a.clone().addScaledVector(ab, t)), t }
}

export interface ScreenPick {
  kind: 'profile' | 'connector' | 'panel'
  id: string
  /** point on the member centerline nearest the sight line (profiles only) */
  point: THREE.Vector3
  /** distance from the camera, used to prefer the member in front */
  depth: number
}

/**
 * Clip a segment to the part in front of the camera. `project()` mirrors points that sit
 * behind the lens, which would otherwise put a member's screen line somewhere it is not.
 */
function clipToFront(a: THREE.Vector3, b: THREE.Vector3, camPos: THREE.Vector3, fwd: THREE.Vector3): { a: THREE.Vector3; b: THREE.Vector3 } | null {
  const da = a.clone().sub(camPos).dot(fwd)
  const db = b.clone().sub(camPos).dot(fwd)
  if (da <= NEAR_EPS && db <= NEAR_EPS) return null
  if (da > NEAR_EPS && db > NEAR_EPS) return { a, b }
  const t = (NEAR_EPS - da) / (db - da)
  const cut = a.clone().lerp(b, t)
  return da > NEAR_EPS ? { a, b: cut } : { a: cut, b }
}

/**
 * Pick the member under the cursor using screen-space distance to its centerline plus
 * its on-screen half-thickness. A 20 mm beam seen from far away is only a few pixels
 * wide, so an exact mesh raycast misses it and hits whatever stands behind it.
 * Candidates within tolerance are resolved front-to-back.
 */
export function pickAtScreen(
  cursor: THREE.Vector2, ray: THREE.Ray, camera: THREE.Camera, size: ScreenSize,
  profiles: ProfileData[], connectors: ConnectorData[] = [], panels: PanelData[] = [],
): ScreenPick | null {
  const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld)
  const fwd = camera.getWorldDirection(new THREE.Vector3())
  let best: ScreenPick | null = null
  let bestScore = Infinity

  for (const p of profiles) {
    const { start: s0, end: e0 } = getProfileEndpoints(p)
    const visible = clipToFront(s0, e0, camPos, fwd)
    if (!visible) continue
    const { a: start, b: end } = visible
    const a = toScreen(start, camera, size)
    const b = toScreen(end, camera, size)
    const { dist, t } = segmentDistancePx(a, b, cursor)
    const world = start.clone().lerp(end, t)
    // on-screen half thickness: project a point offset perpendicular to the member by its half section
    const dir = getProfileDir(p)
    const perp = new THREE.Vector3().crossVectors(dir, fwd)
    if (perp.lengthSq() < 1e-6) perp.set(0, 1, 0)
    perp.normalize()
    const halfPx = toScreen(world.clone().addScaledVector(perp, crossExtentAlong(p, perp)), camera, size).distanceTo(toScreen(world, camera, size))
    if (dist > halfPx + PICK_SLACK_PX) continue
    const depth = world.distanceTo(camPos)
    if (depth < bestScore) {
      // point on the centerline nearest the sight line, for grabbing
      const origin = new THREE.Vector3(...p.position)
      const tRay = closestParamLineToRay(origin, dir, ray)
      const grabT = tRay === null ? origin.distanceTo(world) : THREE.MathUtils.clamp(tRay, 0, p.length)
      bestScore = depth
      best = { kind: 'profile', id: p.id, point: origin.clone().addScaledVector(dir, grabT), depth }
    }
  }

  // A board is picked by its face: the cursor has to be inside the projected rectangle.
  // Boards sit behind the members they are screwed to, so they never steal a member's press.
  for (const b of panels) {
    const centre = new THREE.Vector3(...b.position)
    if (centre.clone().sub(camPos).dot(fwd) <= NEAR_EPS) continue
    const corners = panelCorners(b)
    if (corners.some((v) => v.clone().sub(camPos).dot(fwd) <= NEAR_EPS)) continue
    const pts = corners.map((v) => toScreen(v, camera, size))
    if (!insideQuad(pts, cursor)) continue
    const depth = centre.distanceTo(camPos)
    if (depth < bestScore) {
      bestScore = depth
      best = { kind: 'panel', id: b.id, point: centre, depth }
    }
  }

  for (const c of connectors) {
    const world = new THREE.Vector3(...c.position)
    if (world.clone().sub(camPos).dot(fwd) <= NEAR_EPS) continue
    const dist = toScreen(world, camera, size).distanceTo(cursor)
    if (dist > CONNECTOR_RADIUS_PX) continue
    const depth = world.distanceTo(camPos)
    if (depth - CONNECTOR_DEPTH_BIAS < bestScore) {
      bestScore = depth - CONNECTOR_DEPTH_BIAS
      best = { kind: 'connector', id: c.id, point: world, depth }
    }
  }

  return best
}
