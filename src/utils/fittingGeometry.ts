import * as THREE from 'three'
import type { FittingData, HingeSide, HingeType, Overlay } from '../store/useStore'
import { makeOBB, obbPenetration, obbCorners, type OBB } from './obb'

/**
 * Shared board geometry for fitting rendering, cut lists and collision checks.
 * Local axes: X across the opening, Y up and +Z outward; origin is the opening centre.
 */

/** side clearance each side of a drawer box, which is what a side-mount runner occupies (mm) */
export const RUNNER_CLEARANCE = 12.5
/** gap all round a front, so neighbouring fronts do not rub (mm) */
export const FRONT_GAP = 3
/** the boards a drawer box is made from (mm) */
export const BOX_BOARD = 15
/** space behind a closed drawer box, measured from the clear opening's rear plane (mm) */
export const DRAWER_REAR_CLEARANCE = 20
/** a door or a drawer front (mm) */
export const FRONT_BOARD = 18
/** how much of the frame a full-overlay front covers on each side (mm) */
export const OVERLAY_FULL = 18
/** ...and a half overlay */
export const OVERLAY_HALF = 9

/** The furthest each mechanism will go, whatever angle is asked for */
export const HINGE_MAX: Record<HingeType, number> = {
  cup: 180,          // concealed hinges are made from 95° to 180°, in steps
  slot: 270,         // two leaves bolted into T-slots: nothing is in the way
  continuous: 180,   // a piano hinge folds back flat and no further
}
/** What each mechanism is usually ordered as */
export const HINGE_DEFAULT: Record<HingeType, number> = { cup: 110, slot: 180, continuous: 180 }

/** How far this door actually opens */
export function swingOf(f: { hingeType?: HingeType; swing?: number }): number {
  const type = f.hingeType ?? 'cup'
  return Math.min(HINGE_MAX[type], Math.max(30, f.swing ?? HINGE_DEFAULT[type]))
}

/** Hinges needed for a door this tall, by kind */
export function hingeCount(type: HingeType, heightMm: number): number {
  if (type === 'continuous') return 1
  // the usual rule: two up to 900, three to 1600, four beyond
  return heightMm <= 900 ? 2 : heightMm <= 1600 ? 3 : 4
}

export interface Board {
  /** what it is, for the cut list */
  role: 'side' | 'back' | 'inner-front' | 'base' | 'front' | 'panel'
  width: number
  height: number
  thickness: number
  /** centre, in the fitting's own frame */
  position: [number, number, number]
  /** rotation from a board lying in XY, in the fitting's own frame */
  quaternion: [number, number, number, number]
}

export interface FittingParts {
  boards: Board[]
  /** hinge positions along the hung edge, in the fitting's own frame */
  hinges: Array<[number, number, number]>
  /** how far the whole thing travels when fully open: mm for a drawer, degrees for a door */
  travel: number
}

const Q_FLAT: [number, number, number, number] = [0, 0, 0, 1]
/** a board standing on edge, facing across X */
const Q_SIDE = (() => {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
  return [q.x, q.y, q.z, q.w] as [number, number, number, number]
})()
/** a board lying flat, facing up */
const Q_LEVEL = (() => {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)
  return [q.x, q.y, q.z, q.w] as [number, number, number, number]
})()

export function overlayMm(overlay: Overlay | undefined): number {
  return overlay === 'inset' ? -FRONT_GAP : overlay === 'half' ? OVERLAY_HALF : OVERLAY_FULL
}

/**
 * The front of a drawer or the leaf of a door: the same board, sized by how it sits.
 *
 * Each edge is decided on its own. An outer edge uses the overlay less the gap. A door's
 * meeting edge or a stacked drawer's shared edge stops half a gap short of its opening,
 * leaving 3 mm between the adjacent fronts. Unequal edge allowances shift the board centre.
 */
