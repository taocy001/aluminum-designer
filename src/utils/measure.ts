import * as THREE from 'three'

/**
 * Two points and the distance between them.
 *
 * The question a drawing gets asked most often is "how far is that from that", and until now
 * the only way to answer it was to select something and read a field — which works when the
 * answer happens to be a part's own size and not otherwise. This snaps to the same points
 * drawing snaps to, so the number is the one the frame is actually built to.
 */

export interface Measurement {
  from: THREE.Vector3
  to: THREE.Vector3
}

/** The distance, and its three components, because a diagonal is rarely the useful number */
export function readout(m: Measurement): { total: number; dx: number; dy: number; dz: number } {
  const d = m.to.clone().sub(m.from)
  const r = (v: number) => Math.round(v * 10) / 10
  return { total: r(d.length()), dx: r(Math.abs(d.x)), dy: r(Math.abs(d.y)), dz: r(Math.abs(d.z)) }
}
