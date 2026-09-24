import * as THREE from 'three'
import type { FittingData, ProfileData } from '../store/useStore'
import { memberBox } from './dragSnap'
import { specDims } from './specUtils'

/**
 * Migrate fittings without frame thickness by deriving it from neighbouring members and
 * shifting the opening centre to the corresponding inner frame plane.
 */
export function migrateFittings(profiles: ProfileData[], fittings: FittingData[]): FittingData[] {
  if (fittings.every((f) => f.frame !== undefined)) return fittings
  const boxes = profiles.map((p) => ({ p, box: memberBox(p) }))

  return fittings.map((f) => {
    if (f.frame !== undefined) return f
    const quat = new THREE.Quaternion(...f.quaternion).normalize()
    const out = new THREE.Vector3(0, 0, 1).applyQuaternion(quat)
    const axis: 'x' | 'y' | 'z' = Math.abs(out.x) > 0.5 ? 'x' : Math.abs(out.z) > 0.5 ? 'z' : 'y'
    const sign = out[axis] > 0 ? 1 : -1

    // the front plane as the old code left it: the centreline of the uprights it hangs on
    const at = new THREE.Vector3(...f.position).addScaledVector(out, f.depth / 2)
    // whichever member's centreline is nearest that plane is one of them
    let frame = 20
    let best = Infinity
    for (const { p, box } of boxes) {
      const centre = box.getCenter(new THREE.Vector3())
      const away = Math.abs(centre[axis] - at[axis])
      if (away > 40 || away >= best) continue
      // and it is the size across the way the fitting faces that matters
      const { w, h } = specDims(p.spec)
      best = away
      frame = Math.min(box.max[axis] - box.min[axis], Math.max(w, h))
    }
    return {
      ...f, frame,
      position: [
        f.position[0] - (axis === 'x' ? sign * frame / 2 : 0),
        f.position[1] - (axis === 'y' ? sign * frame / 2 : 0),
        f.position[2] - (axis === 'z' ? sign * frame / 2 : 0),
      ] as [number, number, number],
    }
  })
}
