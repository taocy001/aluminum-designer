import * as THREE from 'three'
import type { ProfileData, ConnectorData, PanelData, FittingData, EquipmentData } from '../store/useStore'
import { getProfileDir, crossExtentAlong } from './geometryCore'
import { toScreen, closestParamLineToRay, type ScreenSize } from './pickUtils'
import { panelCorners } from './panelOps'
import { fittingObb } from './fittingGeometry'
import { equipmentBody } from './equipmentGeometry'
import { cutAway } from './frontmost'
import { obbCorners } from './obb'
import { profileBodyEndpoints } from './profileFaces'
import { computeAllTrims, type ProfileTrims } from './jointUtils'
import { connectorMeshes } from './connectorGeometry'
import { connectorScale } from './connectorCatalog'

/** Extra pixels of slack around a member's rendered body, so thin beams stay easy to hit */
export const PICK_SLACK_PX = 7
const CONNECTOR_SLACK_PX = 20
/** Prefer connectors over member endpoints at comparable depth. */
const CONNECTOR_DEPTH_BIAS = 60
/** a board seen edge-on is a sliver: this much slack makes it as clickable as it is visible */
const PANEL_SLACK_PX = 4
/** how much being under the pointer beats being nearer the camera, for parts a few pixels across */
const CONNECTOR_AIM_WEIGHT = 40
/** Fittings remain available for cycling; direct mesh hits determine the visible target. */
const FITTING_DEPTH_PENALTY = 1e6
/** anything nearer than this to the camera plane cannot be projected meaningfully */
const NEAR_EPS = 1

/** Convex hull of projected solid vertices. */
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

interface SolidProjection {
  vertices: readonly THREE.Vector3[]
  triangles: Uint32Array
}
const connectorVertices = new WeakMap<THREE.BufferGeometry, SolidProjection>()
const connectorBounds = new Map<string, readonly THREE.Vector3[]>()

/** Shared geometry is immutable; weld its vertices once while preserving every triangle. */
function solidProjection(geometry: THREE.BufferGeometry): SolidProjection {
  let solid = connectorVertices.get(geometry)
  if (!solid) {
    const unique = new Map<string, number>(), vertices: THREE.Vector3[] = []
    const positions = geometry.getAttribute('position'), index = geometry.getIndex()
    const remap = new Uint32Array(positions.count)
    for (let i = 0; i < positions.count; i++) {
      const point = new THREE.Vector3().fromBufferAttribute(positions, i)
      const key = `${point.x},${point.y},${point.z}`
      let at = unique.get(key)
      if (at === undefined) { at = vertices.length; unique.set(key, at); vertices.push(point) }
      remap[i] = at
    }
    const triangles = new Uint32Array(index?.count ?? positions.count)
    for (let i = 0; i < triangles.length; i++) triangles[i] = remap[index ? index.getX(i) : i]
    solid = { vertices, triangles }
    connectorVertices.set(geometry, solid)
  }
  return solid
}

function connectorBoundCorners(type: string, series: ConnectorData['series'], profileSpec?: ConnectorData['profileSpec'], mountSeries?: ConnectorData['mountSeries'], panelMount?: ConnectorData['panelMount']): readonly THREE.Vector3[] {
  const key = `${type}:${series ?? 20}:${profileSpec ?? ''}:${mountSeries ?? ''}:${panelMount ? `${panelMount.mode}:${panelMount.spacer}:${panelMount.boardThickness}` : ''}`
  let corners = connectorBounds.get(key)
  if (!corners) {
    const box = new THREE.Box3().setFromPoints(connectorMeshes(type, series, profileSpec, mountSeries, panelMount).flatMap(({ geometry }) => [...solidProjection(geometry).vertices]))
    const points: THREE.Vector3[] = []
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      points.push(new THREE.Vector3(x, y, z))
    }
    corners = points
    connectorBounds.set(key, corners)
  }
  return corners
}

