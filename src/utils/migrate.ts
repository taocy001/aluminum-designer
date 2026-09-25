import * as THREE from 'three'
import type { FittingData, ProfileData } from '../store/useStore'
import { memberBox } from './dragSnap'
import { specDims } from './specUtils'

/**
 * Bring a document written by an older version up to what the current one means.
 *
 * Only one thing needs it so far. A door's leaf and a drawer's front lie *on* the uprights
 * they are fitted to, and the box goes behind them, so those are two planes with a frame's
 * thickness between them. Until that thickness was recorded, the front plane was put on the
 * uprights' centreline and every leaf was half a section inside the post it hung on. Files
 * saved then still say so, and the interference check — which has since learnt to look at
 * fittings — is right to complain about every one of them.
 *
 * The thickness is not in the file, but it is in the drawing: it is the section of the
 * members the fitting is fitted to, measured along the way it faces. So it is read back off
 * the frame and the fitting is moved the half-section it was always meant to be moved.
 */
export function migrateFittings(profiles: ProfileData[], fittings: FittingData[]): FittingData[] {
  return markStacked(migrateFrame(profiles, fittings))
}

/**
 * Drawers one directly above another, in files written before a front knew its neighbour.
 *
 * Two drawers fitted to the same opening, face to face with nothing between them, share an
 * edge: same way round, same width and depth, same place across and in depth, and one's top
 * where the other's bottom is. That edge is a gap between two fronts, not an overlay onto the
 * frame — and without the mark each front lapped 15 mm past it into the other one.
 */
export function markStacked(fittings: FittingData[]): FittingData[] {
  const drawers = fittings.filter((f) => f.kind === 'drawer')
  if (drawers.length < 2) return fittings
  const same = (a: FittingData, b: FittingData) =>
    a.id !== b.id && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.depth - b.depth) < 0.5
    && Math.abs(a.position[0] - b.position[0]) < 0.5 && Math.abs(a.position[2] - b.position[2]) < 0.5
    && a.quaternion.every((v, i) => Math.abs(v - b.quaternion[i]) < 1e-3)
  let changed = false
  const out = fittings.map((f) => {
    if (f.kind !== 'drawer' || f.stacked) return f
    const top = f.position[1] + f.height / 2
    const bottom = f.position[1] - f.height / 2
    const above = drawers.some((g) => same(f, g) && Math.abs(g.position[1] - g.height / 2 - top) < 0.5)
    const below = drawers.some((g) => same(f, g) && Math.abs(g.position[1] + g.height / 2 - bottom) < 0.5)
    if (!above && !below) return f
    changed = true
    return { ...f, stacked: { above, below } }
  })
  return changed ? out : fittings
}

function migrateFrame(profiles: ProfileData[], fittings: FittingData[]): FittingData[] {
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
