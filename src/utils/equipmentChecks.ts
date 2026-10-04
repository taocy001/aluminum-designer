import * as THREE from 'three'
import type { ConnectorData, EquipmentData } from '../store/useStore'
import { equipmentBody, equipmentClearance } from './equipmentGeometry'
import { obbCorners, obbPenetration, type OBB } from './obb'
import { connectorHitsBody } from './connectorCollision'

export interface EquipmentConflict {
  /** Equipment owning the body or clearance being checked. */
  a: string
  b: string
  kind: 'equipment-body' | 'equipment-clearance'
  depth: number
  region: THREE.Box3
}

export interface EquipmentObstacle { id: string; obb: OBB; connector?: ConnectorData }

const TOUCH_TOL = 1

function collision(a: string, b: string, kind: EquipmentConflict['kind'], own: OBB, other: OBB): EquipmentConflict | null {
  const depth = obbPenetration(own, other, TOUCH_TOL)
  if (depth <= 0) return null
  const region = new THREE.Box3().setFromPoints(obbCorners(own)).intersect(new THREE.Box3().setFromPoints(obbCorners(other)))
  return { a, b, kind, depth: Math.round(depth * 100) / 100, region }
}

/** Check physical bodies first, then reserved space; overlapping reservations are allowed. */
export function findEquipmentConflicts(equipment: EquipmentData[], obstacles: EquipmentObstacle[]): EquipmentConflict[] {
  const groups = new Map<string, EquipmentObstacle[]>()
  for (const o of obstacles) {
    const group = groups.get(o.id)
    if (group) group.push(o)
    else groups.set(o.id, [o])
  }
  const boxes = equipment.map((e) => ({ e, body: equipmentBody(e), clearance: equipmentClearance(e) }))
  const out: EquipmentConflict[] = []
  for (const { e, body, clearance } of boxes) {
    for (const [id, solids] of groups) {
      if (id === e.id) continue
      let deepest: EquipmentConflict | null = null
      for (const [kind, own] of [['equipment-body', body], ['equipment-clearance', clearance]] as const) {
        for (const solid of solids) {
          if (solid.connector && !connectorHitsBody(solid.connector, own, TOUCH_TOL, false)) continue
          const hit = collision(e.id, id, kind, own, solid.obb)
          if (hit && (!deepest || hit.depth > deepest.depth)) deepest = hit
        }
        if (deepest) break
      }
      if (deepest) out.push(deepest)
    }
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j]
      const body = collision(a.e.id, b.e.id, 'equipment-body', a.body, b.body)
      if (body) { out.push(body); continue }
      const ab = collision(a.e.id, b.e.id, 'equipment-clearance', a.clearance, b.body)
      const ba = collision(b.e.id, a.e.id, 'equipment-clearance', b.clearance, a.body)
      if (ab) out.push(ab)
      if (ba) out.push(ba)
    }
  }
  return out
}
