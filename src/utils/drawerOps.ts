import * as THREE from 'three'
import { useStore, type PanelData, type ProfileData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { memberBox } from './dragSnap'
import { buildProfile, nextId } from './profileFactory'
import { specDims } from './specUtils'
import { translations } from './translations'

/**
 * A drawer is not a board across an opening.
 *
 * It is a box that slides, and the slide is what sets every dimension. A side-mount runner
 * takes 12.5 mm between the drawer side and the cabinet side, so the box is 25 mm narrower
 * than the opening. The runner has to be screwed to something, so each side needs a rail at
 * the right height. The front overlays the opening and needs a gap around it or two drawers
 * cannot pass each other.
 *
 * Model it as: two runner rails, a box (four boards), and a front.
 */

/** side clearance each side of the box, which is what a side-mount runner occupies (mm) */
export const RUNNER_CLEARANCE = 12.5
/** gap around a drawer front so neighbouring fronts do not rub (mm) */
export const FRONT_GAP = 3
/** board thickness the box is made from (mm) */
const BOX_BOARD = 15
/** how far the box sits below the runner centreline (mm) */
const BOX_DROP = 0

export interface DrawerSpec {
  /** the opening, in world coordinates */
  min: THREE.Vector3
  max: THREE.Vector3
  /** which way the drawer pulls out */
  outward: THREE.Vector3
  /** runner height above the opening floor */
  runnerY: number
  /** how tall the front is */
  frontHeight: number
  /** profile used for the runner rails */
  spec: ProfileData['spec']
}

export interface DrawerParts {
  rails: ProfileData[]
  boards: PanelData[]
}

/**
 * Work out the parts of one drawer in an opening.
 *
 * `min`/`max` are the clear opening: the inside faces of the members around it. The runners
 * sit on that line, the box is inset by the runner clearance, and the front covers the
 * opening less a gap.
 */
export function drawerParts(spec: DrawerSpec): DrawerParts {
  const { min, max, outward, runnerY, frontHeight } = spec
  const depthAxis = new THREE.Vector3(Math.abs(outward.x), Math.abs(outward.y), Math.abs(outward.z))
  // the two horizontal axes of the opening: one is the pull direction, the other the width
  const widthAxis = new THREE.Vector3(depthAxis.z, 0, depthAxis.x)   // swap X and Z

  const along = (v: THREE.Vector3, axis: THREE.Vector3) => v.x * axis.x + v.y * axis.y + v.z * axis.z
  const w0 = along(min, widthAxis), w1 = along(max, widthAxis)
  const d0 = along(min, depthAxis), d1 = along(max, depthAxis)
  const width = w1 - w0
  const depth = d1 - d0

  const at = (wv: number, y: number, dv: number) =>
    widthAxis.clone().multiplyScalar(wv).add(depthAxis.clone().multiplyScalar(dv)).setY(y)

  // One runner rail on each side, running the depth at the drawer's height. Its centreline
  // sits half a section inside the opening, so the rail rests against the upright's inner
  // face rather than straddling it — which is where a bracket can reach both of them.
  const railHalf = specDims(spec.spec).hw
  const rails: ProfileData[] = []
  for (const [wv, inward] of [[w0, 1], [w1, -1]] as const) {
    const a = at(wv + inward * railHalf, runnerY, d0)
    const b = at(wv + inward * railHalf, runnerY, d1)
    const built = buildProfile(a, b, spec.spec)
    if (built) rails.push(built)
  }

  // the box: sides, back, front panel and base, inset by the runner clearance
  const boxW = width - specDims(spec.spec).w * 2 - RUNNER_CLEARANCE * 2
  const boxD = depth - 20
  const boxH = frontHeight - FRONT_GAP * 2 - 20
  const boxY = runnerY + boxH / 2 - BOX_DROP
  const centreW = (w0 + w1) / 2
  const centreD = (d0 + d1) / 2
  const boards: PanelData[] = []
  const board = (
    width_: number, height_: number, pos: THREE.Vector3, normal: THREE.Vector3,
  ): PanelData => {
    const zAxis = normal.clone().normalize()
    let xAxis = new THREE.Vector3(0, 1, 0).cross(zAxis)
    if (xAxis.lengthSq() < 1e-6) xAxis = new THREE.Vector3(1, 0, 0)
    xAxis.normalize()
    const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize()
    const m = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis)
    const q = new THREE.Quaternion().setFromRotationMatrix(m)
    return {
      id: nextId('b'),
      width: Math.round(width_ * 10) / 10,
      height: Math.round(height_ * 10) / 10,
      thickness: BOX_BOARD,
      position: [pos.x, pos.y, pos.z],
      quaternion: [q.x, q.y, q.z, q.w],
      material: 'ply',
    }
  }

  if (boxW > 40 && boxD > 40 && boxH > 40) {
    // two sides, facing across the width
    for (const s of [-1, 1]) {
      boards.push(board(boxD, boxH, at(centreW + s * boxW / 2, boxY, centreD), widthAxis))
    }
    // back and inner front, facing along the pull direction
    for (const s of [-1, 1]) {
      boards.push(board(boxW, boxH, at(centreW, boxY, centreD + s * boxD / 2), depthAxis))
    }
    // the base
    boards.push(board(boxW, boxD, at(centreW, runnerY + BOX_BOARD / 2, centreD), new THREE.Vector3(0, 1, 0)))
  }

  // the front, overlaying the opening less a gap, on the side the drawer pulls out
  const frontD = along(outward.x + outward.y + outward.z > 0 ? max : min, depthAxis)
  boards.push(board(
    width - FRONT_GAP * 2, frontHeight - FRONT_GAP * 2,
    at(centreW, runnerY + frontHeight / 2, frontD),
    depthAxis,
  ))

  return { rails, boards }
}

