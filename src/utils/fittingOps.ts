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

/**
 * Which way the fitting faces.
 *
 * The answer is already in the selection. Picking out an opening means picking the members
 * that frame it, and those are the ones at the front — so the front is whichever side of the
 * whole frame they sit on. Guessing from the shape of the run instead ignored that, and put
 * every door in a kitchen facing the wall.
 */
function outwardAxis(chosen: ProfileData[], section: number): THREE.Vector3 {
  // The cabinet this opening is in, not the drawing it is in. Asked of the whole drawing,
  // "which way is depth" is answered by the room: eleven cabinets laid out along Z made every
  // drawer in the flat face along X, turned ninety degrees, with its width and its depth
  // swapped and its front buried in the upright beside it.
  const all = cabinetOf(chosen)
  const whole = new THREE.Box3()
  for (const p of all) whole.union(memberBox(p))
  const mine = new THREE.Box3()
  for (const p of chosen) mine.union(memberBox(p))
  if (whole.isEmpty() || mine.isEmpty()) return new THREE.Vector3(0, 0, 1)

  const centre = whole.getCenter(new THREE.Vector3())
  const at = mine.getCenter(new THREE.Vector3())
  const span = mine.getSize(new THREE.Vector3())
  const run = whole.getSize(new THREE.Vector3())
  const X = new THREE.Vector3(1, 0, 0)
  const Z = new THREE.Vector3(0, 0, 1)

  // For a coplanar selection, use its thinner horizontal axis as the front normal.
  const flat: Array<[THREE.Vector3, number, number]> = [[Z, span.z, at.z - centre.z], [X, span.x, at.x - centre.x]]
  flat.sort((p, q) => p[1] - q[1])
  const [axis, thickness, offset] = flat[0]
  if (thickness <= section * 3 && Math.abs(offset) > 1) {
    return axis.clone().multiplyScalar(Math.sign(offset))
  }

  // The selection spans the depth — four uprights round a drawer — so it says nothing about
  // which side is the front.
  //
  // If anything has already been hung on this cabinet, that settles it. A cabinet whose doors
  // open into the room and whose drawers pull out towards the wall is not a cabinet, and
  // where the carcase is as deep as it is wide there is nothing to count anyway: the tie went
  // to whichever axis the comparison happened to prefer.
  const near = new THREE.Box3().copy(mine).expandByScalar(Math.max(run.x, run.z))
  for (const f of useStore.getState().fittings) {
    if (!near.containsPoint(new THREE.Vector3(...f.position))) continue
    const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(...f.quaternion).normalize())
    facing.y = 0
    if (facing.lengthSq() < 0.5) continue
    facing.normalize()
    return Math.abs(facing.x) > Math.abs(facing.z)
      ? X.clone().multiplyScalar(Math.sign(facing.x))
      : Z.clone().multiplyScalar(Math.sign(facing.z))
  }

  // Nothing hung yet: a cabinet is open at the front and closed at the back, where the backs
  // and the shelf rails are, so the half with less metal in it is the front.
  const deep = run.z <= run.x ? Z : X
  const mid = centre.dot(deep)
  let front = 0, back = 0
  for (const p of all) {
    const box = memberBox(p)
    const size = box.getSize(new THREE.Vector3())
    const bulk = Math.max(size.x, size.y, size.z)
    if (box.getCenter(new THREE.Vector3()).dot(deep) >= mid) front += bulk
    else back += bulk
  }
  return deep.clone().multiplyScalar(front <= back ? 1 : -1)
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
  const carcase = carcaseAround(chosen)
  const mine = new THREE.Box3()
  for (const p of chosen) mine.union(memberBox(p))
  const away = mine.getCenter(new THREE.Vector3()).sub(carcase.getCenter(new THREE.Vector3()))
  const along = away.dot(out)
  // dead centre of its own cabinet says nothing; anything else settles it
  return Math.abs(along) < 1 || along > 0 ? out : out.clone().negate()
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
  const out = openingOutward(outwardAxis(chosen, section), chosen)
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
    const run = carcaseAround(chosen).getSize(new THREE.Vector3())
    deep = Math.max(MIN_OPENING, Math.abs(out.z) > 0.5 ? run.z : run.x)
    // and it hangs on the face nearest the front, not in the middle of the cabinet
    const front = Math.abs(out.z) > 0.5 ? centre.z : centre.x
    void front
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
