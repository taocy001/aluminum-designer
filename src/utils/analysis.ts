import * as THREE from 'three'
import type { ConnectorData, FittingData, PanelData, ProfileData } from '../store/useStore'
import { connectorExtent, connectorScale } from './connectorCatalog'
import { computeAllTrims, computeTrims, getThroughRule, type ProfileTrims } from './jointUtils'
import { getProfileDir } from './geometryCore'
import { specDims } from './specUtils'
import { makeOBB, obbPenetration, obbCorners, type OBB } from './obb'
import { findSpecMismatches, type SpecMismatch } from './specCompat'
import { fittingObb } from './fittingGeometry'

/** members closer than this are considered touching, not interfering (mm) */
const TOUCH_TOL = 1
/**
 * A connector is meant to be in contact with the metal — that is what bolting is — so the
 * line between "lying on it" and "sunk into it" sits further out than it does for two
 * members, which have no business touching at all.
 */
const CONNECTOR_TOUCH_TOL = 3
/**
 * Boards and fittings rest against the metal — a shelf sits on its rails and a door shuts
 * against the frame — so the same reasoning applies to them as to a bracket, and the line
 * between "against it" and "inside it" is a millimetre or two rather than nothing.
 */
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

/**
 * Members are allowed to interfere — the tool reports it instead of refusing the edit.
 * Detection runs on the as-built bodies with an oriented-box test, so freely rotated
 * members are judged by their real shape rather than an axis-aligned envelope.
 */
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
): Conflict[] {
  const boxes: Array<{ id: string; obb: OBB }> = profiles.map((p) => ({ id: p.id, obb: trimmedOBB(p, trims.get(p.id)!) }))
  // A bracket buried in a member, or two of them on top of each other, is as much a thing
  // that cannot be built as two members running through each other — and rather easier to
  // draw by accident, because a twenty-millimetre part inside a rail is invisible.
  // Its flanges lie *on* the metal, so the tolerance is what tells lying on from sunk into.
  // A board buried in a post and a door sunk into the frame are exactly as unbuildable as two
  // members through each other, and until now nothing looked: the check took the metal and the
  // hardware and stopped there, so a drawing could be declared clean with every one of its
  // boards and doors inside the frame.
  const members = boxes.length
  for (const c of connectors) boxes.push({ id: c.id, obb: connectorOBB(c) })
  const parts = boxes.length
  for (const b of panels) boxes.push({ id: b.id, obb: panelOBB(b) })
  for (const f of fittings) boxes.push({ id: f.id, obb: fittingObb(f) })

  const out: Conflict[] = []
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const bothParts = i >= members && j >= members
      const tol = i >= parts || j >= parts ? BOARD_TOUCH_TOL
        : i >= members || j >= members ? CONNECTOR_TOUCH_TOL : TOUCH_TOL
      const depth = obbPenetration(boxes[i].obb, boxes[j].obb, tol)
      if (depth <= 0) continue
      void bothParts
      out.push({
        a: boxes[i].id, b: boxes[j].id,
        depth: Math.round(depth * 100) / 100,
        region: regionOf(boxes[i].obb, boxes[j].obb),
      })
    }
  }
  return out
}

let cacheKey: ProfileData[] | null = null
let cacheParts: ConnectorData[] | null = null
let cacheBoards: PanelData[] | null = null
let cacheFittings: FittingData[] | null = null
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
  panels: PanelData[] = [], fittings: FittingData[] = [],
): FrameAnalysis {
  // the through rule changes every trim in the document, so it belongs in the cache key
  const rule = getThroughRule()
  if (cacheKey === profiles && cacheParts === connectors && cacheBoards === panels
    && cacheFittings === fittings && cacheRule === rule && cacheValue) return cacheValue
  const trims = computeAllTrims(profiles)
  const conflicts = findConflicts(profiles, trims, connectors, panels, fittings)
  const conflictIds = new Set<string>()
  for (const c of conflicts) { conflictIds.add(c.a); conflictIds.add(c.b) }
  const mismatches = findSpecMismatches(profiles)
  const mismatchIds = new Set<string>()
  for (const m of mismatches) { mismatchIds.add(m.a); mismatchIds.add(m.b) }
  cacheKey = profiles
  cacheParts = connectors
  cacheBoards = panels
  cacheFittings = fittings
  cacheRule = rule
  cacheValue = { trims, conflicts, conflictIds, mismatches, mismatchIds }
  return cacheValue
}
