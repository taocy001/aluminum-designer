import * as THREE from 'three'
import type { ConnectorData, EquipmentData, FittingData, PanelData, ProfileData } from '../store/useStore'
import { connectorExtent, connectorScale } from './connectorCatalog'
import { computeAllTrims, computeTrims, getThroughRule, type ProfileTrims } from './jointUtils'
import { getProfileDir } from './geometryCore'
import { specDims } from './specUtils'
import { makeOBB, obbPenetration, obbCorners, type OBB } from './obb'
import { findSpecMismatches, type SpecMismatch } from './specCompat'
import { fittingObb, fittingSolids } from './fittingGeometry'
import { findEquipmentConflicts, type EquipmentConflict } from './equipmentChecks'
import { connectorHitsBody, connectorsCollide } from './connectorCollision'
import { auditBrackets } from './bracketSeat'

/** members closer than this are considered touching, not interfering (mm) */
const TOUCH_TOL = 1
/**
 * A connector is meant to be in contact with the metal — that is what bolting is — so the
 * line between "lying on it" and "sunk into it" sits further out than it does for two
 * members, which have no business touching at all.
 */
const CONNECTOR_TOUCH_TOL = 3
/** Tolerance for contact between profiles and boards or fittings. */
const BOARD_TOUCH_TOL = 3

export interface Conflict {
  a: string
  b: string
  depth: number
  /** world-space box around the overlapping region, for highlighting */
  region: THREE.Box3
}

export interface FrameAnalysis {
  trims: Map<string, ProfileTrims>
  conflicts: Conflict[]
  conflictIds: Set<string>
  equipmentConflicts: EquipmentConflict[]
  equipmentConflictIds: Set<string>
  /** joints whose two profiles cannot be bolted together as drawn */
  mismatches: SpecMismatch[]
  mismatchIds: Set<string>
}

/** As-built oriented box of a member (after joint trimming) */
export function trimmedOBB(p: ProfileData, t: ProfileTrims): OBB {
  const quat = new THREE.Quaternion(...p.quaternion).normalize()
  const dir = getProfileDir(p)
  const start = new THREE.Vector3(...p.position).addScaledVector(dir, t.start.trim)
  const center = start.clone().addScaledVector(dir, t.cutLength / 2)
  const { hw, hh } = specDims(p.spec)
  return makeOBB(center, new THREE.Vector3(hw, hh, t.cutLength / 2), quat)
}

function regionOf(a: OBB, b: OBB): THREE.Box3 {
  // approximate the overlap with the intersection of the two world boxes
  const boxA = new THREE.Box3().setFromPoints(obbCorners(a))
  const boxB = new THREE.Box3().setFromPoints(obbCorners(b))
  const region = boxA.clone().intersect(boxB)
  return region.isEmpty() ? boxA.clone().union(boxB) : region
}

/** Detect profile interference using trimmed oriented bounding boxes; edits remain permitted. */
/** The room a board takes up */
export function panelOBB(b: PanelData): OBB {
  return makeOBB(
    new THREE.Vector3(...b.position),
    new THREE.Vector3(b.width / 2, b.height / 2, b.thickness / 2),
    new THREE.Quaternion(...b.quaternion).normalize(),
  )
}

/** The room a connector takes up, where it is */
export function connectorOBB(c: ConnectorData): OBB {
  const quat = new THREE.Quaternion(...c.quaternion).normalize()
  const scale = connectorScale(c.series ?? 20)
  const { centre, half } = connectorExtent(c.type)
  const offset = new THREE.Vector3(...centre).multiplyScalar(scale).applyQuaternion(quat)
  return makeOBB(
    new THREE.Vector3(...c.position).add(offset),
    new THREE.Vector3(...half).multiplyScalar(scale),
    quat,
  )
}

