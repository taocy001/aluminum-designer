import { noteNext } from './opLog'
import * as THREE from 'three'
import { useStore, type FittingData, type FittingKind, type HingeSide, type HingeType, type Overlay, type ProfileData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { memberBox } from './dragSnap'
import { nextId } from './profileFactory'
import { specDims } from './specUtils'
import { translations } from './translations'
import { connectedTo } from './editOps'

/** Derive an opening from the selected frame members, insetting axes with enough clearance. */

/** the smallest opening worth fitting anything to (mm) */
const MIN_OPENING = 60
/** how far past an opening still counts as the same cabinet, across and up (mm) */
const CARCASE_MARGIN = 120

export interface FittingRequest {
  kind: FittingKind
  /** drawer: how tall each front is. Ignored for a door, which fills the opening. */
  frontHeight?: number
  count?: number
  hinge?: HingeSide
  hingeType?: HingeType
  overlay?: Overlay
  /** how far a door opens, in degrees */
  swing?: number
}

/** Sum the lengths of members crossing the opening centre within the direction and reach. */
function metalAhead(all: ProfileData[], mine: THREE.Box3, reach: number, axis: THREE.Vector3): number {
  const k: 'x' | 'z' = Math.abs(axis.x) > 0.5 ? 'x' : 'z'
  const across: 'x' | 'z' = k === 'x' ? 'z' : 'x'
  const sign = axis[k] > 0 ? 1 : -1
  const at = mine.getCenter(new THREE.Vector3())
  let metal = 0
  for (const p of all) {
    const box = memberBox(p)
    // Count members crossing the opening centre and overlapping its height.
    if (box.max[across] < at[across] || box.min[across] > at[across]) continue
    if (box.max.y < mine.min.y - 1 || box.min.y > mine.max.y + 1) continue
    const away = (box.getCenter(new THREE.Vector3())[k] - at[k]) * sign
    if (away <= 1 || away > reach) continue
    metal += Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z)
  }
  return metal
}

/**
 * Which way the fitting faces.
 *
 * The answer is already in the selection. Picking out an opening means picking the members
 * that frame it, and those are the ones at the front — so the front is whichever side of the
 * whole frame they sit on. Guessing from the shape of the run instead ignored that, and put
 * every door in a kitchen facing the wall.
 */
function outwardAxis(chosen: ProfileData[], section: number): { out: THREE.Vector3; settled: boolean } {
  // The cabinet this opening is in, not the drawing it is in. Asked of the whole drawing,
  // "which way is depth" is answered by the room: eleven cabinets laid out along Z made every
  // drawer in the flat face along X, turned ninety degrees, with its width and its depth
  // swapped and its front buried in the upright beside it.
  const all = cabinetOf(chosen)
  const whole = new THREE.Box3()
  for (const p of all) whole.union(memberBox(p))
  const mine = new THREE.Box3()
  for (const p of chosen) mine.union(memberBox(p))
  if (whole.isEmpty() || mine.isEmpty()) return { out: new THREE.Vector3(0, 0, 1), settled: false }

  const centre = whole.getCenter(new THREE.Vector3())
  const at = mine.getCenter(new THREE.Vector3())
  const span = mine.getSize(new THREE.Vector3())
  const run = whole.getSize(new THREE.Vector3())
  const X = new THREE.Vector3(1, 0, 0)
  const Z = new THREE.Vector3(0, 0, 1)

  // For a coplanar selection, use its thinner horizontal axis as the front normal.
  /** Compare local obstructions on both sides of the opening to choose an outward direction. */
  const reach = Math.max(run.x, run.z)
  const facing = (axis: THREE.Vector3): THREE.Vector3 => {
    const ahead = metalAhead(all, mine, reach, axis)
    const behind = metalAhead(all, mine, reach, axis.clone().negate())
    return ahead <= behind ? axis.clone() : axis.clone().negate()
  }

  // Determine whether the selection defines a front plane.
  const flat: Array<[THREE.Vector3, number]> = [[Z, span.z], [X, span.x]]
  flat.sort((p, q) => p[1] - q[1])
  const [thin, thickness] = flat[0]
  const coplanar = thickness <= section * 3
  void centre

  /**
   * Reuse a fitting on the same frame and front plane. For coplanar selections, require
   * its orientation to match the selected plane's horizontal normal.
   */
  const room = new THREE.Box3().copy(mine).expandByScalar(Math.max(run.x, run.z))
  for (const f of useStore.getState().fittings) {
    if (!room.containsPoint(new THREE.Vector3(...f.position))) continue
    const hung = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(...f.quaternion).normalize())
    if (coplanar) {
      const along = hung.dot(thin)
      if (Math.abs(along) < 0.9) continue
      return { out: thin.clone().multiplyScalar(Math.sign(along)), settled: true }
    }
    hung.y = 0
    if (hung.lengthSq() < 0.5) continue
    hung.normalize()
    return {
      out: Math.abs(hung.x) > Math.abs(hung.z)
        ? X.clone().multiplyScalar(Math.sign(hung.x))
        : Z.clone().multiplyScalar(Math.sign(hung.z)),
      settled: true,
    }
  }

  return { out: facing(coplanar ? thin : (run.z <= run.x ? Z : X)), settled: false }
}

