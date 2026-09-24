import { noteNext } from './opLog'
import * as THREE from 'three'
import { useStore, type FittingData, type FittingKind, type HingeSide, type HingeType, type Overlay, type ProfileData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { memberBox } from './dragSnap'
import { nextId } from './profileFactory'
import { specDims } from './specUtils'
import { translations } from './translations'
import { connectedTo } from './editOps'

/**
 * Fit a drawer or a door to the opening the selected members bound.
 *
 * The selection has to say where the opening is — two uprights give its width, and the
 * members around them its height and depth. The clear opening is what is left between the
 * members, not the space they occupy, so each face comes in by one section.
 */

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
 * How much metal stands between an opening and the world, in one direction.
 *
 * Only what is actually across from the opening counts: members that overlap it across its
 * width and its height. A cabinet round the corner is not in the way of this one, and the
 * bounding box of an L-shaped run cannot tell the difference.
 */
function metalAhead(all: ProfileData[], mine: THREE.Box3, reach: number, axis: THREE.Vector3): number {
  const k: 'x' | 'z' = Math.abs(axis.x) > 0.5 ? 'x' : 'z'
  const across: 'x' | 'z' = k === 'x' ? 'z' : 'x'
  const sign = axis[k] > 0 ? 1 : -1
  const at = mine.getCenter(new THREE.Vector3())
  let metal = 0
  for (const p of all) {
    const box = memberBox(p)
    // Across from the opening means across from its middle, not touching one of its edges.
    // At an inside corner the long run's uprights clip the edge of the return leg's opening
    // by a single section, and counting them made the return leg's doors face the long run.
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

  // The members that frame a door's opening are coplanar — two uprights on the front line —
  // and the normal of that plane is the way the door faces. So the front axis is whichever
  // horizontal axis the selection is flat on, and the side is which side of the frame that
  // plane sits on. Reading it as "far from the middle" instead put the doors at the end of a
  // long run facing along the run.
  /**
   * Which way is out, decided where the opening is rather than where the cabinet's middle is.
   *
   * "Which side of the frame does this sit on" is fine for a box and wrong for an L: the
   * return leg drags the middle round behind the long run, and every door on the long run
   * comes out facing the wall. A cabinet is open at the front, and that is a local fact —
   * so look along the axis from the opening itself, at the members that are actually across
   * from it, and take the side with less in the way.
   */
  const reach = Math.max(run.x, run.z)
  const facing = (axis: THREE.Vector3): THREE.Vector3 => {
    const ahead = metalAhead(all, mine, reach, axis)
    const behind = metalAhead(all, mine, reach, axis.clone().negate())
    return ahead <= behind ? axis.clone() : axis.clone().negate()
  }

  // Which axis is settled by the shape of the selection, and only the direction along it is
  // open to argument. Two uprights that frame a door are coplanar, and the normal of that
  // plane is the one direction the door can face — a return leg's doors face along X however
  // the long run's doors face, because its uprights are lined up along Z.
  const flat: Array<[THREE.Vector3, number]> = [[Z, span.z], [X, span.x]]
  flat.sort((p, q) => p[1] - q[1])
  const [thin, thickness] = flat[0]
  const coplanar = thickness <= section * 3
  void centre

  /**
   * Something already hung on this carcase is evidence rather than a guess, and nothing
   * below may overturn it — an inside corner has cabinet on both sides, so there is nothing
   * local to weigh up there.
   *
   * How much of it counts depends on what the selection has already settled. Two uprights
   * framing a door are coplanar and the normal of that plane is the one direction the door
   * can face, so a door already hung can only confirm or reverse it — one facing a different
   * axis belongs to the other leg of an L and says nothing about this opening. Four uprights
   * round a drawer say nothing at all about the axis, and then a fitting already in the
   * carcase is the only thing that does.
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
    // ...and behind it means behind its middle, for the same reason
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
  // A small margin across and up, and no limit into the depth — that is the one direction
  // the cabinet extends in that the opening does not describe. Reaching as far up as the
  // opening is tall swallowed the top rails of the run below and made a wall unit as deep
  // as the base units under it.
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

/**
 * A door opens away from the cabinet it is on, and there is no arrangement where it does not.
 *
 * The front is worked out from the selection and from the frame, and both can be read the
 * wrong way round — a run of wall units sitting above a deeper run of base units reads as
 * being behind the middle of the drawing when it is in front of its own carcase. So the
 * answer is checked against the one thing that cannot be ambiguous: which side of its own
 * cabinet the opening is on.
 */
function openingOutward(out: THREE.Vector3, chosen: ProfileData[]): THREE.Vector3 {
  // This is the second look — "whatever else was decided, a door opens away from its own
  // cabinet" — and it used to take the cabinet's bounding-box middle as the answer. On an
  // L-shaped run the return leg drags that middle round behind the long run, so this turned
  // the right answer into the wrong one: the corner door faced the wall and came out as deep
  // as the return leg is long. So it asks what the first look asks — which side has the
  // cabinet on it — and only overturns a direction that is plainly blocked.
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
  // The clear opening is what is left between the members, so each face comes in by one
  // section — but only on the axes that have room. Two uprights on the same line are one
  // section thick, and shrinking that axis turns the box inside out; THREE then calls it
  // empty and hands back zeroes for both the centre and the size, which reads as "no
  // opening here" for an opening that is plainly there.
  const span = box.getSize(new THREE.Vector3())
  const framing = box.clone()   // the members themselves, before the opening is taken in
  box.expandByVector(new THREE.Vector3(
    span.x > section * 2.5 ? -section : 0,
    span.y > section * 2.5 ? -section : 0,
    span.z > section * 2.5 ? -section : 0,
  ))

  const size = box.getSize(new THREE.Vector3())
  const aim = outwardAxis(chosen, section)
  // the second look is a check on a guess, so it has nothing to say about an answer that was
  // not a guess
  const out = aim.settled ? aim.out : openingOutward(aim.out, chosen)
  const quaternion = facing(out)
  const centre = box.getCenter(new THREE.Vector3())
  // across the opening and into it, in the fitting's own frame
  const across = Math.abs(out.z) > 0.5 ? size.x : size.z
  let deep = Math.abs(out.z) > 0.5 ? size.z : size.x

  // A drawer has to go somewhere, so it needs a real depth. A door only hangs on the front,
  // and two uprights on the same line — the usual way to say "this opening" — give no depth
  // at all; the cabinet behind them does.
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

  // Where the front is. A door's leaf and a drawer's front both sit at +depth/2 in the
  // fitting's own frame, so that plane has to land on the outside face of the uprights the
  // opening is framed by — putting it on their centreline instead sank every door half a
  // section into the post it hangs on, and every drawer front the same.
  // The box goes behind the uprights and the front lies on them, so the fitting's own front
  // plane is their inner face and `frame` says how much is in front of it. Measuring to the
  // centreline instead sank every door half a section into the post it hangs on.
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
