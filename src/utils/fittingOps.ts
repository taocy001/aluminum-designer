import { noteNext } from './opLog'
import * as THREE from 'three'
import { useStore, type FittingData, type FittingKind, type HingeSide, type HingeType, type Overlay } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { memberBox } from './dragSnap'
import { nextId } from './profileFactory'
import { specDims } from './specUtils'
import { translations } from './translations'

/**
 * Fit a drawer or a door to the opening the selected members bound.
 *
 * The selection has to say where the opening is — two uprights give its width, and the
 * members around them its height and depth. The clear opening is what is left between the
 * members, not the space they occupy, so each face comes in by one section.
 */

/** the smallest opening worth fitting anything to (mm) */
const MIN_OPENING = 60

export interface FittingRequest {
  kind: FittingKind
  /** drawer: how tall each front is. Ignored for a door, which fills the opening. */
  frontHeight?: number
  count?: number
  hinge?: HingeSide
  hingeType?: HingeType
  overlay?: Overlay
}

/** Which way the run faces: a kitchen is long one way and shallow the other, and it opens the shallow way */
function outwardAxis(): THREE.Vector3 {
  const whole = new THREE.Box3()
  for (const p of useStore.getState().profiles) whole.union(memberBox(p))
  const run = whole.getSize(new THREE.Vector3())
  // a tie goes to Z, which is the front of a cabinet drawn the conventional way round
  return run.z <= run.x + 1 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(-1, 0, 0)
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
  box.expandByVector(new THREE.Vector3(
    span.x > section * 2.5 ? -section : 0,
    span.y > section * 2.5 ? -section : 0,
    span.z > section * 2.5 ? -section : 0,
  ))

  const size = box.getSize(new THREE.Vector3())
  const out = outwardAxis()
  const quaternion = facing(out)
  const centre = box.getCenter(new THREE.Vector3())
  // across the opening and into it, in the fitting's own frame
  const across = Math.abs(out.z) > 0.5 ? size.x : size.z
  let deep = Math.abs(out.z) > 0.5 ? size.z : size.x

  // A drawer has to go somewhere, so it needs a real depth. A door only hangs on the front,
  // and two uprights on the same line — the usual way to say "this opening" — give no depth
  // at all; the cabinet behind them does.
  if (req.kind === 'door' && deep < MIN_OPENING) {
    const whole = new THREE.Box3()
    for (const p of store.profiles) whole.union(memberBox(p))
    const run = whole.getSize(new THREE.Vector3())
    deep = Math.max(MIN_OPENING, Math.abs(out.z) > 0.5 ? run.z : run.x)
    // and it hangs on the face nearest the front, not in the middle of the cabinet
    const front = Math.abs(out.z) > 0.5 ? centre.z : centre.x
    void front
  }
  if (across < MIN_OPENING || size.y < MIN_OPENING || (req.kind === 'drawer' && deep < MIN_OPENING)) {
    useToolStore.getState().showToast(t.toastDrawerTooSmall, 'error'); return false
  }

  const made: FittingData[] = []
  if (req.kind === 'drawer') {
    const frontHeight = Math.max(60, req.frontHeight ?? 200)
    const count = Math.max(1, Math.min(8, Math.floor(req.count ?? 1)))
    for (let i = 0; i < count; i++) {
      const y = box.min.y + frontHeight * (i + 0.5)
      if (y + frontHeight / 2 > box.max.y + 1) break
      made.push({
        id: nextId('f'), kind: 'drawer',
        position: [
          Math.abs(out.z) > 0.5 ? centre.x : centre.x, y,
          Math.abs(out.z) > 0.5 ? centre.z : centre.z,
        ],
        quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
        width: across, height: frontHeight, depth: deep,
        material: 'ply', open: 0,
      })
    }
  } else {
    // the selected uprights are the front of the cabinet, and the door's front plane is at
    // +depth/2 in its own frame, so the opening centre sits half a depth behind them
    const back = out.clone().multiplyScalar(-deep / 2)
    made.push({
      id: nextId('f'), kind: 'door',
      position: [centre.x + back.x, centre.y + back.y, centre.z + back.z],
      quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
      width: across, height: size.y, depth: deep,
      material: 'mdf', open: 0,
      hinge: req.hinge ?? 'left',
      hingeType: req.hingeType ?? 'cup',
      overlay: req.overlay ?? 'full',
    })
  }

  if (made.length === 0) { useToolStore.getState().showToast(t.toastDrawerTooSmall, 'error'); return false }
  noteNext(req.kind === 'drawer' ? `fit ${made.length} drawer${made.length > 1 ? 's' : ''}` : 'hang a door')
  store.addFittings(made, false)
  useToolStore.getState().showToast(
    req.kind === 'drawer' ? t.toastDrawerAdded(made.length, made.length) : t.toastDoorAdded(made.length), 'success')
  return true
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
