import * as THREE from 'three'
import type { EquipmentData } from '../store/useStore'
import { makeOBB, type OBB } from './obb'

/** User-defined equipment body; local +Z is the front. */
export function equipmentBody(e: EquipmentData): OBB {
  return makeOBB(new THREE.Vector3(...e.position), new THREE.Vector3(e.width / 2, e.height / 2, e.depth / 2),
    new THREE.Quaternion(...e.quaternion).normalize())
}

/** Body expanded by each face's installation clearance. */
export function equipmentClearance(e: EquipmentData): OBB {
  const c = e.clearance, q = new THREE.Quaternion(...e.quaternion).normalize()
  const center = new THREE.Vector3((c.right - c.left) / 2, (c.top - c.bottom) / 2, (c.front - c.back) / 2)
    .applyQuaternion(q).add(new THREE.Vector3(...e.position))
  const half = new THREE.Vector3((e.width + c.left + c.right) / 2,
    (e.height + c.bottom + c.top) / 2, (e.depth + c.back + c.front) / 2)
  return makeOBB(center, half, q)
}
