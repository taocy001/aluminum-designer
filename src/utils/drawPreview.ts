import * as THREE from 'three'
import type { ProfileData, ProfileSpec } from '../store/useStore'
import { prepareProfile } from './profileFactory'
import { computeTrims } from './jointUtils'

/** The same section alignment and end cuts as a committed member, without allocating
 * a document ID or touching the drawing/history while the pointer moves. */
export function prepareDrawingPreview(start: THREE.Vector3, end: THREE.Vector3, spec: ProfileSpec, profiles: ProfileData[]) {
  let id = '__drawing_preview__'
  const ids = new Set(profiles.map((p) => p.id))
  while (ids.has(id)) id += '_'
  const profile = prepareProfile(start, end, spec, profiles, { id })
  if (!profile) return null
  const trims = computeTrims(profile, [...profiles, profile])
  const quaternion = new THREE.Quaternion(...profile.quaternion).normalize()
  const position = new THREE.Vector3(...profile.position)
    .addScaledVector(new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion), trims.start.trim)
  return { profile, trims, position, quaternion,
    cutLength: isFinite(trims.cutLength) && trims.cutLength > 0.1 ? trims.cutLength : 1 }
}
