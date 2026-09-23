import * as THREE from 'three'
import type { ProfileData } from '../store/useStore'
import { getProfileEndpoints, getProfileDir, closestOnSegment, type Axis } from './geometryCore'
import { GRID_STEP, roundToGrid } from './specUtils'

export interface ScreenSize { width: number; height: number }

const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
const AXES: Record<Axis, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
}

/** Pixel threshold for snapping */
export const SNAP_PX = 18
/** Clicking a member body this close (mm) to one of its ends snaps to that end */
const END_ZONE = 25
/** how far off a raised work plane a point may sit and still count as on it (mm) */
const PLANE_TOL = 0.5

export function toScreen(v: THREE.Vector3, camera: THREE.Camera, size: ScreenSize): THREE.Vector2 {
  const p = v.clone().project(camera)
  return new THREE.Vector2((p.x + 1) / 2 * size.width, (1 - p.y) / 2 * size.height)
}

/** Closest point on the infinite line (origin, dir) to the ray. Returns param t along dir. */
export function closestParamLineToRay(origin: THREE.Vector3, dir: THREE.Vector3, ray: THREE.Ray): number | null {
  const w0 = origin.clone().sub(ray.origin)
  const a = dir.dot(dir)
  const b = dir.dot(ray.direction)
  const c = ray.direction.dot(ray.direction)
  const d = dir.dot(w0)
  const e = ray.direction.dot(w0)
  const denom = a * c - b * b
  if (Math.abs(denom) < 1e-9) return null
  return (b * e - c * d) / denom
}

/** Closest points between the infinite line (o1,d1) and the segment [a,b]. Returns params (t1 along d1, t2∈[0,1]) and distance. */
function lineSegmentClosest(o1: THREE.Vector3, d1: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): { t1: number; point2: THREE.Vector3; dist: number } {
  const d2 = b.clone().sub(a)
  const len2 = d2.length()
  if (len2 < 1e-6) { const t1 = a.clone().sub(o1).dot(d1); return { t1, point2: a.clone(), dist: o1.clone().addScaledVector(d1, t1).distanceTo(a) } }
  const u = d2.clone().divideScalar(len2)
  const w0 = o1.clone().sub(a)
  const bb = d1.dot(u)
  const dd = d1.dot(w0)
  const ee = u.dot(w0)
  const denom = 1 - bb * bb
  let s: number, t: number
  if (Math.abs(denom) < 1e-9) { s = 0; t = ee } // parallel
  else { s = (bb * ee - dd) / denom; t = (ee - bb * dd) / denom }
  t = THREE.MathUtils.clamp(t, 0, len2)
  s = a.clone().addScaledVector(u, t).sub(o1).dot(d1)
  const p1 = o1.clone().addScaledVector(d1, s)
  const p2 = a.clone().addScaledVector(u, t)
  return { t1: s, point2: p2, dist: p1.distanceTo(p2) }
}

export function closestPointSegmentToRay(a: THREE.Vector3, b: THREE.Vector3, ray: THREE.Ray): THREE.Vector3 {
  const ab = b.clone().sub(a)
  const len = ab.length()
  if (len < 1e-6) return a.clone()
  const dir = ab.clone().divideScalar(len)
  const t = closestParamLineToRay(a, dir, ray)
  return a.clone().addScaledVector(dir, THREE.MathUtils.clamp(t ?? 0, 0, len))
}

export type PickKind = 'endpoint' | 'segment' | 'ground' | 'none'
export interface PickResult {
  point: THREE.Vector3
  kind: PickKind
  profileId?: string
  /** outward normal of the surface the pointer was over, when a body was hit */
  normal?: THREE.Vector3
  /** floor picks: guides to the endpoints whose X/Z the point was aligned with */
  guides?: { from: THREE.Vector3; to: THREE.Vector3 }[]
}
/** Pixel threshold for aligning a floor point with existing X/Z coordinates */
export const ALIGN_PX = 12

/** A ray hit on a member's rendered body, already classified by DrawingHandler */
export interface MeshHit { profileId: string; point: THREE.Vector3; normal: THREE.Vector3 }

