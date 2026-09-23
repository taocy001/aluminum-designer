import * as THREE from 'three'
import type { ProfileData, ConnectorData, PanelData, FittingData } from '../store/useStore'
import { getProfileEndpoints, getProfileDir, crossExtentAlong } from './geometryCore'
import { toScreen, closestParamLineToRay, type ScreenSize } from './pickUtils'
import { panelCorners } from './panelOps'
import { fittingObb } from './fittingGeometry'
import { obbCorners } from './obb'

/** Extra pixels of slack around a member's rendered body, so thin beams stay easy to hit */
export const PICK_SLACK_PX = 7
const CONNECTOR_RADIUS_PX = 20
/**
 * Connectors sit exactly on member endpoints, so they share the member's depth.
 * Bias them forward, otherwise the member always wins and they can never be picked.
 */
const CONNECTOR_DEPTH_BIAS = 60
/** a board seen edge-on is a sliver: this much slack makes it as clickable as it is visible */
const PANEL_SLACK_PX = 4
/** how much being under the pointer beats being nearer the camera, for parts a few pixels across */
const CONNECTOR_AIM_WEIGHT = 40
/**
 * A door is a square metre of board across the front of a cabinet, and everything behind it
 * was unselectable while it won on depth. It is also the easiest thing on the drawing to hit
 * somewhere else, so while building it is the last resort: if anything else is under the
 * pointer, that is what was meant. While looking, the caller asks for the nearest fitting and
 * this ordering does not apply.
 */
const FITTING_DEPTH_PENALTY = 1e6
/** anything nearer than this to the camera plane cannot be projected meaningfully */
const NEAR_EPS = 1

/** Winding test on the projected quad, which stays correct however the board is turned */
/**
 * The outline of a projected box, as seen.
 *
 * A drawer is a solid, so a press anywhere over it should find it — but a box seen in
 * perspective is a hexagon on screen, and testing one of its faces misses the middle of the
 * very part you are pointing at. The hull of all eight corners is what you can actually see.
 */
function hull2d(pts: THREE.Vector2[]): THREE.Vector2[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y)
  if (p.length < 3) return p
  const cross = (o: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const half = (src: THREE.Vector2[]) => {
    const out: THREE.Vector2[] = []
    for (const v of src) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], v) <= 0) out.pop()
      out.push(v)
    }
    out.pop()
    return out
  }
  return [...half(p), ...half([...p].reverse())]
}

/** How far outside an outline a point is, in pixels (0 when inside) */
function distanceToOutline(poly: THREE.Vector2[], p: THREE.Vector2): number {
  let best = Infinity
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    const ab = b.clone().sub(a)
    const len2 = ab.lengthSq()
    const t = len2 < 1e-9 ? 0 : Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / len2))
    best = Math.min(best, a.clone().addScaledVector(ab, t).distanceTo(p))
  }
  return best
}

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
  kind: 'profile' | 'connector' | 'panel' | 'fitting'
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
  fittings: FittingData[] = [],
): ScreenPick | null {
  return pickCandidatesAtScreen(cursor, ray, camera, size, profiles, connectors, panels, fittings)[0] ?? null
}

/**
 * Everything under the cursor, nearest first.
 *
 * In a dense frame several members cross the same few pixels and the nearest one is often
 * not the one that was meant. The caller can cycle through these instead of nudging the
 * camera until the right part happens to be in front.
 */
export function pickCandidatesAtScreen(
  cursor: THREE.Vector2, ray: THREE.Ray, camera: THREE.Camera, size: ScreenSize,
  profiles: ProfileData[], connectors: ConnectorData[] = [], panels: PanelData[] = [],
  fittings: FittingData[] = [],
): ScreenPick[] {
  const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld)
  const fwd = camera.getWorldDirection(new THREE.Vector3())
  const found: Array<{ pick: ScreenPick; score: number }> = []

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
    // point on the centerline nearest the sight line, for grabbing
    const origin = new THREE.Vector3(...p.position)
    const tRay = closestParamLineToRay(origin, dir, ray)
    const grabT = tRay === null ? origin.distanceTo(world) : THREE.MathUtils.clamp(tRay, 0, p.length)
    found.push({ score: depth, pick: { kind: 'profile', id: p.id, point: origin.clone().addScaledVector(dir, grabT), depth } })
  }

  // A board is picked by its face: the cursor has to be inside the projected rectangle.
  // Boards sit behind the members they are screwed to, so they never steal a member's press.
  // A board is a solid with a thickness, so it is picked by its whole outline. Testing one
  // face meant a shelf seen nearly edge-on projected to a sliver and could only be clicked
  // from directly in front of it — and a shelf is almost never looked at from in front.
  // The slack carries the rest: a sliver two pixels wide is still a shelf you can see.
  for (const b of panels) {
    const centre = new THREE.Vector3(...b.position)
    if (centre.clone().sub(camPos).dot(fwd) <= NEAR_EPS) continue
    const face = panelCorners(b)
    const normal = new THREE.Vector3(0, 0, b.thickness / 2).applyQuaternion(new THREE.Quaternion(...b.quaternion).normalize())
    const corners = [...face.map((v) => v.clone().add(normal)), ...face.map((v) => v.clone().sub(normal))]
    if (corners.some((v) => v.clone().sub(camPos).dot(fwd) <= NEAR_EPS)) continue
    const outline = hull2d(corners.map((v) => toScreen(v, camera, size)))
    if (!insideQuad(outline, cursor) && distanceToOutline(outline, cursor) > PANEL_SLACK_PX) continue
    const depth = centre.distanceTo(camPos)
    found.push({ score: depth, pick: { kind: 'panel', id: b.id, point: centre, depth } })
  }

  // A drawer or a door is picked by the box it fills. It sits proud of the frame, so it is
  // in front of the members around it — which is what makes it easy to press when looking.
  for (const f of fittings) {
    const centre = new THREE.Vector3(...f.position)
    if (centre.clone().sub(camPos).dot(fwd) <= NEAR_EPS) continue
    // where it is now, not where its opening is: an open door is out in the room
    const corners = obbCorners(fittingObb(f))
    if (corners.some((v) => v.clone().sub(camPos).dot(fwd) <= NEAR_EPS)) continue
    const outline = hull2d(corners.map((v) => toScreen(v, camera, size)))
    if (!insideQuad(outline, cursor) && distanceToOutline(outline, cursor) > PANEL_SLACK_PX) continue
    const here = corners.reduce((a, v) => a.add(v), new THREE.Vector3()).multiplyScalar(1 / corners.length)
    found.push({
      score: here.distanceTo(camPos) + FITTING_DEPTH_PENALTY,
      pick: { kind: 'fitting', id: f.id, point: here, depth: here.distanceTo(camPos) },
    })
  }

  for (const c of connectors) {
    const world = new THREE.Vector3(...c.position)
    if (world.clone().sub(camPos).dot(fwd) <= NEAR_EPS) continue
    const dist = toScreen(world, camera, size).distanceTo(cursor)
    if (dist > CONNECTOR_RADIUS_PX) continue
    const depth = world.distanceTo(camPos)
    // Among parts this small, several are inside the same grab radius at once, and the one
    // that was meant is the one nearest the pointer — not whichever happens to be a few
    // millimetres closer to the camera. Aiming at a part has to select that part.
    found.push({
      score: depth - CONNECTOR_DEPTH_BIAS + dist * CONNECTOR_AIM_WEIGHT,
      pick: { kind: 'connector', id: c.id, point: world, depth },
    })
  }

  return found.sort((a, b) => a.score - b.score).map((f) => f.pick)
}
