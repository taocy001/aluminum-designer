import * as THREE from 'three'
import { useStore, type ProfileData, type ProfileSpec } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { wouldOverlap } from './snapUtils'
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

/** Validate and add a profile; shows a toast on rejection. Returns true on success. */
export function tryAddProfile(start: THREE.Vector3, end: THREE.Vector3, spec: ProfileSpec): boolean {
  const { showToast, language } = useToolStore.getState()
  const t = translations[language]
  const candidate = buildProfile(start, end, spec)
  if (!candidate) { showToast(t.toastTooShort, 'error'); return false }
  const profiles = useStore.getState().profiles
  if (wouldOverlap(candidate, profiles)) { showToast(t.toastOverlap, 'error'); return false }
  useStore.getState().addProfile(candidate)
  return true
}

export function placeConnector(point: THREE.Vector3, type: string): void {
  useStore.getState().addConnector({
    id: nextId('c'),
    type,
    position: [clean(point.x), clean(point.y), clean(point.z)],
    quaternion: [0, 0, 0, 1],
  })
}