function frontBoard(f: FittingData): Board {
  const inset = f.overlay === 'inset'
  const lap = inset ? -FRONT_GAP : overlayMm(f.overlay) - FRONT_GAP
  const meet = -FRONT_GAP / 2
  const left = f.kind === 'door' && f.meeting === 'left' ? meet : lap
  const right = f.kind === 'door' && f.meeting === 'right' ? meet : lap
  const top = f.kind === 'drawer' && f.stacked?.above ? meet : lap
  const bottom = f.kind === 'drawer' && f.stacked?.below ? meet : lap
  return {
    role: f.kind === 'door' ? 'panel' : 'front',
    width: Math.max(20, f.width + left + right),
    height: Math.max(20, f.height + top + bottom),
    thickness: FRONT_BOARD,
    // Overlay fronts rest on the frame; an inset front finishes flush with its outside.
    position: [(right - left) / 2, (top - bottom) / 2, f.depth / 2 + (f.frame ?? 0) + (inset ? -1 : 1) * FRONT_BOARD / 2],
    quaternion: Q_FLAT,
  }
}

export interface HandleBlock {
  position: [number, number, number]
  size: [number, number, number]
}

/** Hardware in the moving front's frame: +Z is outside, including the frame offset. */
export function fittingHandle(f: FittingData): { grip: HandleBlock; mounts: HandleBlock[] } {
  const front = frontBoard(f)
  const side = f.hinge ?? 'left'
  const horizontal = f.kind === 'drawer' || side === 'top' || side === 'bottom'
  const thickness = 14
  const clearance = 18
  const span = horizontal ? front.width : front.height
  const length = Math.min(160, Math.max(thickness, span * (f.kind === 'drawer' ? 0.5 : 0.4)))
  let [x, y] = front.position
  if (f.kind === 'door') {
    // Put the pull opposite the hinge, with an inset that also fits a small front.
    if (horizontal) y += (side === 'top' ? -1 : 1) * Math.max(0, front.height / 2 - 40)
    else x += (side === 'left' ? 1 : -1) * Math.max(0, front.width / 2 - 40)
  }
  const surface = front.position[2] + front.thickness / 2
  const grip: HandleBlock = {
    position: [x, y, surface + clearance + thickness / 2],
    size: horizontal ? [length, thickness, thickness] : [thickness, length, thickness],
  }
  const mountDepth = clearance + thickness / 2
  const offsets = length >= thickness * 2 ? [-(length - thickness) / 2, (length - thickness) / 2] : [0]
  const mounts: HandleBlock[] = offsets.map((offset) => ({
    position: [x + (horizontal ? offset : 0), y + (horizontal ? 0 : offset), surface + mountDepth / 2],
    size: [thickness, thickness, mountDepth],
  }))
  return { grip, mounts }
}

/**
 * Build drawer boards with a 12.5 mm runner allowance on each side.
 * Structural runner supports belong to the frame and are checked by runnerFaults.
 */
function drawerParts(f: FittingData): FittingParts {
  const front = frontBoard(f)
  const boxW = f.width - RUNNER_CLEARANCE * 2
  const backZ = -f.depth / 2 + DRAWER_REAR_CLEARANCE
  const frontZ = front.position[2] - front.thickness / 2
  const boxD = frontZ - backZ
  const boxZ = (frontZ + backZ) / 2
  const boxH = Math.max(40, f.height - FRONT_GAP * 2 - 20)
  const boxY = -f.height / 2 + boxH / 2
  const boards: Board[] = []
  if (boxW > 40 && boxD > 40) {
    for (const s of [-1, 1]) {
      boards.push({ role: 'side', width: boxD, height: boxH, thickness: BOX_BOARD,
        position: [s * (boxW / 2 - BOX_BOARD / 2), boxY, boxZ], quaternion: Q_SIDE })
    }
    for (const [s, role] of [[-1, 'back'], [1, 'inner-front']] as const) {
      boards.push({ role, width: boxW - BOX_BOARD * 2, height: boxH, thickness: BOX_BOARD,
        position: [0, boxY, boxZ + s * (boxD / 2 - BOX_BOARD / 2)], quaternion: Q_FLAT })
    }
    boards.push({ role: 'base', width: boxW - BOX_BOARD * 2, height: boxD - BOX_BOARD * 2, thickness: BOX_BOARD,
      position: [0, boxY - boxH / 2 + BOX_BOARD / 2, boxZ], quaternion: Q_LEVEL })
  }
  boards.push(front)
  return {
    boards,
    hinges: [],
    // it comes out far enough to reach the back of the box, less the bit a runner keeps
    travel: Math.max(0, f.depth - 30),
  }
}

