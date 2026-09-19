import * as THREE from 'three'
import type { ProfileData } from '../store/useStore'
import { getProfileEndpoints } from './snapUtils'
import { GRID_STEP, roundToGrid } from './specUtils'
import type { Axis } from './jointUtils'

export interface ScreenSize { width: number; height: number }

const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
const AXES: Record<Axis, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
}

/** Pixel threshold for snapping */
export const SNAP_PX = 14

export function toScreen(v: THREE.Vector3, camera: THREE.Camera, size: ScreenSize): THREE.Vector2 {
  const p = v.clone().project(camera)
  return new THREE.Vector2((p.x + 1) / 2 * size.width, (1 - p.y) / 2 * size.height)
}

/** Closest point on the infinite line (origin, dir) to the ray. Returns param t along dir. */
export function closestParamLineToRay(origin: THREE.Vector3, dir: THREE.Vector3, ray: THREE.Ray): number | null {
  // Solve for closest points between two lines: P(t) = origin + dir*t, R(s) = ray.origin + ray.direction*s
  const w0 = origin.clone().sub(ray.origin)
  const a = dir.dot(dir)
  const b = dir.dot(ray.direction)
  const c = ray.direction.dot(ray.direction)
  const d = dir.dot(w0)
  const e = ray.direction.dot(w0)
  const denom = a * c - b * b
  if (Math.abs(denom) < 1e-9) return null // parallel
  return (b * e - c * d) / denom
}

/** Closest point on a finite segment [a,b] to the ray */
export function closestPointSegmentToRay(a: THREE.Vector3, b: THREE.Vector3, ray: THREE.Ray): THREE.Vector3 {
  const ab = b.clone().sub(a)
  const len = ab.length()
  if (len < 1e-6) return a.clone()
  const dir = ab.clone().divideScalar(len)
  const t = closestParamLineToRay(a, dir, ray)
  const clamped = THREE.MathUtils.clamp(t ?? 0, 0, len)
  return a.clone().addScaledVector(dir, clamped)
}

export type PickKind = 'endpoint' | 'segment' | 'ground' | 'none'
export interface PickResult { point: THREE.Vector3; kind: PickKind; profileId?: string }

/**
 * Pick a 3D start point under the cursor:
 *  1. an existing profile endpoint within SNAP_PX pixels,
 *  2. a point on an existing profile centerline within SNAP_PX pixels (snapped to the grid along it),
 *  3. the ground plane, snapped to the grid.
 */
export function pickPoint(
  ray: THREE.Ray,
  cursor: THREE.Vector2,
  camera: THREE.Camera,
  size: ScreenSize,
  profiles: ProfileData[],
): PickResult {
  let best: PickResult | null = null
  let bestPx = SNAP_PX

  for (const p of profiles) {
    const { start, end } = getProfileEndpoints(p)
    for (const ep of [start, end]) {
      const px = toScreen(ep, camera, size).distanceTo(cursor)
      if (px < bestPx) { bestPx = px; best = { point: ep.clone(), kind: 'endpoint', profileId: p.id } }
    }
  }
  if (best) return best

  bestPx = SNAP_PX
  for (const p of profiles) {
    const { start, end } = getProfileEndpoints(p)
    const cp = closestPointSegmentToRay(start, end, ray)
    const px = toScreen(cp, camera, size).distanceTo(cursor)
    if (px < bestPx) {
      // snap along the segment to the grid, measured from the profile start
      const dir = end.clone().sub(start).normalize()
      const t = roundToGrid(cp.clone().sub(start).dot(dir))
      const snapped = start.clone().addScaledVector(dir, THREE.MathUtils.clamp(t, 0, p.length))
      bestPx = px
      best = { point: snapped, kind: 'segment', profileId: p.id }
    }
  }
  if (best) return best

  const hit = new THREE.Vector3()
  if (ray.intersectPlane(GROUND, hit)) {
    hit.x = roundToGrid(hit.x); hit.z = roundToGrid(hit.z); hit.y = 0
    return { point: hit, kind: 'ground' }
  }
  return { point: new THREE.Vector3(), kind: 'none' }
}

export interface AxisEndResult {
  axis: Axis
  /** signed axis direction actually used (+/-) */
  dir: THREE.Vector3
  end: THREE.Vector3
  length: number
  /** hard snap to an existing endpoint on the axis line */
  snapPoint: THREE.Vector3 | null
  /** alignment guide: end aligned with a remote endpoint along the axis */
  guide: { from: THREE.Vector3; to: THREE.Vector3 } | null
}

/**
 * Choose the world axis whose on-screen direction best matches the cursor
 * movement from the start point, then compute the axis-constrained end point.
 */
export function resolveAxisEnd(
  start: THREE.Vector3,
  ray: THREE.Ray,
  cursor: THREE.Vector2,
  camera: THREE.Camera,
  size: ScreenSize,
  profiles: ProfileData[],
  lockedAxis: Axis | null,
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
      if (d.length() < 2) continue // axis is degenerate on screen (looking straight along it)
      const score = Math.abs(mn.dot(d.normalize()))
      if (score > bestScore) { bestScore = score; axis = a }
    }
  }

  const axisDir = AXES[axis]
  const tRaw = closestParamLineToRay(start, axisDir, ray)
  if (tRaw === null) return null

  let length = roundToGrid(tRaw)
  let snapPoint: THREE.Vector3 | null = null
  let guide: AxisEndResult['guide'] = null

  // Snap: prefer endpoints lying ON the axis line; otherwise align length with any endpoint's axis coordinate
  let bestOnLinePx = SNAP_PX
  let bestAlignPx = SNAP_PX
  let alignFrom: THREE.Vector3 | null = null
  let alignT = 0
  const cursorEnd = start.clone().addScaledVector(axisDir, tRaw)
  for (const p of profiles) {
    const { start: ps, end: pe } = getProfileEndpoints(p)
    for (const ep of [ps, pe]) {
      const t = Math.round(ep.clone().sub(start).dot(axisDir) * 1000) / 1000
      if (Math.abs(t) < 1) continue
      const onLine = start.clone().addScaledVector(axisDir, t)
      const lateral = onLine.distanceTo(ep)
      const px = toScreen(onLine, camera, size).distanceTo(toScreen(cursorEnd, camera, size))
      if (lateral < 1) {
        if (px < bestOnLinePx) { bestOnLinePx = px; snapPoint = ep.clone(); length = t }
      } else if (px < bestAlignPx) {
        bestAlignPx = px; alignFrom = ep.clone(); alignT = t
      }
    }
  }
  if (!snapPoint && alignFrom) {
    length = alignT
    guide = { from: alignFrom, to: start.clone().addScaledVector(axisDir, alignT) }
  }

  const sign = length >= 0 ? 1 : -1
  const dir = axisDir.clone().multiplyScalar(sign)
  const end = start.clone().addScaledVector(axisDir, length)
  return { axis, dir, end, length: Math.abs(length), snapPoint, guide }
}

export { GRID_STEP }