export function findConflicts(
  profiles: ProfileData[], trims: Map<string, ProfileTrims>, connectors: ConnectorData[] = [],
  panels: PanelData[] = [], fittings: FittingData[] = [],
  affectedIds?: ReadonlySet<string>,
): Conflict[] {
  /** `fit` is the index into `fittings` of the drawer or door a board belongs to */
  const boxes: Array<{ id: string; obb: OBB; fit?: number }> = profiles.map((p) => ({ id: p.id, obb: trimmedOBB(p, trims.get(p.id)!) }))
  // Include connector, board and fitting boxes with contact tolerances.
  const members = boxes.length
  for (const c of connectors) boxes.push({ id: c.id, obb: connectorOBB(c) })
  const parts = boxes.length
  for (const b of panels) boxes.push({ id: b.id, obb: panelOBB(b) })
  // A drawer or a door is judged by its boards — the box, the front, the leaf — where they
  // are at its current opening, not by the block round its opening. See `fittingSolids`.
  fittings.forEach((f, k) => { for (const obb of fittingSolids(f)) boxes.push({ id: f.id, obb, fit: k }) })

  // Use sweep-and-prune along X to select candidate pairs, preserving pair order.
  const spans = boxes.map((b, i) => {
    let r = 0
    for (let k = 0; k < 3; k++) r += Math.abs(b.obb.axes[k].x) * b.obb.half.getComponent(k)
    let ry = 0, rz = 0
    for (let k = 0; k < 3; k++) {
      ry += Math.abs(b.obb.axes[k].y) * b.obb.half.getComponent(k)
      rz += Math.abs(b.obb.axes[k].z) * b.obb.half.getComponent(k)
    }
    const c = b.obb.center
    return { i, x0: c.x - r - 2, x1: c.x + r + 2, y0: c.y - ry - 2, y1: c.y + ry + 2, z0: c.z - rz - 2, z1: c.z + rz + 2 }
  }).sort((a, b) => a.x0 - b.x0)
  const pairs: Array<[number, number]> = []
  for (let a = 0; a < spans.length; a++) {
    const A = spans[a]
    for (let b = a + 1; b < spans.length && spans[b].x0 <= A.x1; b++) {
      const B = spans[b]
      if (affectedIds && !affectedIds.has(boxes[A.i].id) && !affectedIds.has(boxes[B.i].id)) continue
      if (B.y0 > A.y1 || A.y0 > B.y1 || B.z0 > A.z1 || A.z0 > B.z1) continue
      pairs.push(A.i < B.i ? [A.i, B.i] : [B.i, A.i])
    }
  }
  pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1])

  // A drawer behind a door is opened by opening the door first. Pulled out while the door
  // is shut it would of course meet the door, and saying so paints a wardrobe's inside
  // drawers red for being inside a wardrobe. A door swinging into its neighbour is still
  // reported: the neighbour is beside it, not in front of it.
  const behindShutDoor = (i: number, j: number): boolean => {
    const fi = boxes[i].fit, fj = boxes[j].fit
    if (fi === undefined || fj === undefined) return false
    const a = fittings[fi], b = fittings[fj]
    const [moving, door] = (a.open ?? 0) > 0 && b.kind === 'door' && !(b.open ?? 0) ? [a, b]
      : (b.open ?? 0) > 0 && a.kind === 'door' && !(a.open ?? 0) ? [b, a] : [null, null]
    if (!moving || !door) return false
    const shut = fittingObb({ ...moving, open: 0 })
    const leaf = fittingObb(door)
    const d = shut.center.clone().sub(leaf.center)
    // behind the leaf, and within its outline
    return d.dot(leaf.axes[2]) < 0
      && Math.abs(d.dot(leaf.axes[0])) <= leaf.half.x && Math.abs(d.dot(leaf.axes[1])) <= leaf.half.y
  }

  // a fitting is several boxes, so one pair of parts can meet more than once: the deepest
  // meeting is the one reported, in the place the pair first came up
  const out: Conflict[] = []
  const seen = new Map<string, number>()
  for (const [i, j] of pairs) {
    if (boxes[i].id === boxes[j].id) continue           // a drawer's own boards meet each other
    if (behindShutDoor(i, j)) continue
    const connectorA = i >= members && i < parts ? connectors[i - members] : undefined
    const connectorB = j >= members && j < parts ? connectors[j - members] : undefined
    if (connectorA && connectorB && !connectorsCollide(connectorA, connectorB)) continue
    if (connectorA && !connectorB && !connectorHitsBody(connectorA, boxes[j].obb, j < members ? 3 : 1, j < members)) continue
    if (connectorB && !connectorA && !connectorHitsBody(connectorB, boxes[i].obb, i < members ? 3 : 1, i < members)) continue
    const tol = connectorA || connectorB ? (i < members || j < members ? CONNECTOR_TOUCH_TOL : TOUCH_TOL)
      : i >= parts || j >= parts ? BOARD_TOUCH_TOL
      : i >= members || j >= members ? CONNECTOR_TOUCH_TOL : TOUCH_TOL
    const depth = obbPenetration(boxes[i].obb, boxes[j].obb, tol)
    if (depth <= 0) continue
    const c: Conflict = {
      a: boxes[i].id, b: boxes[j].id,
      depth: Math.round(depth * 100) / 100,
      region: regionOf(boxes[i].obb, boxes[j].obb),
    }
    const key = `${c.a}|${c.b}`
    const k = seen.get(key)
    if (k === undefined) { seen.set(key, out.length); out.push(c) }
    else if (c.depth > out[k].depth) out[k] = c
  }
  return out
}