/** Map a hit on a member body to its model point: end-cap → centerline end, side face → centerline point (grid, end zones snap to the ends) */
export function modelPointFromHit(hit: MeshHit, profiles: ProfileData[], ray?: THREE.Ray): PickResult | null {
  const p = profiles.find((q) => q.id === hit.profileId)
  if (!p) return null
  const { start, end } = getProfileEndpoints(p)
  const dir = getProfileDir(p)
  const nd = hit.normal.dot(dir)
  if (Math.abs(nd) > 0.9) return { point: (nd > 0 ? end : start).clone(), kind: 'endpoint', profileId: p.id, normal: hit.normal.clone() }
  // side face: measure along the centerline where the sight line passes it (avoids the surface-depth offset)
  const tRay = ray ? closestParamLineToRay(start, dir, ray) : null
  const t = tRay !== null && tRay !== undefined ? THREE.MathUtils.clamp(tRay, 0, p.length) : hit.point.clone().sub(start).dot(dir)
  if (t <= END_ZONE) return { point: start.clone(), kind: 'endpoint', profileId: p.id }
  if (t >= p.length - END_ZONE) return { point: end.clone(), kind: 'endpoint', profileId: p.id }
  return { point: start.clone().addScaledVector(dir, roundToGrid(t)), kind: 'segment', profileId: p.id, normal: hit.normal.clone() }
}

/**
 * Where a member's centreline crosses a horizontal plane, or null when it does not reach it.
 * A member lying in the plane crosses it everywhere, and answers with the point nearest the
 * sight line instead.
 */
function centrelineOnPlane(p: ProfileData, planeY: number, ray: THREE.Ray): THREE.Vector3 | null {
  const { start, end } = getProfileEndpoints(p)
  const dy = end.y - start.y
  if (Math.abs(dy) < 1e-6) {
    return Math.abs(start.y - planeY) <= PLANE_TOL ? closestPointSegmentToRay(start, end, ray) : null
  }
  const t = (planeY - start.y) / dy
  if (t < -1e-6 || t > 1 + 1e-6) return null
  return start.clone().lerp(end, THREE.MathUtils.clamp(t, 0, 1))
}

/**
 * Pick a 3D start point under the cursor:
 *  1. a member body under the cursor (end cap → its centerline end; side → centerline point),
 *  2. an existing endpoint within SNAP_PX pixels,
 *  3. a centerline within SNAP_PX pixels,
 *  4. the floor grid.
 */
