import * as THREE from 'three'
import type { EquipmentClearance, EquipmentData } from '../store/useStore'

const sides = ['left', 'right', 'bottom', 'top', 'back', 'front'] as const
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const tuple = (value: unknown, size: number): value is number[] => Array.isArray(value) && value.length === size && value.every(finite)

/** Missing clearances mean zero; invalid or unknown entries never silently become defaults. */
export function normalizeEquipmentClearance(value: unknown): EquipmentClearance | null {
  if (value === undefined) return { left: 0, right: 0, bottom: 0, top: 0, back: 0, front: 0 }
  if (!record(value) || Object.keys(value).some((key) => !sides.includes(key as typeof sides[number]))) return null
  if (sides.some((key) => value[key] !== undefined && (!finite(value[key]) || value[key] < 0))) return null
  return Object.fromEntries(sides.map((key) => [key, value[key] ?? 0])) as unknown as EquipmentClearance
}

export function validEquipmentClearance(value: unknown): value is EquipmentClearance {
  return record(value) && Object.keys(value).length === sides.length
    && sides.every((key) => finite(value[key]) && value[key] >= 0)
}

/** Check both saved values and their rotated envelope, so finite inputs cannot overflow geometry. */
export function validEquipment(value: unknown): value is EquipmentData {
  if (!record(value) || typeof value.id !== 'string' || !value.id.trim()
    || typeof value.name !== 'string' || !value.name.trim()
    || ![value.width, value.height, value.depth].every((n) => finite(n) && n > 0)
    || !tuple(value.position, 3) || !tuple(value.quaternion, 4)
    || !validEquipmentClearance(value.clearance)
    || (value.locked !== undefined && typeof value.locked !== 'boolean')
    || ['openingBinding', 'runnerBinding', 'supportBinding'].some((key) => value[key] !== undefined)) return false
  const norm = value.quaternion.reduce((sum, n) => sum + n * n, 0)
  if (!Number.isFinite(norm) || norm < 1e-12) return false
  const e = value as unknown as EquipmentData, c = e.clearance
  const span = [e.width + c.left + c.right, e.height + c.bottom + c.top, e.depth + c.back + c.front]
  if (!span.every(finite)) return false
  const q = new THREE.Quaternion(...e.quaternion).normalize()
  const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)].map((axis) => axis.applyQuaternion(q))
  const centre = new THREE.Vector3((c.right - c.left) / 2, (c.top - c.bottom) / 2, (c.front - c.back) / 2)
    .applyQuaternion(q).add(new THREE.Vector3(...e.position))
  return [0, 1, 2].every((i) => {
    const extent = axes.reduce((sum, axis, j) => sum + Math.abs(axis.getComponent(i)) * span[j] / 2, 0)
    return Number.isFinite(centre.getComponent(i) - extent) && Number.isFinite(centre.getComponent(i) + extent)
  })
}

export function validEquipmentList(value: unknown): value is EquipmentData[] {
  return Array.isArray(value) && value.every(validEquipment) && new Set(value.map((e) => e.id)).size === value.length
}
