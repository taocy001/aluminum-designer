import * as THREE from 'three'

/** Oriented bounding box: centre, half extents and the three unit axes */
export interface OBB {
  center: THREE.Vector3
  half: THREE.Vector3
  axes: [THREE.Vector3, THREE.Vector3, THREE.Vector3]
}

export function makeOBB(center: THREE.Vector3, half: THREE.Vector3, quat: THREE.Quaternion): OBB {
  return {
    center: center.clone(),
    half: half.clone(),
    axes: [
      new THREE.Vector3(1, 0, 0).applyQuaternion(quat),
      new THREE.Vector3(0, 1, 0).applyQuaternion(quat),
      new THREE.Vector3(0, 0, 1).applyQuaternion(quat),
    ],
  }
}

function projectedRadius(box: OBB, axis: THREE.Vector3): number {
  return Math.abs(box.axes[0].dot(axis)) * box.half.x
    + Math.abs(box.axes[1].dot(axis)) * box.half.y
    + Math.abs(box.axes[2].dot(axis)) * box.half.z
}

/**
 * Separating-axis test for two oriented boxes. Returns how deep they interpenetrate
 * along the axis of least penetration, or 0 when a separating axis exists.
 * Axis-aligned boxes would over-report once members can be rotated freely, hence OBB.
 */
export function obbPenetration(a: OBB, b: OBB, tol = 0): number {
  const t = b.center.clone().sub(a.center)
  const axes: THREE.Vector3[] = [...a.axes, ...b.axes]
  for (const ax of a.axes) {
    for (const bx of b.axes) {
      const c = new THREE.Vector3().crossVectors(ax, bx)
      if (c.lengthSq() > 1e-6) axes.push(c.normalize())
    }
  }
  let min = Infinity
  for (const axis of axes) {
    if (axis.lengthSq() < 1e-9) continue
    const overlap = projectedRadius(a, axis) + projectedRadius(b, axis) - Math.abs(t.dot(axis))
    if (overlap <= tol) return 0
    if (overlap < min) min = overlap
  }
  return min === Infinity ? 0 : min
}

/** Eight corners of an OBB, for building a world-space box around it */
export function obbCorners(box: OBB): THREE.Vector3[] {
  const out: THREE.Vector3[] = []
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    out.push(box.center.clone()
      .addScaledVector(box.axes[0], sx * box.half.x)
      .addScaledVector(box.axes[1], sy * box.half.y)
      .addScaledVector(box.axes[2], sz * box.half.z))
  }
  return out
}