/**
 * Approximate the door swing about its front hinge edge. This is a fixed-axis model,
 * not a simulation of the linkage in a concealed hinge.
 */
export function hingeAxis(f: FittingData): { origin: THREE.Vector3; axis: THREE.Vector3; sign: number } {
  const side: HingeSide = f.hinge ?? 'left'
  const front = frontBoard(f)
  const [x, y] = front.position
  const w = front.width / 2
  const h = front.height / 2
  const z = front.position[2] + front.thickness / 2
  switch (side) {
    case 'right':  return { origin: new THREE.Vector3(x + w, y, z), axis: new THREE.Vector3(0, 1, 0), sign: 1 }
    case 'top':    return { origin: new THREE.Vector3(x, y + h, z), axis: new THREE.Vector3(1, 0, 0), sign: -1 }
    case 'bottom': return { origin: new THREE.Vector3(x, y - h, z), axis: new THREE.Vector3(1, 0, 0), sign: 1 }
    default:       return { origin: new THREE.Vector3(x - w, y, z), axis: new THREE.Vector3(0, 1, 0), sign: -1 }
  }
}

function doorParts(f: FittingData): FittingParts {
  const type = f.hingeType ?? 'cup'
  const { origin: pivot, axis } = hingeAxis(f)
  // the hinges themselves are on the back of the leaf, where the cup is bored
  const origin = pivot.clone().setZ(pivot.z - FRONT_BOARD)
  const n = hingeCount(type, axis.y > 0.5 ? f.height : f.width)
  const span = axis.y > 0.5 ? f.height : f.width
  const hinges: Array<[number, number, number]> = []
  if (type === 'continuous') {
    hinges.push([origin.x, origin.y, origin.z])
  } else {
    // spread them along the hung edge, held in from each end
    const inset = Math.min(80, span / 4)
    for (let i = 0; i < n; i++) {
      const t = -span / 2 + inset + (i * (span - inset * 2)) / Math.max(1, n - 1)
      hinges.push(axis.y > 0.5 ? [origin.x, t, origin.z] : [t, origin.y, origin.z])
    }
  }
  return { boards: [frontBoard(f)], hinges, travel: swingOf(f) }
}

export function fittingParts(f: FittingData): FittingParts {
  return f.kind === 'drawer' ? drawerParts(f) : doorParts(f)
}

/** The transform the moving part takes at `open` (0…1), in the fitting's own frame */
export function openTransform(f: FittingData): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
  const t = Math.max(0, Math.min(1, f.open ?? 0))
  const parts = fittingParts(f)
  if (f.kind === 'drawer') {
    return { position: new THREE.Vector3(0, 0, parts.travel * t), quaternion: new THREE.Quaternion() }
  }
  const { origin, axis, sign } = hingeAxis(f)
  const angle = THREE.MathUtils.degToRad(parts.travel * t) * sign
  const q = new THREE.Quaternion().setFromAxisAngle(axis, angle)
  // turning about the hinge, not about the middle of the door
  const offset = origin.clone().sub(origin.clone().applyQuaternion(q))
  return { position: offset, quaternion: q }
}

/** World-space oriented bounds of the door leaf or drawer front at the specified opening. */
export function leafObb(f: FittingData, open: number): OBB | null {
  const parts = fittingParts(f)
  const leaf = parts.boards.find((b) => b.role === 'panel' || b.role === 'front')
  if (!leaf) return null
  return boardObb(f, leaf, openTransform({ ...f, open }))
}

