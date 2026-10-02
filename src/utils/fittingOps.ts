import { noteNext } from './opLog'
import * as THREE from 'three'
import { useStore, type FittingData, type FittingKind, type HingeSide, type HingeType, type Overlay, type ProfileData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { memberBox } from './dragSnap'
import { nextId } from './profileFactory'
import { specDims } from './specUtils'
import { translations } from './translations'
import { connectedTo } from './editOps'
import { makeOBB, obbCorners } from './obb'
import { MIN_FITTING_OPENING as MIN_OPENING, validFitting } from './fittingValidation'

/** Derive an opening from the selected frame members, insetting axes with enough clearance. */

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
 * Is there a board standing across this opening, some way off along `axis`?
 *
 * Across means its thin side lies along the axis and its face covers the middle of the
 * opening; a shelf lying flat inside the bay is not across anything.
 */
function boardAcross(mine: THREE.Box3, reach: number, axis: THREE.Vector3, cabinet: THREE.Box3[]): boolean {
  const k: 'x' | 'z' = Math.abs(axis.x) > 0.5 ? 'x' : 'z'
  const across: 'x' | 'z' = k === 'x' ? 'z' : 'x'
  const sign = axis[k] > 0 ? 1 : -1
  const at = mine.getCenter(new THREE.Vector3())
  for (const b of useStore.getState().panels) {
    const q = new THREE.Quaternion(...b.quaternion).normalize()
    const box = new THREE.Box3()
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      box.expandByPoint(new THREE.Vector3(sx * b.width / 2, sy * b.height / 2, sz * b.thickness / 2).applyQuaternion(q).add(new THREE.Vector3(...b.position)))
    }
    const size = box.getSize(new THREE.Vector3())
    if (!cabinet.some((member) => box.intersectsBox(member))) continue
    if (size[k] > 40) continue                                   // not standing across the axis
    if (box.max[across] < at[across] || box.min[across] > at[across]) continue
    if (box.max.y < at.y || box.min.y > at.y) continue
    const away = (box.getCenter(new THREE.Vector3())[k] - at[k]) * sign
    if (away > 1 && away <= reach) return true
  }
  return false
}

