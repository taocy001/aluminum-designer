import * as THREE from 'three'
import { useStore, type ProfileData, type ProfileSpec } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { analyzeFrame } from './analysis'
import { faceAlignOnCreate } from './faceAlign'
import { connectorSeatAt } from './bracketSeat'
import { specDims } from './specUtils'
import { translations } from './translations'

let idSeq = 0
export function nextId(prefix: string): string {
  idSeq = (idSeq + 1) % 1000
  return `${prefix}-${Date.now().toString(36)}${idSeq.toString(36)}`
}

export const MIN_LENGTH = 10

/** Round to 0.001 mm and normalise -0 so stored coordinates compare cleanly */
export function clean(v: number): number {
  const r = Math.round(v * 1000) / 1000
  return r === 0 ? 0 : r
}

export function buildProfile(start: THREE.Vector3, end: THREE.Vector3, spec: ProfileSpec): ProfileData | null {
  const length = start.distanceTo(end)
  if (!isFinite(length) || length < MIN_LENGTH) return null
  const direction = end.clone().sub(start).normalize()
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction)
  return {
    id: nextId('p'),
    spec,
    length: Math.round(length * 100) / 100,
    position: [clean(start.x), clean(start.y), clean(start.z)],
    quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
    miterCuts: [],
    holes: [],
  }
}

/** Lowest allowed centerline height for a horizontal member so it rests on the floor */
export function floorY(spec: ProfileSpec): number {
  return specDims(spec).hh
}

/**
 * Lowest point of a member's body, valid at any orientation.
 * Gesture-driven moves use it to keep parts on or above the floor; typed coordinates don't.
 */
export function lowestPointY(p: ProfileData): number {
  const quat = new THREE.Quaternion(...p.quaternion).normalize()
  const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(quat)
  const lx = new THREE.Vector3(1, 0, 0).applyQuaternion(quat)
  const ly = new THREE.Vector3(0, 1, 0).applyQuaternion(quat)
  const { hw, hh } = specDims(p.spec)
  const start = new THREE.Vector3(...p.position)
  const end = start.clone().addScaledVector(dir, p.length)
  const half = Math.abs(lx.y) * hw + Math.abs(ly.y) * hh
  return Math.min(start.y, end.y) - half
}

/**
 * Add a profile. Interference no longer blocks placement — the member is created and the
 * conflicting parts are flagged in red, which keeps modelling fluid.
 */
export function tryAddProfile(start: THREE.Vector3, end: THREE.Vector3, spec: ProfileSpec): boolean {
  const { showToast, language } = useToolStore.getState()
  const t = translations[language]
  const built = buildProfile(start, end, spec)
  if (!built) { showToast(t.toastTooShort, 'error'); return false }
  // a frame is assembled face to face, not centreline to centreline: nudge the new member
  // sideways so the faces its brackets will sit on line up with what it landed on
  const candidate = faceAlignOnCreate(built, useStore.getState().profiles)
  useStore.getState().addProfile(candidate)
  const { conflictIds } = analyzeFrame(useStore.getState().profiles)
  if (conflictIds.has(candidate.id)) showToast(t.toastOverlap, 'error')
  return true
}

/** Place a connector, oriented to the members it was dropped on */
export function placeConnector(point: THREE.Vector3, type: string, surfaceNormal?: THREE.Vector3 | null): void {
  const profiles = useStore.getState().profiles
  // the part goes where it can be bolted, which near a corner is not where the pointer is
  const seat = connectorSeatAt(type, point, profiles, surfaceNormal)
  useStore.getState().addConnector({
    id: nextId('c'),
    type,
    series: seat.series,
    position: seat.position,
    quaternion: seat.quaternion,
  })
}
