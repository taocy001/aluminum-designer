import * as THREE from 'three'
import { useStore, type PanelData, type PanelMaterial, type ProfileData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { memberBox } from './dragSnap'
import { nextId } from './profileFactory'
import { translations } from './translations'
import { noteNext } from './opLog'
import { connectedTo } from './editOps'
import { computeAllTrims, trimmedBox } from './jointUtils'

/** Board thicknesses that are actually stocked, so a cut list can be ordered as written */
export const PANEL_THICKNESSES = [3, 5, 8, 10, 12, 15, 18, 25] as const
export const PANEL_MATERIALS: PanelMaterial[] = ['mdf', 'ply', 'acrylic', 'alu']
const DEFAULT_THICKNESS = 18
/** a board smaller than this is a mistake, not a part */
const MIN_SIDE = 20

export function materialLabel(m: PanelMaterial, language: 'zh' | 'en'): string {
  const zh: Record<PanelMaterial, string> = { mdf: '密度板', ply: '多层板', acrylic: '亚克力', alu: '铝板' }
  const en: Record<PanelMaterial, string> = { mdf: 'MDF', ply: 'Plywood', acrylic: 'Acrylic', alu: 'Aluminium' }
  return language === 'zh' ? zh[m] : en[m]
}

/** World-space corners of a board, in its own order: (-w,-h) (w,-h) (w,h) (-w,h) */
export function panelCorners(panel: PanelData): THREE.Vector3[] {
  const q = new THREE.Quaternion(...panel.quaternion).normalize()
  const centre = new THREE.Vector3(...panel.position)
  const x = new THREE.Vector3(1, 0, 0).applyQuaternion(q).multiplyScalar(panel.width / 2)
  const y = new THREE.Vector3(0, 1, 0).applyQuaternion(q).multiplyScalar(panel.height / 2)
  return [
    centre.clone().sub(x).sub(y),
    centre.clone().add(x).sub(y),
    centre.clone().add(x).add(y),
    centre.clone().sub(x).add(y),
  ]
}

/**
 * Fit a board to the selected members.
 *
 * The board fills the selection's bounding box on its two largest axes and takes the
 * smallest axis as its normal: four members around an opening give a door, two parallel
 * rails give a shelf spanning them. Both readings are the same rule, which is what makes
 * it predictable — and the size is a plain number afterwards, so it can be corrected.
 */
export type PanelFit = 'overlay' | 'inset'

type Axis = 0 | 1 | 2
const KEY = ['x', 'y', 'z'] as const

/** how far past the opening a member may sit and still be counted as bounding it (mm) */
const BOUND_REACH = 2

/**
 * Inner bounds along one axis: the gap between the members that bound the opening, rather
 * than the outside of them. An overlay door covers the frame, an inset panel sits between.
 *
 * A member bounds the opening along `axis` only if it is thin that way and it closes the
 * opening across the board's other direction (`cross`): it either reaches across most of the
 * opening, or it stands in one of its corners. A post in the middle of the front edge does
 * neither — it touches the front and nothing else — and taking it as a side cut the base of
 * a single-door cabinet into a board half the width, stopping at that post. Returns null
 * when the members do not close the opening on both sides.
 */
function innerBounds(boxes: THREE.Box3[], axis: Axis, cross: Axis, union: THREE.Box3): [number, number] | null {
  const key = KEY[axis], ck = KEY[cross]
  const mid = (union.min[key] + union.max[key]) / 2
  const span = union.max[key] - union.min[key]
  const crossSpan = union.max[ck] - union.min[ck]
  const atEnd = (b: THREE.Box3, k: 'x' | 'y' | 'z') =>
    b.min[k] <= union.min[k] + BOUND_REACH || b.max[k] >= union.max[k] - BOUND_REACH
  let low = -Infinity, high = Infinity
  for (const b of boxes) {
    const c = (b.min[key] + b.max[key]) / 2
    // only members that are thin along this axis bound the opening; one spanning it does not
    if (b.max[key] - b.min[key] > span * 0.5) continue
    const across = Math.min(b.max[ck], union.max[ck]) - Math.max(b.min[ck], union.min[ck])
    if (across < crossSpan * 0.5 && !(atEnd(b, key) && atEnd(b, ck))) continue
    if (c < mid) low = Math.max(low, b.max[key])
    else high = Math.min(high, b.min[key])
  }
  if (!isFinite(low) || !isFinite(high) || high - low < MIN_SIDE) return null
  return [low, high]
}

/** the members of this cabinet that reach across the opening, and so decide its size */
function openingBounders(chosen: ProfileData[], opening: THREE.Box3): THREE.Box3[] {
  const profiles = useStore.getState().profiles
  const own = connectedTo(chosen.map((p) => p.id), profiles)
  const grown = opening.clone().expandByScalar(BOUND_REACH)
  const out: THREE.Box3[] = []
  for (const p of profiles) {
    if (!own.has(p.id)) continue
    const b = memberBox(p)
    if (b.intersectsBox(grown)) out.push(b)
  }
  return out.length > 0 ? out : chosen.map((p) => memberBox(p))
}

export function panelFromSelection(
  material: PanelMaterial = 'mdf', thickness = DEFAULT_THICKNESS, fit: PanelFit = 'overlay',
): PanelData | null {
  const { profiles, selectedIds } = useStore.getState()
  const ids = new Set(selectedIds)
  const chosen: ProfileData[] = profiles.filter((p) => ids.has(p.id))
  const t = translations[useToolStore.getState().language]
  if (chosen.length < 2) { useToolStore.getState().showToast(t.toastPanelNeedsTwo, 'info'); return null }

  const boxes = chosen.map((p) => memberBox(p))
  const box = new THREE.Box3()
  for (const b of boxes) box.union(b)

  // A member that runs far past the others drives the board's size, which is almost never
  // what was meant — it is the whole-run rail caught by a stray Ctrl+click.
  const lengths = chosen.map((p) => p.length).sort((a, b) => a - b)
  const median = lengths[Math.floor(lengths.length / 2)]
  const longest = lengths[lengths.length - 1]
  if (lengths.length >= 2 && longest > median * 2) {
    useToolStore.getState().showToast(t.toastPanelSpanning(Math.round(longest)), 'error')
  }

  // the thinnest axis of what was picked is the one the board faces along
  const selSize = box.getSize(new THREE.Vector3())
  const normalAxis = ([0, 1, 2] as const).reduce((a, b) => (selSize.getComponent(b) < selSize.getComponent(a) ? b : a))
  const [pA, pB] = ([0, 1, 2] as const).filter((a) => a !== normalAxis)
  const lying = normalAxis === 1
  const own = connectedTo(chosen.map((p) => p.id), profiles)
  const ownProfiles = profiles.filter((p) => own.has(p.id))

  const inner = box.clone()
  if (fit === 'inset') {
    // An opening is not bounded only by the two members that were picked. Picking the two side
    // rails of a shelf says how wide it is and nothing about how deep: the rails run the full
    // depth, so measuring between them there gives their own length, and the board came out
    // 600 deep in a cabinet with 580 between its front and back posts — every shelf in the
    // drawing too big by exactly one post. What bounds the opening is the cabinet, so it is
    // asked as well — but only for a direction the selection leaves open: four rails round a
    // base already say where the base ends both ways, and a post that happens to stand on one
    // of them does not get to overrule that.
    let bounders: THREE.Box3[] | null = null
    for (const [a, c] of [[pA, pB], [pB, pA]] as const) {
      let r = innerBounds(boxes, a, c, box)
      if (!r) r = innerBounds(bounders ??= openingBounders(chosen, box), a, c, box)
      if (r) { inner.min.setComponent(a, r[0]); inner.max.setComponent(a, r[1]) }
    }
  } else {
    // An overlay board covers the metal as it is cut, not the centre lines it was drawn on:
    // a top whose rails run over the posts is the full 600, not the 580 between post centres.
    const trims = computeAllTrims(ownProfiles)
    inner.makeEmpty()
    for (const p of chosen) {
      const tr = trims.get(p.id)
      inner.union(tr ? trimmedBox(p, tr) : memberBox(p))
    }
  }

  // A board lying flat is carried: it rests on the top of the rails it was fitted to. Hung
  // at their mid-height it is held by nothing, and put on "the side away from the cabinet"
  // — the right answer for a door or a back — a base went under the floor.
  const top = inner.max.y
  if (lying) { inner.min.y = top; inner.max.y = top + thickness }

  // Lying on the rails, it must still get past whatever stands up through them. An overlay
  // board is the frame's outside size, and a post in each corner would go straight through
  // it; it is cut to the clear size between them instead.
  if (lying && fit === 'overlay') {
    const trims = computeAllTrims(ownProfiles)
    const probe = inner.clone().expandByScalar(-0.5)
    const inCorner = (b: THREE.Box3) => [pA, pB].every((a) => {
      const k = KEY[a]
      return b.min[k] <= inner.min[k] + BOUND_REACH || b.max[k] >= inner.max[k] - BOUND_REACH
    })
    const through = ownProfiles.map((p) => trimmedBox(p, trims.get(p.id)!)).filter((b) => b.intersectsBox(probe) && inCorner(b))
    for (const a of [pA, pB]) {
      const k = KEY[a]
      const mid = (inner.min[k] + inner.max[k]) / 2
      let lo = inner.min[k], hi = inner.max[k]
      for (const b of through) {
        if ((b.min[k] + b.max[k]) / 2 < mid) lo = Math.max(lo, b.max[k])
        else hi = Math.min(hi, b.min[k])
      }
      inner.min[k] = lo; inner.max[k] = hi
    }
  }

  const size = inner.getSize(new THREE.Vector3())
  const centre = inner.getCenter(new THREE.Vector3())

  const unit = (a: Axis) => new THREE.Vector3(a === 0 ? 1 : 0, a === 1 ? 1 : 0, a === 2 ? 1 : 0)
  let [uAxis, vAxis] = [pA, pB]
  // The basis has to be right-handed, or setFromRotationMatrix is reading a reflection and
  // the board comes out facing somewhere else entirely. Swapping the two in-plane axes fixes
  // the handedness, and swaps width for height with it.
  if (new THREE.Vector3().crossVectors(unit(uAxis), unit(vAxis)).dot(unit(normalAxis)) < 0) {
    [uAxis, vAxis] = [vAxis, uAxis]
  }
  const width = [size.x, size.y, size.z][uAxis]
  const height = [size.x, size.y, size.z][vAxis]
  if (width < MIN_SIDE || height < MIN_SIDE) { useToolStore.getState().showToast(t.toastPanelTooSmall, 'error'); return null }

  // send the board's local +Z onto the chosen normal, its +X and +Y onto the two in-plane axes
  const m = new THREE.Matrix4().makeBasis(unit(uAxis), unit(vAxis), unit(normalAxis))
  const q = new THREE.Quaternion().setFromRotationMatrix(m)

  // An overlay board standing up lies *on* the frame; centred on it, an 18 mm board is inside
  // a 20 mm post, which is not a place a board can be. Which side it lies on is the side away
  // from the cabinet — the same answer for a door on the front and a back panel on the back.
  const at = centre.clone()
  if (fit === 'overlay' && !lying) {
    const cab = new THREE.Box3()
    for (const p of ownProfiles) cab.union(memberBox(p))
    const k = KEY[normalAxis]
    const away = cab.isEmpty() || Math.abs(centre[k] - cab.getCenter(new THREE.Vector3())[k]) < 1e-6
      ? 1 : Math.sign(centre[k] - cab.getCenter(new THREE.Vector3())[k])
    at[k] += away * (size.getComponent(normalAxis) + thickness) / 2
  }

  return {
    id: nextId('b'),
    width: Math.round(width * 10) / 10,
    height: Math.round(height * 10) / 10,
    thickness,
    position: [at.x, at.y, at.z],
    quaternion: [q.x, q.y, q.z, q.w],
    material,
  }
}

/** Add a board fitted to the selection, and select it so it can be sized straight away */
export function addPanelFromSelection(
  material: PanelMaterial = 'mdf', thickness = DEFAULT_THICKNESS, fit: PanelFit = 'overlay',
): boolean {
  const panel = panelFromSelection(material, thickness, fit)
  if (!panel) return false
  useStore.getState().addPanels([panel], true)
  const t = translations[useToolStore.getState().language]
  useToolStore.getState().showToast(t.toastPanelAdded(Math.round(panel.width), Math.round(panel.height)), 'success')
  return true
}

/**
 * The same edit on every board that was selected, as one step in the history.
 *
 * Selecting six shelves and changing the thickness should change six shelves. Editing only
 * the first one is what "does not support multiple selection" means from the other side of
 * the screen — the selection was honoured everywhere except where it mattered.
 */
export function setPanelsSize(ids: string[], updates: Partial<Pick<PanelData, 'width' | 'height' | 'thickness'>>): boolean {
  const { panels, commitTransform } = useStore.getState()
  const t = translations[useToolStore.getState().language]
  const mine = panels.filter((p) => ids.includes(p.id) && !p.locked)
  if (mine.length === 0) return false
  const edits: Array<{ id: string; updates: Partial<PanelData> }> = []
  for (const panel of mine) {
    const next = { ...panel, ...updates }
    if (![next.width, next.height, next.thickness].every((v) => isFinite(v) && v > 0)) continue
    if (next.width < MIN_SIDE || next.height < MIN_SIDE) continue
    edits.push({ id: panel.id, updates: {
      width: Math.round(next.width * 10) / 10,
      height: Math.round(next.height * 10) / 10,
      thickness: Math.round(next.thickness * 10) / 10,
    } })
  }
  if (edits.length === 0) { useToolStore.getState().showToast(t.toastPanelTooSmall, 'error'); return false }
  noteNext(edits.length > 1 ? `resize ${edits.length} boards` : 'resize board')
  commitTransform({ panels: edits })
  return true
}

/** ...and the same for what they are made of */
export function setPanelsMaterial(ids: string[], material: PanelMaterial): boolean {
  const { panels, commitTransform } = useStore.getState()
  const mine = panels.filter((p) => ids.includes(p.id) && !p.locked)
  if (mine.length === 0) return false
  noteNext(mine.length > 1 ? `material of ${mine.length} boards` : 'board material')
  commitTransform({ panels: mine.map((p) => ({ id: p.id, updates: { material } })) })
  return true
}

export function setPanelSize(id: string, updates: Partial<Pick<PanelData, 'width' | 'height' | 'thickness'>>): boolean {
  const panel = useStore.getState().panels.find((p) => p.id === id)
  if (!panel) return false
  const t = translations[useToolStore.getState().language]
  if (panel.locked) { useToolStore.getState().showToast(t.toastLocked, 'error'); return false }
  const next = { ...panel, ...updates }
  if (![next.width, next.height, next.thickness].every((v) => isFinite(v) && v > 0)) return false
  if (next.width < MIN_SIDE || next.height < MIN_SIDE) { useToolStore.getState().showToast(t.toastPanelTooSmall, 'error'); return false }
  useStore.getState().commitPanelEdit(id, {
    width: Math.round(next.width * 10) / 10,
    height: Math.round(next.height * 10) / 10,
    thickness: Math.round(next.thickness * 10) / 10,
  })
  return true
}

export function setPanelMaterial(id: string, material: PanelMaterial): boolean {
  const panel = useStore.getState().panels.find((p) => p.id === id)
  if (!panel || panel.locked) return false
  useStore.getState().commitPanelEdit(id, { material })
  return true
}