/**
 * The cabinet this opening belongs to, as a box.
 *
 * Not the whole drawing: a run of base units and the wall units above them are different
 * cabinets with different depths, and asking the whole frame how deep "the cabinet" is gets
 * a door hinged a foot in front of the one it belongs to.
 */
/**
 * The members of the cabinet this selection belongs to.
 *
 * Bolted together is what makes two cabinets one, so that is what is asked — but a selection
 * with nothing yet bolted to it is not a cabinet of its own, it is a frame half drawn. Then
 * the only thing there is to ask is the drawing.
 */
function cabinetOf(chosen: ProfileData[]): ProfileData[] {
  const profiles = useStore.getState().profiles
  const own = connectedTo(chosen.map((p) => p.id), profiles)
  if (own.size <= chosen.length) return profiles
  return profiles.filter((p) => own.has(p.id))
}

/**
 * How far the metal goes back behind an opening.
 *
 * Only what is directly behind it counts: members that overlap the opening across its width
 * and its height. A box query over an L-shaped run answers with the whole L — the long run's
 * doors came out as deep as the return leg is long — because the return leg is inside the
 * same bounding box while being nowhere behind the opening.
 */
function depthBehind(chosen: ProfileData[], out: THREE.Vector3): number {
  const mine = new THREE.Box3()
  for (const p of chosen) mine.union(memberBox(p))
  const k: 'x' | 'z' = Math.abs(out.z) > 0.5 ? 'z' : 'x'
  const across: 'x' | 'z' = k === 'z' ? 'x' : 'z'
  const sign = out[k] > 0 ? 1 : -1
  const face = sign > 0 ? mine.max[k] : mine.min[k]

  const middle = mine.getCenter(new THREE.Vector3())
  let back = 0
  for (const p of cabinetOf(chosen)) {
    const box = memberBox(p)
    // Restrict the depth measurement to members crossing the opening centre.
    if (box.max[across] < middle[across] || box.min[across] > middle[across]) continue
    if (box.max.y < mine.min.y - 1 || box.min.y > mine.max.y + 1) continue
    const far = sign > 0 ? face - box.min[k] : box.max[k] - face
    back = Math.max(back, far)
  }
  return back
}