export function pickPoint(
  ray: THREE.Ray, cursor: THREE.Vector2, camera: THREE.Camera, size: ScreenSize, profiles: ProfileData[],
  meshHit?: MeshHit | null, planeY = 0,
): PickResult {
  // A raised work plane is a statement of the height being worked at, so a snap must land on
  // it. Without that, a vertex two metres away that happens to fall under the cursor wins the
  // pixel test and the rail is drawn in the next cabinet — which is a surprise, not a snap.
  // At floor level there is no such statement, and everything is a candidate as before.
  const held = planeY !== 0
  const onPlane = (v: THREE.Vector3) => !held || Math.abs(v.y - planeY) <= PLANE_TOL

  // 1. a nearby endpoint on screen — but never one hidden behind the body under the cursor:
  //    it must belong to the hit member or be closer to the camera than the hit point
  const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld)
  const hitDepth = meshHit ? meshHit.point.distanceTo(camPos) : Infinity
  let best: PickResult | null = null
  let bestPx = SNAP_PX
  for (const p of profiles) {
    const { start, end } = getProfileEndpoints(p)
    for (const ep of [start, end]) {
      if (!onPlane(ep)) continue
      const px = toScreen(ep, camera, size).distanceTo(cursor)
      if (px >= bestPx) continue
      if (meshHit && meshHit.profileId !== p.id && ep.distanceTo(camPos) > hitDepth + 1) continue
      bestPx = px; best = { point: ep.clone(), kind: 'endpoint', profileId: p.id }
    }
  }
  if (best) return best
  if (meshHit) {
    const m = modelPointFromHit(meshHit, profiles, ray)
    // Clicking a post while working at a height means that post, at that height — so the body
    // hit is carried onto the plane rather than thrown away.
    if (m && onPlane(m.point)) return m
    if (m && held) {
      const p = profiles.find((q) => q.id === meshHit.profileId)
      const at = p ? centrelineOnPlane(p, planeY, ray) : null
      if (at) return { point: at, kind: 'segment', profileId: meshHit.profileId, normal: meshHit.normal.clone() }
    }
  }

  bestPx = SNAP_PX
  for (const p of profiles) {
    const { start, end } = getProfileEndpoints(p)
    const cp = held ? centrelineOnPlane(p, planeY, ray) : closestPointSegmentToRay(start, end, ray)
    if (!cp) continue
    const px = toScreen(cp, camera, size).distanceTo(cursor)
    if (px < bestPx) {
      const dir = end.clone().sub(start).normalize()
      const t = THREE.MathUtils.clamp(roundToGrid(cp.clone().sub(start).dot(dir)), 0, p.length)
      const on = start.clone().addScaledVector(dir, t)
      bestPx = px
      // rounding along the member must not lift the point off the plane it was found on
      best = { point: held ? cp.clone() : on, kind: 'segment', profileId: p.id }
    }
  }
  if (best) return best

  // Nothing to attach to: the point lands on the work plane, which is the floor by default
  // but can be raised so a rail can be started in mid-air at a known height.
  const plane = planeY === 0 ? GROUND : new THREE.Plane(new THREE.Vector3(0, 1, 0), -planeY)
  const hit = new THREE.Vector3()
  if (ray.intersectPlane(plane, hit)) {
    hit.y = planeY
    // Align the floor point with existing endpoint X / Z coordinates (independently), like CAD alignment snaps
    const guides: { from: THREE.Vector3; to: THREE.Vector3 }[] = []
    let bestX: { v: number; from: THREE.Vector3 } | null = null, bestXPx = ALIGN_PX
    let bestZ: { v: number; from: THREE.Vector3 } | null = null, bestZPx = ALIGN_PX
    for (const p of profiles) {
      const { start, end } = getProfileEndpoints(p)
      for (const ep of [start, end]) {
        const ax = new THREE.Vector3(ep.x, planeY, hit.z)
        const pxX = toScreen(ax, camera, size).distanceTo(cursor)
        if (pxX < bestXPx) { bestXPx = pxX; bestX = { v: ep.x, from: ep.clone() } }
        const az = new THREE.Vector3(hit.x, planeY, ep.z)
        const pxZ = toScreen(az, camera, size).distanceTo(cursor)
        if (pxZ < bestZPx) { bestZPx = pxZ; bestZ = { v: ep.z, from: ep.clone() } }
      }
    }
    hit.x = bestX ? bestX.v : roundToGrid(hit.x)
    hit.z = bestZ ? bestZ.v : roundToGrid(hit.z)
    if (bestX) guides.push({ from: bestX.from, to: hit.clone() })
    if (bestZ) guides.push({ from: bestZ.from, to: hit.clone() })
    return { point: hit, kind: 'ground', guides }
  }
  return { point: new THREE.Vector3(), kind: 'none' }
}

export type EndSnapKind = 'endpoint' | 'joint' | 'align' | 'grid'
export interface AxisEndResult {
  axis: Axis
  dir: THREE.Vector3
  end: THREE.Vector3
  length: number
  snapKind: EndSnapKind
  /** the point that attracted the end (endpoint / centerline crossing) */
  snapPoint: THREE.Vector3 | null
  /** member the end attaches to (T-joint / endpoint) */
  targetId: string | null
  /** alignment guide: end aligned with a remote endpoint along the axis */
  guide: { from: THREE.Vector3; to: THREE.Vector3 } | null
}

/**
 * Choose the world axis whose on-screen direction best matches the cursor
 * movement from the start point, then compute the axis-constrained end point.
 * Snap priority: endpoint on the axis line → crossing centerline (T-joint) →
 * body under the cursor → alignment with a remote endpoint → 5 mm grid.
 */
