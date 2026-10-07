import * as THREE from 'three'
import type { ProfileData } from '../store/useStore'
import { computeAllTrims, type ProfileTrims } from './jointUtils'
import type { MeshHit } from './pickUtils'
import { specDims } from './specUtils'

/** Pick a connector's host and outside mounting face through slots or core holes. */
export function pickConnectorMember(ray: THREE.Ray, profiles: ProfileData[], trims: Map<string, ProfileTrims> = computeAllTrims(profiles), cutAway: (point: THREE.Vector3) => boolean = () => false): MeshHit | null {
  let best: MeshHit | null = null
  let nearest = Infinity
  for (const profile of profiles) {
    const { hw, hh } = specDims(profile.spec)
    const cut = trims.get(profile.id)!
    const start = cut.start.trim
    const end = start + (Number.isFinite(cut.cutLength) && cut.cutLength > 0.1 ? cut.cutLength : 1)
    const q = new THREE.Quaternion(...profile.quaternion).normalize()
    const world = new THREE.Matrix4().compose(new THREE.Vector3(...profile.position), q, new THREE.Vector3(1, 1, 1))
    const localRay = ray.clone().applyMatrix4(world.clone().invert())
    const box = new THREE.Box3(new THREE.Vector3(-hw, -hh, start), new THREE.Vector3(hw, hh, end))
    const tolerantBox = box.clone().expandByScalar(1e-7)
    // Consider both surfaces: sectioning may hide the entry but retain the exit.
    for (let axis = 0; axis < 3; axis++) for (const side of [-1, 1]) {
      const direction = localRay.direction.getComponent(axis)
      if (Math.abs(direction) < 1e-12) continue
      const t = ((side < 0 ? box.min : box.max).getComponent(axis) - localRay.origin.getComponent(axis)) / direction
      if (t < 0) continue
      const hit = localRay.at(t, new THREE.Vector3())
      if (!tolerantBox.containsPoint(hit)) continue
      box.clampPoint(hit, hit)
      const point = hit.applyMatrix4(world)
      const depth = ray.origin.distanceToSquared(point)
      if (depth >= nearest || cutAway(point)) continue
      nearest = depth
      best = { profileId: profile.id, point, normal: new THREE.Vector3().setComponent(axis, side).applyQuaternion(q) }
    }
  }
  return best
}