/** one of a fitting's boards, carried wherever the fitting has moved it, in world space */
function boardObb(f: FittingData, b: Board, at: { position: THREE.Vector3; quaternion: THREE.Quaternion }): OBB {
  const world = new THREE.Quaternion(...f.quaternion).normalize()
  const centre = new THREE.Vector3(...b.position)
    .applyQuaternion(at.quaternion).add(at.position)
    .applyQuaternion(world).add(new THREE.Vector3(...f.position))
  const quat = world.clone().multiply(at.quaternion).multiply(new THREE.Quaternion(...b.quaternion))
  return makeOBB(centre, new THREE.Vector3(b.width / 2, b.height / 2, b.thickness / 2), quat)
}

/** Oriented bounding boxes for each fitting board at the requested open amount. */
export function fittingSolids(f: FittingData, open: number = f.open ?? 0): OBB[] {
  const at = openTransform({ ...f, open })
  return fittingParts(f).boards.map((b) => boardObb(f, b, at))
}

/** Sample door swings to find leaf intersections; shared edges without penetration are allowed. */
export function swingClashes(fittings: FittingData[]): Array<[string, string]> {
  const doors = fittings.filter((f) => f.kind === 'door')
  const out: Array<[string, string]> = []
  // At most 1 degree per sample. Cache the leaves once per door and reject separated swept
  // boxes before testing pairs. This covers one door moving while its neighbour stays at
  // 0, half-open or fully open, plus both moving together. It remains a sampled simulation,
  // not a continuous collision certificate for every independent pair of hinge angles.
  const samples = doors.map((door) => {
    const count = Math.max(24, Math.ceil(swingOf(door)))
    const leaves = Array.from({ length: count + 1 }, (_, i) => leafObb(door, i / count)!)
    const bounds = new THREE.Box3()
    for (const leaf of leaves) for (const point of obbCorners(leaf)) bounds.expandByPoint(point)
    return { leaves, count, bounds }
  })
  for (let i = 0; i < doors.length; i++) {
    for (let j = i + 1; j < doors.length; j++) {
      const a = samples[i], b = samples[j]
      if (!a.bounds.intersectsBox(b.bounds)) continue
      let hit = false
      const clashes = (u: OBB, v: OBB) => obbPenetration(u, v, 2) > 2
      const count = Math.max(a.count, b.count)
      for (let k = 0; k <= count && !hit; k++) {
        const ai = Math.round(k * a.count / count), bi = Math.round(k * b.count / count)
        hit = clashes(a.leaves[ai], b.leaves[bi])
        for (const fixed of [0, 0.5, 1]) {
          if (hit) break
          hit = clashes(a.leaves[ai], b.leaves[Math.round(fixed * b.count)])
            || clashes(a.leaves[Math.round(fixed * a.count)], b.leaves[bi])
        }
      }
      if (hit) out.push([doors[i].id, doors[j].id])
    }
  }
  return out
}

/**
 * Where the moving part of a fitting actually is, right now.
 *
 * A door that is open is not where its opening is — it is out in the room, turned about its
 * hinge. Picking it by the opening means clicking the hole it came out of, which is not where
 * anybody looks for it. A drawer is the same, translated rather than turned.
 */
export function fittingObb(f: FittingData): OBB {
  if (f.kind === 'door') {
    const leaf = leafObb(f, f.open ?? 0)
    if (leaf) return leaf
  }
  const at = openTransform(f)
  const world = new THREE.Quaternion(...f.quaternion).normalize()
  const centre = at.position.clone().applyQuaternion(world).add(new THREE.Vector3(...f.position))
  return makeOBB(centre, new THREE.Vector3(f.width / 2, f.height / 2, f.depth / 2), world.clone().multiply(at.quaternion))
}