/**
 * Put a drawer in the opening the selected members bound.
 *
 * The selection has to say where the opening is: two uprights give its width, and the
 * members around them give its height and depth. Anything less is a guess.
 */
export function addDrawerFromSelection(frontHeight = 200, level = 0, count = 1): boolean {
  const store = useStore.getState()
  const t = translations[useToolStore.getState().language]
  const ids = new Set(store.selectedIds)
  const chosen = store.profiles.filter((p) => ids.has(p.id))
  if (chosen.length < 2) { useToolStore.getState().showToast(t.toastDrawerNeedsOpening, 'info'); return false }

  // The clear opening is what is left between the members, not the space they occupy: take
  // the outside of the selection and pull each face in by one section.
  const box = new THREE.Box3()
  for (const p of chosen) box.union(memberBox(p))
  let section = 0
  for (const p of chosen) { const { w, h } = specDims(p.spec); section = Math.max(section, w, h) }
  box.expandByVector(new THREE.Vector3(-section, -section, -section))

  const size = box.getSize(new THREE.Vector3())
  if (size.x < 60 || size.z < 60) { useToolStore.getState().showToast(t.toastDrawerTooSmall, 'error'); return false }

  // Which way it pulls out is not something one bay can answer — a 600 square bay is square.
  // The run it belongs to can: a kitchen is long one way and shallow the other, and drawers
  // face the room, which is the shallow way.
  const whole = new THREE.Box3()
  for (const p of store.profiles) whole.union(memberBox(p))
  const run = whole.getSize(new THREE.Vector3())
  // a tie goes to Z, which is the front of a cabinet drawn the conventional way round
  const outward = run.z <= run.x + 1 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(-1, 0, 0)
  const rails: ProfileData[] = []
  const boards: PanelData[] = []
  for (let i = 0; i < count; i++) {
    const parts = drawerParts({
      min: box.min, max: box.max, outward,
      // half a section above the opening floor, so the runner rail rests on the rail below
      // it rather than inside it
      runnerY: box.min.y + level + i * frontHeight + specDims('2020').hh,
      frontHeight,
      spec: '2020',
    })
    rails.push(...parts.rails)
    boards.push(...parts.boards)
  }

  store.addItems(rails, [], false)
  store.addPanels(boards, false)
  useToolStore.getState().showToast(t.toastDrawerAdded(count, rails.length + boards.length), 'success')
  return true
}