/** Infer the fitting's outward direction from the selected opening and its connected frame. */
function outwardAxis(chosen: ProfileData[], section: number): { out: THREE.Vector3; settled: boolean } {
  // Restrict orientation inference to the connected frame.
  const all = cabinetOf(chosen)
  const whole = new THREE.Box3()
  const members = all.map((profile) => memberBox(profile))
  for (const box of members) whole.union(box)
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
  const boardSupports = members.map((box) => box.clone().expandByScalar(section))
  const facing = (axis: THREE.Vector3): THREE.Vector3 => {
    // A board covering one side of the opening identifies the back.
    const backAhead = boardAcross(mine, reach, axis, boardSupports)
    const backBehind = boardAcross(mine, reach, axis.clone().negate(), boardSupports)
    if (backAhead !== backBehind) return backAhead ? axis.clone().negate() : axis.clone()
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
  for (const f of useStore.getState().fittings) {
    // Test frame membership using the fixed opening bounds.
    const rotation = new THREE.Quaternion(...f.quaternion).normalize()
    const openingObb = makeOBB(new THREE.Vector3(...f.position),
      new THREE.Vector3(f.width, f.height, f.depth).multiplyScalar(0.5), rotation)
    const opening = new THREE.Box3().setFromPoints(obbCorners(openingObb)).expandByScalar(1)
    if (!members.some((box) => box.intersectsBox(opening))) continue
    const hung = new THREE.Vector3(0, 0, 1).applyQuaternion(rotation)
    const axis: 'x' | 'z' = Math.abs(hung.x) > Math.abs(hung.z) ? 'x' : 'z'
    const front = f.position[axis === 'x' ? 0 : 2] + hung[axis] * (f.depth / 2 + (f.frame ?? section))
    // Selecting the rear opening is an explicit choice. A front-facing door on the
    // same cabinet may confirm the front plane, but cannot reverse a different plane.
    if (front < mine.min[axis] - section || front > mine.max[axis] + section) continue
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

/** Frame ownership is determined by connected profiles. */
/** Return profiles connected to the selected members. */
function cabinetOf(chosen: ProfileData[]): ProfileData[] {
  const profiles = useStore.getState().profiles
  const own = connectedTo(chosen.map((p) => p.id), profiles)
  return profiles.filter((p) => own.has(p.id))
}

/** Measure depth behind the opening using its connected frame. */
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
  // Limit the query to the selected connected frame.
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
  if (useToolStore.getState().viewMode) return false
  if (req.kind === 'drawer') {
    const height = req.frontHeight ?? 200, count = req.count ?? 1
    if (!Number.isFinite(height) || height < MIN_OPENING || !Number.isInteger(count) || count < 1 || count > 8) {
      useToolStore.getState().showToast(t.toastInvalidFitting, 'error')
      return false
    }
  }
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

  // Constrain drawer and inset-door height to intersecting rails; overlay doors retain the initial opening height.
  const insetDoor = req.kind === 'door' && req.overlay === 'inset'
  if (req.kind === 'drawer' || insetDoor) {
    const mid = box.getCenter(new THREE.Vector3())
    for (const p of cabinetOf(chosen)) {
      if (ids.has(p.id) && !insetDoor) continue
      const m = memberBox(p)
      if (m.max.y - m.min.y > 100) continue                    // an upright, not a rail
      if (m.max.x <= box.min.x + 1 || m.min.x >= box.max.x - 1) continue
      if (m.max.z <= framing.min.z + 1 || m.min.z >= framing.max.z - 1) continue
      if ((m.min.y + m.max.y) / 2 < mid.y) box.min.y = Math.max(box.min.y, m.max.y)
      else box.max.y = Math.min(box.max.y, m.min.y)
    }
  }

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
    // Measure depth within this opening's connected frame.
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
    const frontHeight = req.frontHeight ?? 200
    const count = req.count ?? 1
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
    // One above another with nothing between: the edges they share are a gap between two
    // fronts, and only the outermost two lap over the frame.
    made.forEach((f, i) => {
      if (made.length > 1) f.stacked = { above: i < made.length - 1, below: i > 0 }
    })
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
  if (!made.every(validFitting)) {
    useToolStore.getState().showToast(t.toastInvalidFittingGeometry, 'error'); return false
  }
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
  if (!mine.every((f) => validFitting({ ...f, ...updates }))) {
    useToolStore.getState().showToast(translations[useToolStore.getState().language].toastInvalidFittingGeometry, 'error')
    return false
  }
  if (mine.every((f) => Object.entries(updates).every(([key, value]) =>
    JSON.stringify(f[key as keyof FittingData]) === JSON.stringify(value)))) return false
  noteNext(mine.length > 1 ? `edit ${mine.length} fittings` : 'edit fitting')
  commitTransform({ fittings: mine.map((f) => ({ id: f.id, updates })) })
  return true
}

/** A side-hung single door needs room for two openings of at least 60 mm. */
export function canSplitDoor(f: FittingData): boolean {
  return validFitting(f) && f.kind === 'door' && f.meeting === undefined
    && f.width >= MIN_OPENING * 2 && (f.hinge === undefined || f.hinge === 'left' || f.hinge === 'right')
}

/** Replace one opening with two half openings; keep its outside edges and front plane. */
export function splitDoor(f: FittingData, ids?: readonly [string, string]): [FittingData, FittingData] | null {
  if (!canSplitDoor(f)) return null
  const children = ids ?? [nextId('f'), nextId('f')]
  const q = new THREE.Quaternion(...f.quaternion).normalize()
  const origin = new THREE.Vector3(...f.position)
  const make = (side: 'left' | 'right', index: 0 | 1): FittingData => {
    const position = new THREE.Vector3(side === 'left' ? -f.width / 4 : f.width / 4, 0, 0)
      .applyQuaternion(q).add(origin)
    return {
      ...f, id: children[index], width: f.width / 2,
      position: [position.x, position.y, position.z], quaternion: [...f.quaternion],
      hinge: side, meeting: side === 'left' ? 'right' : 'left',
    }
  }
  return [make('left', 0), make('right', 1)]
}

/** Split the selected unlocked single doors as one undo step. Other selections stay put. */
export function splitSelectedDoors(): boolean {
  if (useToolStore.getState().viewMode) return false
  const store = useStore.getState()
  const selected = new Set(store.selectedIds)
  const replacements = new Map<string, [FittingData, FittingData]>()
  for (const f of store.fittings) {
    if (!selected.has(f.id) || f.locked) continue
    const pair = splitDoor(f)
    if (pair) replacements.set(f.id, pair)
  }
  if (!replacements.size) return false
  noteNext(`split ${replacements.size} door${replacements.size > 1 ? 's' : ''}`)
  store.commitDocument({ fittings: store.fittings.flatMap((f) => replacements.get(f.id) ?? [f]) },
    store.selectedIds.flatMap((id) => replacements.get(id)?.map((f) => f.id) ?? [id]))
  useToolStore.getState().showToast(translations[useToolStore.getState().language].toastDoorsSplit(replacements.size), 'success')
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
