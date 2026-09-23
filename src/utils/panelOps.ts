import * as THREE from 'three'
import { useStore, type PanelData, type PanelMaterial, type ProfileData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { memberBox } from './dragSnap'
import { nextId } from './profileFactory'
import { translations } from './translations'
import { connectedTo } from './editOps'

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

/**
 * Inner bounds along one axis: the gap between the members that bound the opening, rather
 * than the outside of them. An overlay door covers the frame, an inset panel sits between.
 */
function innerBounds(boxes: THREE.Box3[], axis: 0 | 1 | 2, union: THREE.Box3): [number, number] {
  const key = (['x', 'y', 'z'] as const)[axis]
  const mid = (union.min[key] + union.max[key]) / 2
  const span = union.max[key] - union.min[key]
  let low = -Infinity, high = Infinity
  for (const b of boxes) {
    const c = (b.min[key] + b.max[key]) / 2
    // only members that are thin along this axis bound the opening; one spanning it does not
    if (b.max[key] - b.min[key] > span * 0.5) continue
    if (c < mid) low = Math.max(low, b.max[key])
    else high = Math.min(high, b.min[key])
  }
  if (!isFinite(low) || !isFinite(high) || high - low < MIN_SIDE) return [union.min[key], union.max[key]]
  return [low, high]
}

/** how far past the opening a member may sit and still be counted as bounding it (mm) */
const BOUND_REACH = 2

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

  // An opening is not bounded only by the two members that were picked. Picking the two side
  // rails of a shelf says how wide it is and nothing about how deep: the rails run the full
  // depth, so measuring between them there gives their own length, and the board came out
  // 600 deep in a cabinet with 580 between its front and back posts — every shelf in the
  // drawing too big by exactly one post. What bounds the opening is the cabinet, so for an
  // inset board the cabinet's own members are asked as well, and only those that actually
  // reach across the opening.
  const bounders = fit === 'inset' ? openingBounders(chosen, box) : boxes
  const inner = fit === 'inset'
    ? new THREE.Box3(
      new THREE.Vector3(...([0, 1, 2] as const).map((a) => innerBounds(bounders, a, box)[0]) as [number, number, number]),
      new THREE.Vector3(...([0, 1, 2] as const).map((a) => innerBounds(bounders, a, box)[1]) as [number, number, number]),
    )
    : box
  const size = inner.getSize(new THREE.Vector3())
  const centre = inner.getCenter(new THREE.Vector3())

  // the thinnest axis is the one the board faces along
  const dims: Array<[0 | 1 | 2, number]> = [[0, size.x], [1, size.y], [2, size.z]]
  dims.sort((a, b) => a[1] - b[1])
  const normalAxis = dims[0][0]
  const unit = (a: 0 | 1 | 2) => new THREE.Vector3(a === 0 ? 1 : 0, a === 1 ? 1 : 0, a === 2 ? 1 : 0)
  let [uAxis, vAxis] = ([0, 1, 2] as const).filter((a) => a !== normalAxis)
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

  return {
    id: nextId('b'),
    width: Math.round(width * 10) / 10,
    height: Math.round(height * 10) / 10,
    thickness,
    position: [centre.x, centre.y, centre.z],
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