/** Squared screen distance to a triangle, including edge-on faces. */
function triangleDistanceSq(a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2, p: THREE.Vector2): number {
  const ab = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
  const bc = (c.x - b.x) * (p.y - b.y) - (c.y - b.y) * (p.x - b.x)
  const ca = (a.x - c.x) * (p.y - c.y) - (a.y - c.y) * (p.x - c.x)
  const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
  if (Math.abs(area) > 1e-9 && ((ab >= -1e-9 && bc >= -1e-9 && ca >= -1e-9)
    || (ab <= 1e-9 && bc <= 1e-9 && ca <= 1e-9))) return 0
  const segment = (u: THREE.Vector2, v: THREE.Vector2) => {
    const dx = v.x - u.x, dy = v.y - u.y, lengthSq = dx * dx + dy * dy
    const t = lengthSq < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p.x - u.x) * dx + (p.y - u.y) * dy) / lengthSq))
    const x = u.x + dx * t - p.x, y = u.y + dy * t - p.y
    return x * x + y * y
  }
  return Math.min(segment(a, b), segment(b, c), segment(c, a))
}

/** Distance to actual mesh faces, retaining concave outlines, bores and open cavities. */
function connectorDistancePx(
  connector: ConnectorData, cursor: THREE.Vector2, camera: THREE.Camera, size: ScreenSize,
  camPos: THREE.Vector3, fwd: THREE.Vector3,
): number {
  const position = new THREE.Vector3(...connector.position)
  const quaternion = new THREE.Quaternion(...connector.quaternion).normalize()
  const scale = connectorScale(connector.series ?? 20)
  const transform = (v: THREE.Vector3) => v.clone().multiplyScalar(scale).applyQuaternion(quaternion).add(position)
  // Reject distant parts before projecting every vertex of their plates and fasteners.
  const bounds = connectorBoundCorners(connector.type, connector.series, connector.profileSpec, connector.mountSeries, connector.panelMount).map(transform)
  if (bounds.every(v => v.clone().sub(camPos).dot(fwd) > NEAR_EPS)) {
    const rect = new THREE.Box2().setFromPoints(bounds.map(v => toScreen(v, camera, size))).expandByScalar(CONNECTOR_SLACK_PX)
    if (!rect.containsPoint(cursor)) return Infinity
  }
  let distance = Infinity
  for (const { geometry } of connectorMeshes(connector.type, connector.series, connector.profileSpec, connector.mountSeries, connector.panelMount)) {
    const solid = solidProjection(geometry)
    const points = solid.vertices.map((vertex) => {
      const world = transform(vertex)
      return world.clone().sub(camPos).dot(fwd) > NEAR_EPS ? toScreen(world, camera, size) : null
    })
    for (let i = 0; i < solid.triangles.length; i += 3) {
      const a = points[solid.triangles[i]], b = points[solid.triangles[i + 1]], c = points[solid.triangles[i + 2]]
      if (!a || !b || !c) continue
      const here = triangleDistanceSq(a, b, c, cursor)
      if (here === 0) return 0
      distance = Math.min(distance, here)
    }
  }
  return Math.sqrt(distance)
}

function segmentDistancePx(a: THREE.Vector2, b: THREE.Vector2, p: THREE.Vector2): { dist: number; t: number } {
  const ab = b.clone().sub(a)
  const lenSq = ab.lengthSq()
  if (lenSq < 1e-6) return { dist: p.distanceTo(a), t: 0 }
  const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / lenSq, 0, 1)
  return { dist: p.distanceTo(a.clone().addScaledVector(ab, t)), t }
}

export interface ScreenPick {
  kind: 'profile' | 'connector' | 'panel' | 'fitting' | 'equipment'
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
  trims?: ReadonlyMap<string, ProfileTrims>, equipment: EquipmentData[] = [],
): ScreenPick | null {
  return pickCandidatesAtScreen(cursor, ray, camera, size, profiles, connectors, panels, fittings, trims, equipment)[0] ?? null
}

