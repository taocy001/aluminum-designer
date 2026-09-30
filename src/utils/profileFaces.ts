import * as THREE from 'three'
import type { ProfileData } from '../store/useStore'
import type { ProfileTrims } from './jointUtils'
import { specDims } from './specUtils'

export type FacePoint = [number, number, number]

/** A face of the member in its own coordinate system; local Z is its length. */
export interface ProfileFaceRef {
  profileId: string
  axis: 0 | 1 | 2
  side: -1 | 1
}

export interface ProfileFace extends ProfileFaceRef {
  corners: [FacePoint, FacePoint, FacePoint, FacePoint]
  center: FacePoint
  normal: FacePoint
}

/** The envelope of a real, trimmed member face, including rectangular section roll. */
export function profileFace(p: ProfileData, ref: ProfileFaceRef, trims?: ProfileTrims): ProfileFace {
  const { hw, hh } = specDims(p.spec)
  const start = trims?.start.trim ?? 0
  const cut = trims?.cutLength ?? p.length
  // Match Profile's rendered length, including its guard against invalid cuts.
  const end = start + (Number.isFinite(cut) && cut > 0.1 ? cut : 1)
  const low: FacePoint = [-hw, -hh, start]
  const high: FacePoint = [hw, hh, end]
  const across = (ref.axis + 1) % 3
  const along = (ref.axis + 2) % 3
  const q = new THREE.Quaternion(...p.quaternion).normalize()
  const origin = new THREE.Vector3(...p.position)
  const toWorld = (point: FacePoint): FacePoint => new THREE.Vector3(...point).applyQuaternion(q).add(origin).toArray() as FacePoint
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
    const point: FacePoint = [0, 0, 0]
    point[ref.axis] = ref.side < 0 ? low[ref.axis] : high[ref.axis]
    point[across] = a < 0 ? low[across] : high[across]
    point[along] = b < 0 ? low[along] : high[along]
    return toWorld(point)
  }) as ProfileFace['corners']
  if (ref.side < 0) corners.reverse()
  const center = new THREE.Vector3()
  for (const point of corners) center.add(new THREE.Vector3(...point))
  const normal = new THREE.Vector3().setComponent(ref.axis, ref.side).applyQuaternion(q)
  return { ...ref, corners, center: center.multiplyScalar(0.25).toArray() as FacePoint, normal: normal.toArray() as FacePoint }
}

/** An AABB boundary is a real face only when a local face is parallel to it. */
export function profileFaceForWorldAxis(
  p: ProfileData, axis: 0 | 1 | 2, side: -1 | 1, trims?: ProfileTrims,
): ProfileFace | null {
  const q = new THREE.Quaternion(...p.quaternion).normalize()
  for (const localAxis of [0, 1, 2] as const) {
    const normal = new THREE.Vector3().setComponent(localAxis, 1).applyQuaternion(q)
    const component = normal.getComponent(axis)
    if (Math.abs(component) < 1 - 1e-6) continue
    return profileFace(p, { profileId: p.id, axis: localAxis, side: component * side > 0 ? 1 : -1 }, trims)
  }
  return null
}
