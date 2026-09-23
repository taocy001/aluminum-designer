import * as THREE from 'three'
import type { FittingData, HingeSide, HingeType, Overlay } from '../store/useStore'
import { makeOBB, obbPenetration, type OBB } from './obb'

/**
 * What a drawer and a door are actually made of.
 *
 * One place, used by the renderer, the cut list and the tests, so a drawer that looks a
 * certain way is priced that way. Everything is in the fitting's own frame: X across the
 * opening, Y up, +Z out towards whoever opens it, origin at the centre of the clear opening.
 */

/** side clearance each side of a drawer box, which is what a side-mount runner occupies (mm) */
export const RUNNER_CLEARANCE = 12.5
/** gap all round a front, so neighbouring fronts do not rub (mm) */
export const FRONT_GAP = 3
/** the boards a drawer box is made from (mm) */
export const BOX_BOARD = 15
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

export interface RunnerRail {
  /** centre, in the fitting's own frame */
  position: [number, number, number]
  length: number
}

export interface FittingParts {
  boards: Board[]
  rails: RunnerRail[]
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

/** The front of a drawer or the leaf of a door: the same board, sized by how it sits */
function frontBoard(f: FittingData): Board {
  const grow = overlayMm(f.overlay) * 2 - FRONT_GAP * 2
  return {
    role: f.kind === 'door' ? 'panel' : 'front',
    width: Math.max(20, f.width + grow),
    height: Math.max(20, f.height + grow),
    thickness: FRONT_BOARD,
    position: [0, 0, f.depth / 2 + (f.frame ?? 0) + FRONT_BOARD / 2],
    quaternion: Q_FLAT,
  }
}

/**
 * A drawer: a box that slides, and the slide sets every dimension.
 *
 * A side-mount runner takes 12.5 mm between the box and the cabinet side, so the box is
 * 25 mm narrower than the opening. The runner has to be screwed to something, so each side
 * gets a rail at the right height.
 */
function drawerParts(f: FittingData): FittingParts {
  const boxW = f.width - RUNNER_CLEARANCE * 2
  const boxD = f.depth - 20
  const boxH = Math.max(40, f.height - FRONT_GAP * 2 - 20)
  const boxY = -f.height / 2 + boxH / 2
  const boards: Board[] = []
  if (boxW > 40 && boxD > 40) {
    for (const s of [-1, 1]) {
      boards.push({ role: 'side', width: boxD, height: boxH, thickness: BOX_BOARD,
        position: [s * (boxW / 2 - BOX_BOARD / 2), boxY, 0], quaternion: Q_SIDE })
    }
    for (const [s, role] of [[-1, 'back'], [1, 'inner-front']] as const) {
      boards.push({ role, width: boxW - BOX_BOARD * 2, height: boxH, thickness: BOX_BOARD,
        position: [0, boxY, s * (boxD / 2 - BOX_BOARD / 2)], quaternion: Q_FLAT })
    }
    boards.push({ role: 'base', width: boxW - BOX_BOARD * 2, height: boxD - BOX_BOARD * 2, thickness: BOX_BOARD,
      position: [0, boxY - boxH / 2 + BOX_BOARD / 2, 0], quaternion: Q_LEVEL })
  }
  boards.push(frontBoard(f))
  const railY = -f.height / 2 + 10
  return {
    boards,
    rails: [
      { position: [-f.width / 2 + 10, railY, 0], length: f.depth },
      { position: [f.width / 2 - 10, railY, 0], length: f.depth },
    ],
    hinges: [],
    // it comes out far enough to reach the back of the box, less the bit a runner keeps
    travel: Math.max(0, f.depth - 30),
  }
}

/** Which way a door swings: the axis it turns about and where that axis sits */
export function hingeAxis(f: FittingData): { origin: THREE.Vector3; axis: THREE.Vector3; sign: number } {
  const side: HingeSide = f.hinge ?? 'left'
  const w = f.width / 2 + overlayMm(f.overlay)
  const h = f.height / 2 + overlayMm(f.overlay)
  const z = f.depth / 2 + (f.frame ?? 0)
  switch (side) {
    case 'right':  return { origin: new THREE.Vector3(w, 0, z), axis: new THREE.Vector3(0, 1, 0), sign: 1 }
    case 'top':    return { origin: new THREE.Vector3(0, h, z), axis: new THREE.Vector3(1, 0, 0), sign: 1 }
    case 'bottom': return { origin: new THREE.Vector3(0, -h, z), axis: new THREE.Vector3(1, 0, 0), sign: -1 }
    default:       return { origin: new THREE.Vector3(-w, 0, z), axis: new THREE.Vector3(0, 1, 0), sign: -1 }
  }
}

function doorParts(f: FittingData): FittingParts {
  const type = f.hingeType ?? 'cup'
  const { origin, axis } = hingeAxis(f)
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
  return { boards: [frontBoard(f)], rails: [], hinges, travel: swingOf(f) }
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

/**
 * Where a fitting's leaf actually is at a given opening, as an oriented box.
 *
 * A door turning about its hinge sweeps a quarter cylinder, and the axis-aligned box round
 * that is nearly the whole bay plus its own width forward — so testing those boxes said every
 * pair of neighbouring doors collided, which is not true and is not useful. The leaf itself,
 * oriented, is what has to miss things.
 */
export function leafObb(f: FittingData, open: number): OBB | null {
  const parts = fittingParts(f)
  const leaf = parts.boards.find((b) => b.role === 'panel' || b.role === 'front')
  if (!leaf) return null
  const at = openTransform({ ...f, open })
  const world = new THREE.Quaternion(...f.quaternion).normalize()
  const centre = new THREE.Vector3(...leaf.position)
    .applyQuaternion(at.quaternion).add(at.position)
    .applyQuaternion(world).add(new THREE.Vector3(...f.position))
  const quat = world.clone().multiply(at.quaternion).multiply(new THREE.Quaternion(...leaf.quaternion))
  return makeOBB(centre, new THREE.Vector3(leaf.width / 2, leaf.height / 2, leaf.thickness / 2), quat)
}

/**
 * Doors that meet each other on the way open.
 *
 * Sampled through the swing rather than judged at full open, because two doors can pass and
 * still foul each other half way. A shared edge is not a clash; a shared thickness is.
 */
export function swingClashes(fittings: FittingData[]): Array<[string, string]> {
  const doors = fittings.filter((f) => f.kind === 'door')
  const out: Array<[string, string]> = []
  const steps = [0.35, 0.7, 1]
  for (let i = 0; i < doors.length; i++) {
    for (let j = i + 1; j < doors.length; j++) {
      let hit = false
      for (const t of steps) {
        const a = leafObb(doors[i], t)
        const b = leafObb(doors[j], t)
        if (!a || !b) continue
        if (obbPenetration(a, b, 2) > 2) { hit = true; break }
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