/** Return pick candidates under the cursor in depth order for selection cycling. */
export function pickCandidatesAtScreen(
  cursor: THREE.Vector2, ray: THREE.Ray, camera: THREE.Camera, size: ScreenSize,
  profiles: ProfileData[], connectors: ConnectorData[] = [], panels: PanelData[] = [],
  fittings: FittingData[] = [],
  trims?: ReadonlyMap<string, ProfileTrims>, equipment: EquipmentData[] = [],
): ScreenPick[] {
  const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld)
  const fwd = camera.getWorldDirection(new THREE.Vector3())
  const found: Array<{ pick: ScreenPick; score: number }> = []
  const actualTrims = trims ?? computeAllTrims(profiles)

  for (const p of profiles) {
    const { start: s0, end: e0 } = profileBodyEndpoints(p, actualTrims.get(p.id))
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
    const origin = s0.clone()
    const tRay = closestParamLineToRay(origin, dir, ray)
    const grabT = tRay === null ? origin.distanceTo(world) : THREE.MathUtils.clamp(tRay, 0, s0.distanceTo(e0))
    const at = origin.clone().addScaledVector(dir, grabT)
    // a part the cut has taken away is not there to be clicked
    if (cutAway(at)) continue
    found.push({ score: depth, pick: { kind: 'profile', id: p.id, point: at, depth } })
  }

  // Pick boards using their projected solid outline and the screen-space tolerance.
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
    if (cutAway(centre)) continue
    found.push({ score: depth, pick: { kind: 'panel', id: b.id, point: centre, depth } })
  }

  // Door and drawer candidates use their current rendered bounds.
  for (const f of fittings) {
    const centre = new THREE.Vector3(...f.position)
    if (centre.clone().sub(camPos).dot(fwd) <= NEAR_EPS) continue
    const corners = obbCorners(fittingObb(f))
    if (corners.some((v) => v.clone().sub(camPos).dot(fwd) <= NEAR_EPS)) continue
    const outline = hull2d(corners.map((v) => toScreen(v, camera, size)))
    if (!insideQuad(outline, cursor) && distanceToOutline(outline, cursor) > PANEL_SLACK_PX) continue
    const here = corners.reduce((a, v) => a.add(v), new THREE.Vector3()).multiplyScalar(1 / corners.length)
    if (cutAway(here)) continue
    found.push({
      score: here.distanceTo(camPos) + FITTING_DEPTH_PENALTY,
      pick: { kind: 'fitting', id: f.id, point: here, depth: here.distanceTo(camPos) },
    })
  }

  // Reservations are not pickable; select the equipment's physical body.
  for (const e of equipment) {
    const body = equipmentBody(e), center = body.center
    if (cutAway(center)) continue
    const corners = obbCorners(body)
    if (corners.some((v) => v.clone().sub(camPos).dot(fwd) <= NEAR_EPS)) continue
    const outline = hull2d(corners.map((v) => toScreen(v, camera, size)))
    if (!insideQuad(outline, cursor) && distanceToOutline(outline, cursor) > PANEL_SLACK_PX) continue
    const depth = center.distanceTo(camPos)
    found.push({ score: depth, pick: { kind: 'equipment', id: e.id, point: center, depth } })
  }

  for (const c of connectors) {
    const world = new THREE.Vector3(...c.position)
    if (world.clone().sub(camPos).dot(fwd) <= NEAR_EPS) continue
    if (cutAway(world)) continue
    const dist = connectorDistancePx(c, cursor, camera, size, camPos, fwd)
    if (dist > CONNECTOR_SLACK_PX) continue
    const depth = world.distanceTo(camPos)
    // Screen distance separates nearby connectors within the same tolerance region.
    found.push({
      score: depth - CONNECTOR_DEPTH_BIAS + dist * CONNECTOR_AIM_WEIGHT,
      pick: { kind: 'connector', id: c.id, point: world, depth },
    })
  }

  return found.sort((a, b) => a.score - b.score).map((f) => f.pick)
}
