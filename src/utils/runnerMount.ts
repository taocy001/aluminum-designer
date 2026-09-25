import * as THREE from 'three'
import type { FittingData, PanelData, ProfileData } from '../store/useStore'
import type { ProfileTrims } from './jointUtils'
import { panelOBB, trimmedOBB } from './analysis'
import { obbCorners, type OBB } from './obb'
import { FRONT_GAP } from './fittingGeometry'

/**
 * Has each drawer got something to screw its runners to?
 *
 * A side-mount runner is a steel slide screwed to the cabinet beside the opening, one each
 * side, with the box 12.5 mm in from it. The frame has to offer it a face there: a member
 * running front to back beside the opening, or an upright at the front and another at the
 * back to bridge, or a side board. The drawer used to draw a rail of its own inside the
 * opening for the purpose — a rail nobody would cut, that was in no cut list and no export,
 * and that sat in the drawer box's own sides — so the question was never asked.
 */
export interface RunnerFault {
  id: string
  side: 'left' | 'right'
}

/** how far the face beside the opening may be from the opening's edge (mm) */
const BESIDE = 3
/** how much of the box's height a mount has to reach to take the runner (mm) */
const REACH = 10

function localBox(obb: OBB, inv: THREE.Quaternion, origin: THREE.Vector3): THREE.Box3 {
  const box = new THREE.Box3()
  for (const c of obbCorners(obb)) box.expandByPoint(c.sub(origin).applyQuaternion(inv))
  return box
}

export function runnerFaults(
  profiles: ProfileData[], trims: Map<string, ProfileTrims>, fittings: FittingData[], panels: PanelData[] = [],
): RunnerFault[] {
  const drawers = fittings.filter((f) => f.kind === 'drawer')
  if (drawers.length === 0) return []
  const solids: OBB[] = [
    ...profiles.flatMap((p) => { const t = trims.get(p.id); return t ? [trimmedOBB(p, t)] : [] }),
    ...panels.map(panelOBB),
  ]
  const out: RunnerFault[] = []
  for (const f of drawers) {
    const origin = new THREE.Vector3(...f.position)
    const inv = new THREE.Quaternion(...f.quaternion).normalize().invert()
    // the height the box occupies, which is where a runner can be fixed
    const y0 = -f.height / 2
    const y1 = y0 + Math.max(40, f.height - FRONT_GAP * 2 - 20)
    const halfW = f.width / 2, halfD = f.depth / 2
    const boxes = solids.map((o) => localBox(o, inv, origin))
    for (const [s, side] of [[-1, 'left'], [1, 'right']] as const) {
      let front = false, back = false, along = false
      for (const b of boxes) {
        // its face towards the opening is at the opening's edge
        const face = s > 0 ? b.min.x : -b.max.x
        if (Math.abs(face - halfW) > BESIDE) continue
        if (Math.min(b.max.y, y1) - Math.max(b.min.y, y0) < REACH) continue
        const inDepth = Math.min(b.max.z, halfD) - Math.max(b.min.z, -halfD)
        if (inDepth <= 0) continue
        const size = b.getSize(new THREE.Vector3())
        if (inDepth >= f.depth * 0.5 && size.z >= size.x) { along = true; break }
        if (size.y > size.z && size.y > size.x) {
          const mid = (b.min.z + b.max.z) / 2
          if (mid >= 0) front = true
          else back = true
        }
      }
      if (!along && !(front && back)) out.push({ id: f.id, side })
    }
  }
  return out
}