let cacheKey: ProfileData[] | null = null
let cacheParts: ConnectorData[] | null = null
let cacheBoards: PanelData[] | null = null
let cacheFittings: FittingData[] | null = null
let cacheEquipment: EquipmentData[] | null = null
const EMPTY_EQUIPMENT: EquipmentData[] = []
let cacheRule: string | null = null
let cacheValue: FrameAnalysis | null = null

/**
 * Do the moving members interfere with anything? Used while dragging, where re-running the
 * whole O(n²) analysis every frame would stall a large frame: only the moved parts are tested,
 * and their trims are computed against the current document.
 */
export function movingPartsConflict(all: ProfileData[], movingIds: Set<string>): boolean {
  if (movingIds.size === 0) return false
  const trims = new Map<string, ProfileTrims>()
  const need = all.filter((p) => movingIds.has(p.id))
  for (const p of need) trims.set(p.id, computeTrims(p, all))
  const others = all.filter((p) => !movingIds.has(p.id))
  for (const p of need) {
    const a = trimmedOBB(p, trims.get(p.id)!)
    for (const q of others) {
      const qt = trims.get(q.id) ?? computeTrims(q, all)
      trims.set(q.id, qt)
      if (obbPenetration(a, trimmedOBB(q, qt), TOUCH_TOL) > 0) return true
    }
  }
  return false
}

/** Trims + interference for the current document, memoised on the arrays' identity */
export function analyzeFrame(
  profiles: ProfileData[], connectors: ConnectorData[] = [],
  panels: PanelData[] = [], fittings: FittingData[] = [], equipment: EquipmentData[] = EMPTY_EQUIPMENT,
): FrameAnalysis {
  // the through rule changes every trim in the document, so it belongs in the cache key
  const rule = getThroughRule()
  if (cacheKey === profiles && cacheParts === connectors && cacheBoards === panels
    && cacheFittings === fittings && cacheEquipment === equipment && cacheRule === rule && cacheValue) return cacheValue
  const trims = computeAllTrims(profiles)
  const conflicts = findConflicts(profiles, trims, connectors, panels, fittings)
  const conflictIds = new Set<string>()
  for (const c of conflicts) { conflictIds.add(c.a); conflictIds.add(c.b) }
  const equipmentConflicts = equipment.length ? findEquipmentConflicts(equipment, [
    ...profiles.map((p) => ({ id: p.id, obb: trimmedOBB(p, trims.get(p.id)!) })),
    ...connectors.map((c) => ({ id: c.id, obb: connectorOBB(c), connector: c })),
    ...panels.map((b) => ({ id: b.id, obb: panelOBB(b) })),
    ...fittings.flatMap((f) => fittingSolids(f).map((obb) => ({ id: f.id, obb }))),
  ]) : []
  const equipmentConflictIds = new Set<string>()
  for (const c of equipmentConflicts) { equipmentConflictIds.add(c.a); equipmentConflictIds.add(c.b) }
  let mismatches = findSpecMismatches(profiles)
  // An installed three-way connector can join faces that no flat plate spans.
  // Only its audited, unobstructed mounting members override that planar inference.
  const threeWay = mismatches.length ? connectors.filter((c) => c.type === 'corner-3way'
    && !conflictIds.has(c.id) && !equipmentConflictIds.has(c.id)) : []
  if (threeWay.length) {
    const supported = new Map<string, string[]>()
    auditBrackets(profiles, threeWay, trims, supported)
    mismatches = mismatches.filter((m) => m.kind !== 'face'
      || ![...supported.values()].some((members) => members.includes(m.a) && members.includes(m.b)))
  }
  const mismatchIds = new Set<string>()
  for (const m of mismatches) { mismatchIds.add(m.a); mismatchIds.add(m.b) }
  cacheKey = profiles
  cacheParts = connectors
  cacheBoards = panels
  cacheFittings = fittings
  cacheEquipment = equipment
  cacheRule = rule
  cacheValue = { trims, conflicts, conflictIds, equipmentConflicts, equipmentConflictIds, mismatches, mismatchIds }
  return cacheValue
}