function carcaseAround(chosen: ProfileData[]): THREE.Box3 {
  const mine = new THREE.Box3()
  for (const p of chosen) mine.union(memberBox(p))
  // Expand the local query across X/Y, with an unrestricted Z range.
  const near = new THREE.Box3().copy(mine).expandByVector(new THREE.Vector3(CARCASE_MARGIN, CARCASE_MARGIN, 1e5))
  // Reaching without limit into the depth is right for one cabinet and disastrous for a
  // room: it found every cabinet standing behind this one and gave a kitchen door a depth of
  // eleven metres. What bounds it is not a distance, it is that a separate cabinet is not
  // bolted to this one — so only the sub-assembly the opening belongs to is considered.
  const box = new THREE.Box3()
  for (const p of cabinetOf(chosen)) {
    const b = memberBox(p)
    if (near.containsPoint(b.getCenter(new THREE.Vector3()))) box.union(b)
  }
  return box.isEmpty() ? mine : box
}

/** Reverse an inferred direction when more frame members lie ahead than behind the opening. */
function openingOutward(out: THREE.Vector3, chosen: ProfileData[]): THREE.Vector3 {
  // Compare local obstructions in the inferred direction and its opposite.
  const all = cabinetOf(chosen)
  const mine = new THREE.Box3()
  for (const p of chosen) mine.union(memberBox(p))
  const carcase = carcaseAround(chosen).getSize(new THREE.Vector3())
  const reach = Math.max(carcase.x, carcase.z)
  const ahead = metalAhead(all, mine, reach, out)
  const behind = metalAhead(all, mine, reach, out.clone().negate())
  return ahead > behind ? out.clone().negate() : out
}

/** Rotation that sends local +Z onto `out`, keeping Y up */
function facing(out: THREE.Vector3): THREE.Quaternion {
  const z = out.clone().normalize()
  const up = new THREE.Vector3(0, 1, 0)
  const x = new THREE.Vector3().crossVectors(up, z)
  if (x.lengthSq() < 1e-6) x.set(1, 0, 0)
  x.normalize()
  const y = new THREE.Vector3().crossVectors(z, x).normalize()
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z))
}