export function resolveAxisEnd(
  start: THREE.Vector3, ray: THREE.Ray, cursor: THREE.Vector2, camera: THREE.Camera, size: ScreenSize,
  profiles: ProfileData[], lockedAxis: Axis | null, meshHit?: MeshHit | null,
): AxisEndResult | null {
  const s0 = toScreen(start, camera, size)
  const m = cursor.clone().sub(s0)
  if (m.length() < 3 && !lockedAxis) return null

  let axis: Axis = lockedAxis ?? 'x'
  if (!lockedAxis) {
    let bestScore = -1
    const mn = m.clone().normalize()
    for (const a of ['x', 'y', 'z'] as Axis[]) {
      const s1 = toScreen(start.clone().addScaledVector(AXES[a], 100), camera, size)
      const d = s1.sub(s0)
      if (d.length() < 2) continue
      const score = Math.abs(mn.dot(d.normalize()))
      if (score > bestScore) { bestScore = score; axis = a }
    }
  }

  const axisDir = AXES[axis]
  const tRaw = closestParamLineToRay(start, axisDir, ray)
  if (tRaw === null) return null
  const cursorEnd = start.clone().addScaledVector(axisDir, tRaw)
  const cursorEndPx = toScreen(cursorEnd, camera, size)
  const pxOf = (t: number) => toScreen(start.clone().addScaledVector(axisDir, t), camera, size).distanceTo(cursorEndPx)

  let length = roundToGrid(tRaw)
  let snapKind: EndSnapKind = 'grid'
  let snapPoint: THREE.Vector3 | null = null
  let targetId: string | null = null
  let guide: AxisEndResult['guide'] = null

  // 1. endpoints lying on the axis line
  let bestPx = SNAP_PX
  for (const p of profiles) {
    const { start: ps, end: pe } = getProfileEndpoints(p)
    for (const ep of [ps, pe]) {
      const t = Math.round(ep.clone().sub(start).dot(axisDir) * 1000) / 1000
      if (Math.abs(t) < 1) continue
      const lateral = start.clone().addScaledVector(axisDir, t).distanceTo(ep)
      if (lateral >= 1) continue
      const px = pxOf(t)
      if (px < bestPx) { bestPx = px; length = t; snapKind = 'endpoint'; snapPoint = ep.clone(); targetId = p.id }
    }
  }

  // 2. crossing centerlines (T-joint): axis line passes through another member's centerline
  if (snapKind === 'grid') {
    bestPx = SNAP_PX
    for (const p of profiles) {
      const { start: ps, end: pe } = getProfileEndpoints(p)
      const r = lineSegmentClosest(start, axisDir, ps, pe)
      if (r.dist >= 1 || Math.abs(r.t1) < 1) continue
      const px = pxOf(r.t1)
      if (px < bestPx) { bestPx = px; length = Math.round(r.t1 * 1000) / 1000; snapKind = 'joint'; snapPoint = r.point2.clone(); targetId = p.id }
    }
  }

  // 3. body under the cursor: project its centerline point onto the axis
  if (snapKind === 'grid' && meshHit) {
    const mp = modelPointFromHit(meshHit, profiles, ray)
    if (mp && mp.profileId) {
      const t = Math.round(mp.point.clone().sub(start).dot(axisDir) * 1000) / 1000
      if (Math.abs(t) >= 1) {
        const onAxis = start.clone().addScaledVector(axisDir, t)
        length = t
        snapKind = onAxis.distanceTo(mp.point) < 1 ? (mp.kind === 'endpoint' ? 'endpoint' : 'joint') : 'align'
        snapPoint = mp.point.clone(); targetId = mp.profileId
        if (snapKind === 'align') guide = { from: mp.point.clone(), to: onAxis }
      }
    }
  }

  // 4. align the length with any endpoint's axis coordinate
  if (snapKind === 'grid') {
    bestPx = SNAP_PX
    for (const p of profiles) {
      const { start: ps, end: pe } = getProfileEndpoints(p)
      for (const ep of [ps, pe]) {
        const t = Math.round(ep.clone().sub(start).dot(axisDir) * 1000) / 1000
        if (Math.abs(t) < 1) continue
        const px = pxOf(t)
        if (px < bestPx) { bestPx = px; length = t; snapKind = 'align'; guide = { from: ep.clone(), to: start.clone().addScaledVector(axisDir, t) }; targetId = p.id }
      }
    }
  }

  const sign = length >= 0 ? 1 : -1
  const dir = axisDir.clone().multiplyScalar(sign)
  const end = start.clone().addScaledVector(axisDir, length)
  return { axis, dir, end, length: Math.abs(length), snapKind, snapPoint, targetId, guide }
}

export { GRID_STEP, closestOnSegment }
