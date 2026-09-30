import * as THREE from 'three'
import type { FittingData, PanelData, ProfileData } from '../store/useStore'
import type { ProfileTrims } from './jointUtils'
import { panelOBB, trimmedOBB } from './analysis'
import { obbCorners, type OBB } from './obb'
import { FRONT_GAP } from './fittingGeometry'

/**
 * Check geometry available for runner mounting on both sides of each drawer:
 * a depth rail, front/back uprights, or a side board. Runner allowance is 12.5 mm per side.
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

type FacePoint = { y: number; z: number }
function clipFace(points: FacePoint[], axis: 'y' | 'z', at: number, above: boolean): FacePoint[] {
  const out: FacePoint[] = []
  const inside = (p: FacePoint) => above ? p[axis] >= at : p[axis] <= at
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], ia = inside(a), ib = inside(b)
    if (ia) out.push(a)
    if (ia !== ib) {
      const t = (at - a[axis]) / (b[axis] - a[axis])
      out.push({ y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t })
    }
  }
  return out
}

/** A straight runner needs one continuous horizontal band, not a rising face's Z span. */
function horizontalBandWidth(face: FacePoint[]): number {
  // Intersect the face shifted up and down by half the installation band height. Any
  // horizontal interval in this intersection has the whole 10 mm band inside the face.
  const shifted = (by: number) => face.map((p) => ({ y: p.y + by, z: p.z }))
  const boundary = shifted(-REACH / 2)
  let band = shifted(REACH / 2)
  const cross = (a: FacePoint, b: FacePoint, p: FacePoint) => (b.y - a.y) * (p.z - a.z) - (b.z - a.z) * (p.y - a.y)
  const winding = Math.sign(boundary.reduce((sum, a, i) => {
    const b = boundary[(i + 1) % boundary.length]
    return sum + a.y * b.z - b.y * a.z
  }, 0))
  if (!winding) return 0
  for (let k = 0; k < boundary.length && band.length; k++) {
    const a = boundary[k], b = boundary[(k + 1) % boundary.length], clipped: FacePoint[] = []
    for (let i = 0; i < band.length; i++) {
      const u = band[i], v = band[(i + 1) % band.length]
      const du = winding * cross(a, b, u), dv = winding * cross(a, b, v)
      if (du >= -1e-8) clipped.push(u)
      if ((du >= -1e-8) !== (dv >= -1e-8)) {
        const t = du / (du - dv)
        clipped.push({ y: u.y + (v.y - u.y) * t, z: u.z + (v.z - u.z) * t })
      }
    }
    band = clipped
  }
  let longest = 0
  for (const { y } of band) {
    const at: number[] = []
    for (let i = 0; i < band.length; i++) {
      const a = band[i], b = band[(i + 1) % band.length]
      if (Math.abs(a.y - y) < 1e-8) at.push(a.z)
      if ((a.y < y && b.y > y) || (b.y < y && a.y > y)) at.push(a.z + (b.z - a.z) * (y - a.y) / (b.y - a.y))
    }
    if (at.length) longest = Math.max(longest, Math.max(...at) - Math.min(...at))
  }
  return longest
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
      for (let k = 0; k < boxes.length; k++) {
        const b = boxes[k], body = solids[k]
        // The mounting face itself must face the opening. A diagonal rail's AABB can
        // begin at the opening edge even while its actual face immediately slopes away.
        const localAxes = body.axes.map((axis) => axis.clone().applyQuaternion(inv))
        const faceAxis = localAxes.findIndex((axis) => Math.abs(axis.x) > 1 - 1e-6)
        if (faceAxis < 0) continue
        const faceCentre = body.center.clone().sub(origin).applyQuaternion(inv)
          .addScaledVector(localAxes[faceAxis], -s * Math.sign(localAxes[faceAxis].x) * body.half.getComponent(faceAxis))
        // its face towards the opening is at the opening's edge
        const face = s * faceCentre.x
        if (Math.abs(face - halfW) > BESIDE) continue
        const other = [0, 1, 2].filter((i) => i !== faceAxis)
        let footprint = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, c]) => {
          const p = faceCentre.clone().addScaledVector(localAxes[other[0]], a * body.half.getComponent(other[0]))
            .addScaledVector(localAxes[other[1]], c * body.half.getComponent(other[1]))
          return { y: p.y, z: p.z }
        })
        footprint = clipFace(clipFace(footprint, 'y', y0, true), 'y', y1, false)
        footprint = clipFace(clipFace(footprint, 'z', -halfD, true), 'z', halfD, false)
        if (footprint.length < 3) continue
        const range = (axis: 'y' | 'z') => Math.max(...footprint.map((p) => p[axis])) - Math.min(...footprint.map((p) => p[axis]))
        if (range('y') < REACH) continue
        const inDepth = range('z')
        if (inDepth <= 0) continue
        const size = b.getSize(new THREE.Vector3())
        if (horizontalBandWidth(footprint) >= f.depth * 0.5 && size.z >= size.x) { along = true; break }
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
