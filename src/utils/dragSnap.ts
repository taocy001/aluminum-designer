import * as THREE from 'three'
import type { ProfileData } from '../store/useStore'
import { getProfileDir } from './geometryCore'
import { specDims } from './specUtils'

export type Axis3 = 0 | 1 | 2

/** World-space box of a member as it is modelled (before joint trimming) */
export function memberBox(p: ProfileData, position: [number, number, number] = p.position): THREE.Box3 {
  const quat = new THREE.Quaternion(...p.quaternion).normalize()
  const dir = getProfileDir(p)
  const { hw, hh } = specDims(p.spec)
  const lx = new THREE.Vector3(1, 0, 0).applyQuaternion(quat).multiplyScalar(hw)
  const ly = new THREE.Vector3(0, 1, 0).applyQuaternion(quat).multiplyScalar(hh)
  const start = new THREE.Vector3(...position)
  const end = start.clone().addScaledVector(dir, p.length)
  const box = new THREE.Box3()
  for (const c of [start, end]) {
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      box.expandByPoint(c.clone().addScaledVector(lx, sx).addScaledVector(ly, sy))
    }
  }
  return box
}

/** How close (mm) an edge has to be before it is pulled into alignment */
export function alignThreshold(profiles: ProfileData[]): number {
  let t = 20
  for (const p of profiles) {
    const { w, h } = specDims(p.spec)
    t = Math.max(t, Math.max(w, h))
  }
  return t
}

export interface SnapResult {
  /** correction to add to the proposed positions, per world axis */
  offset: THREE.Vector3
  /** members the snap locked onto, for highlighting */
  refIds: string[]
  /** which axes actually snapped */
  axes: Axis3[]
}

const AXIS_KEYS = ['x', 'y', 'z'] as const

/**
 * Pull a moving group into alignment with the parts around it.
 *
 * Aluminium frames are built face to face, so a member that lands a few millimetres from
 * another one is almost always meant to be flush with it. Within `threshold` (the profile
 * width) every axis is pulled onto the nearest of: a shared face, a flush edge, a shared
 * centreline, or a shared endpoint. Beyond that distance nothing is touched, so parts can
 * still be placed freely; holding Shift skips this entirely.
 */
export function computeDragSnap(
  moving: ProfileData[],
  proposed: Map<string, [number, number, number]>,
  others: ProfileData[],
  threshold = alignThreshold(moving),
): SnapResult {
  const offset = new THREE.Vector3()
  const refIds = new Set<string>()
  const axes: Axis3[] = []
  if (moving.length === 0 || others.length === 0) return { offset, refIds: [], axes }

  const movingBoxes = moving.map((p) => memberBox(p, proposed.get(p.id) ?? p.position))
  const group = new THREE.Box3()
  for (const b of movingBoxes) group.union(b)
  const staticBoxes = others.map((p) => ({ id: p.id, box: memberBox(p) }))

  for (let axis = 0; axis < 3; axis++) {
    const key = AXIS_KEYS[axis]
    const mMin = group.min[key], mMax = group.max[key], mMid = (mMin + mMax) / 2

    let best: { delta: number; id: string } | null = null
    for (const s of staticBoxes) {
      const sMin = s.box.min[key], sMax = s.box.max[key], sMid = (sMin + sMax) / 2
      const candidates = [
        sMin - mMax,   // our far face against their near face (touching)
        sMax - mMin,   // our near face against their far face
        sMin - mMin,   // flush on the low side
        sMax - mMax,   // flush on the high side
        sMid - mMid,   // shared centreline
      ]
      for (const delta of candidates) {
        if (Math.abs(delta) > threshold) continue
        if (!best || Math.abs(delta) < Math.abs(best.delta) - 0.001) best = { delta, id: s.id }
      }
    }
    if (best && Math.abs(best.delta) > 1e-6) {
      offset[key] = Math.round(best.delta * 1000) / 1000
      refIds.add(best.id)
      axes.push(axis as Axis3)
    }
  }

  return { offset, refIds: [...refIds], axes }
}
