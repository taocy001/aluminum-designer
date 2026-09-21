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

/** Never pull from further than this, however far the camera is zoomed out (mm) */
export const ALIGN_MAX_MM = 60
/** The pull reaches at least this far on screen, so it feels the same at any zoom */
export const ALIGN_PX = 18

/**
 * How close an edge has to be before it is pulled into alignment.
 * The profile width is the floor (frames are built flush at that scale) and the on-screen
 * distance is the other half: a 20 mm window is only a few pixels on a zoomed-out frame,
 * which is why the pull was there but could not be felt.
 */
export function alignThreshold(profiles: ProfileData[], screenWorld = 0): number {
  let t = 20
  for (const p of profiles) {
    const { w, h } = specDims(p.spec)
    t = Math.max(t, Math.max(w, h))
  }
  return Math.min(ALIGN_MAX_MM, Math.max(t, screenWorld))
}

export type AlignKind = 'face' | 'edge' | 'center'
const CANDIDATE_KIND: AlignKind[] = ['face', 'face', 'edge', 'edge', 'center']

export interface SnapGuide {
  axis: Axis3
  kind: AlignKind
  /** the coordinate both parts share on that axis, for drawing the alignment line */
  coord: number
  refId: string
}

export interface SnapResult {
  /** correction to add to the proposed positions, per world axis */
  offset: THREE.Vector3
  /** members the snap locked onto, for highlighting */
  refIds: string[]
  /** which axes actually snapped */
  axes: Axis3[]
  /** what engaged, for the alignment lines and the HUD */
  guides: SnapGuide[]
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
  const guides: SnapGuide[] = []
  if (moving.length === 0 || others.length === 0) return { offset, refIds: [], axes, guides }

  const movingBoxes = moving.map((p) => memberBox(p, proposed.get(p.id) ?? p.position))
  const group = new THREE.Box3()
  for (const b of movingBoxes) group.union(b)
  const staticBoxes = others.map((p) => ({ id: p.id, box: memberBox(p) }))

  for (let axis = 0; axis < 3; axis++) {
    const key = AXIS_KEYS[axis]
    const mMin = group.min[key], mMax = group.max[key], mMid = (mMin + mMax) / 2

    let best: { delta: number; id: string; kind: AlignKind; coord: number } | null = null
    for (const s of staticBoxes) {
      const sMin = s.box.min[key], sMax = s.box.max[key], sMid = (sMin + sMax) / 2
      const candidates = [
        { delta: sMin - mMax, coord: sMin },   // our far face against their near face
        { delta: sMax - mMin, coord: sMax },   // our near face against their far face
        { delta: sMin - mMin, coord: sMin },   // flush on the low side
        { delta: sMax - mMax, coord: sMax },   // flush on the high side
        { delta: sMid - mMid, coord: sMid },   // shared centreline
      ]
      candidates.forEach((c, idx) => {
        if (Math.abs(c.delta) > threshold) return
        if (!best || Math.abs(c.delta) < Math.abs(best.delta) - 0.001) {
          best = { delta: c.delta, id: s.id, kind: CANDIDATE_KIND[idx], coord: c.coord }
        }
      })
    }
    if (best) {
      const hit = best as { delta: number; id: string; kind: AlignKind; coord: number }
      // an axis that was already aligned is not news: only report a pull that actually happened
      if (Math.abs(hit.delta) <= 1e-6) continue
      offset[key] = Math.round(hit.delta * 1000) / 1000
      refIds.add(hit.id)
      axes.push(axis as Axis3)
      guides.push({ axis: axis as Axis3, kind: hit.kind, coord: hit.coord, refId: hit.id })
    }
  }

  return { offset, refIds: [...refIds], axes, guides }
}