export function addFittingFromSelection(req: FittingRequest): boolean {
  const store = useStore.getState()
  const t = translations[useToolStore.getState().language]
  const ids = new Set(store.selectedIds)
  const chosen = store.profiles.filter((p) => ids.has(p.id))
  if (chosen.length < 2) { useToolStore.getState().showToast(t.toastDrawerNeedsOpening, 'info'); return false }

  const box = new THREE.Box3()
  for (const p of chosen) box.union(memberBox(p))
  let section = 0
  for (const p of chosen) { const { w, h } = specDims(p.spec); section = Math.max(section, w, h) }
  // Inset only axes wide enough to retain a positive clear opening.
  const span = box.getSize(new THREE.Vector3())
  const framing = box.clone()   // the members themselves, before the opening is taken in
  box.expandByVector(new THREE.Vector3(
    span.x > section * 2.5 ? -section : 0,
    span.y > section * 2.5 ? -section : 0,
    span.z > section * 2.5 ? -section : 0,
  ))

  const size = box.getSize(new THREE.Vector3())
  const aim = outwardAxis(chosen, section)
  // Preserve orientation inferred from an existing fitting.
  const out = aim.settled ? aim.out : openingOutward(aim.out, chosen)
  const quaternion = facing(out)
  const centre = box.getCenter(new THREE.Vector3())
  // across the opening and into it, in the fitting's own frame
  const across = Math.abs(out.z) > 0.5 ? size.x : size.z
  let deep = Math.abs(out.z) > 0.5 ? size.z : size.x

  // Infer depth from members behind a coplanar door opening.
  if (req.kind === 'door' && deep < MIN_OPENING) {
    // its own cabinet's depth, not the whole drawing's: wall units are shallower than the
    // base units under them, and a door hung on the deeper figure swings about an axis a
    // foot in front of the cabinet it belongs to
    // How far back the cabinet goes *behind this opening*, not across the whole carcase.
    // An L-shaped run's bounding box is as deep as the return leg is long, and a door on the
    // long run came out nearly two metres deep, hinged out in the middle of the room.
    deep = Math.max(MIN_OPENING, depthBehind(chosen, out))
  }
  if (across < MIN_OPENING || size.y < MIN_OPENING || (req.kind === 'drawer' && deep < MIN_OPENING)) {
    useToolStore.getState().showToast(t.toastDrawerTooSmall, 'error'); return false
  }

  // Place the fitting front plane at the inner frame face; frame stores the distance to the outer face.
  const axis: 'x' | 'z' = Math.abs(out.z) > 0.5 ? 'z' : 'x'
  const sign = out[axis] > 0 ? 1 : -1
  const outer = sign > 0 ? framing.max[axis] : framing.min[axis]
  const frame = Math.abs(framing.max[axis] - framing.min[axis]) >= section * 2
    ? section                                  // the selection spans the cabinet: one upright
    : Math.abs(framing.max[axis] - framing.min[axis])
  const origin = outer - sign * (frame + deep / 2)

  const made: FittingData[] = []
  if (req.kind === 'drawer') {
    const frontHeight = Math.max(60, req.frontHeight ?? 200)
    const count = Math.max(1, Math.min(8, Math.floor(req.count ?? 1)))
    for (let i = 0; i < count; i++) {
      const y = box.min.y + frontHeight * (i + 0.5)
      if (y + frontHeight / 2 > box.max.y + 1) break
      made.push({
        id: nextId('f'), kind: 'drawer',
        position: [axis === 'x' ? origin : centre.x, y, axis === 'z' ? origin : centre.z],
        quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
        width: across, height: frontHeight, depth: deep, frame,
        material: 'ply', open: 0,
      })
    }
  } else {
    made.push({
      id: nextId('f'), kind: 'door',
      position: [axis === 'x' ? origin : centre.x, centre.y, axis === 'z' ? origin : centre.z],
      quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
      width: across, height: size.y, depth: deep, frame,
      material: 'mdf', open: 0,
      hinge: req.hinge ?? 'left',
      hingeType: req.hingeType ?? 'cup',
      overlay: req.overlay ?? 'full',
      swing: req.swing,
    })
  }

  if (made.length === 0) { useToolStore.getState().showToast(t.toastDrawerTooSmall, 'error'); return false }
  noteNext(req.kind === 'drawer' ? `fit ${made.length} drawer${made.length > 1 ? 's' : ''}` : 'hang a door')
  store.addFittings(made, false)
  useToolStore.getState().showToast(
    req.kind === 'drawer' ? t.toastDrawerAdded(made.length, made.length) : t.toastDoorAdded(made.length), 'success')
  return true
}

/**
 * The same edit on every door or drawer that was selected, as one step in the history.
 *
 * Six doors selected and one hinge angle typed should set six hinge angles.
 */
export function updateFittings(ids: string[], updates: Partial<FittingData>): boolean {
  const { fittings, commitTransform } = useStore.getState()
  const mine = fittings.filter((f) => ids.includes(f.id) && !f.locked)
  if (mine.length === 0) return false
  noteNext(mine.length > 1 ? `edit ${mine.length} fittings` : 'edit fitting')
  commitTransform({ fittings: mine.map((f) => ({ id: f.id, updates })) })
  return true
}

/** Open or shut every selected one together. Looking, not building: no history entry. */
export function setFittingsOpen(ids: string[], open: number): void {
  const v = Math.max(0, Math.min(1, open))
  const { fittings, updateParts } = useStore.getState()
  const mine = fittings.filter((f) => ids.includes(f.id))
  if (mine.length === 0) return
  updateParts({ fittings: mine.map((f) => ({ id: f.id, updates: { open: v } })) })
}

/** Swing or slide one fitting. Looking, not building, so it leaves no history entry. */
export function setFittingOpen(id: string, open: number): void {
  useStore.getState().updateFitting(id, { open: Math.max(0, Math.min(1, open)) }, false)
}

/** Everything shut again */
export function closeAllFittings(): void {
  for (const f of useStore.getState().fittings) {
    if (f.open) useStore.getState().updateFitting(f.id, { open: 0 }, false)
  }
}
