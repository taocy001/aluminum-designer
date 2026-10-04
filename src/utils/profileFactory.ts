import * as THREE from 'three'
import { useStore, type ProfileData, type ProfileSpec } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { analyzeFrame } from './analysis'
import { faceAlignOnCreate, constrainDrawingFaces, type DrawingFaceOptions, type DrawingFacePlacement } from './faceAlign'
import { resolveConnectorPlacement } from './connectorPlacement'
import { specDims } from './specUtils'
import { translations } from './translations'
import { reportEditResult } from './editFeedback'

let idSeq = 0
export function nextId(prefix: string): string {
  idSeq = (idSeq + 1) % 1000
  return `${prefix}-${Date.now().toString(36)}${idSeq.toString(36)}`
}

export const MIN_LENGTH = 10

/** Round to 0.001 mm and normalise -0 so stored coordinates compare cleanly */
export function clean(v: number): number {
  const r = Math.round(v * 1000) / 1000
  return r === 0 ? 0 : r
}

export function buildProfile(start: THREE.Vector3, end: THREE.Vector3, spec: ProfileSpec, id?: string): ProfileData | null {
  const length = start.distanceTo(end)
  if (!isFinite(length) || length < MIN_LENGTH) return null
  const direction = end.clone().sub(start).normalize()
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction)
  return {
    id: id ?? nextId('p'),
    spec,
    length: Math.round(length * 100) / 100,
    position: [clean(start.x), clean(start.y), clean(start.z)],
    quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
    miterCuts: [],
    holes: [],
  }
}

/** Lowest allowed centerline height for a horizontal member so it rests on the floor */
export function floorY(spec: ProfileSpec): number {
  return specDims(spec).hh
}

/**
 * Lowest point of a member's body, valid at any orientation.
 * Gesture-driven moves use it to keep parts on or above the floor; typed coordinates don't.
 */
export function lowestPointY(p: ProfileData): number {
  const quat = new THREE.Quaternion(...p.quaternion).normalize()
  const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(quat)
  const lx = new THREE.Vector3(1, 0, 0).applyQuaternion(quat)
  const ly = new THREE.Vector3(0, 1, 0).applyQuaternion(quat)
  const { hw, hh } = specDims(p.spec)
  const origin = new THREE.Vector3(...p.position)
  const start = origin.clone().addScaledVector(dir, p.fixedTrims?.start ?? 0)
  const end = origin.clone().addScaledVector(dir, p.length - (p.fixedTrims?.end ?? 0))
  const half = Math.abs(lx.y) * hw + Math.abs(ly.y) * hh
  return Math.min(start.y, end.y) - half
}

/**
 * Turn two points into a member the way a hand-drawn one is made: the section, then the way
 * it is turned, then nudged sideways so its faces meet what it lands on.
 *
 * `twin` is a member already in the drawing that this one copies: its roll (which way a 2040
 * faces) comes with it, because a rail that repeats another is turned the way that one is.
 * `floorFeet` stands an upright whose foot is within one section of the ground on the ground,
 * which is where a cabinet's posts stand.
 */
export function prepareProfile(
  start: THREE.Vector3, end: THREE.Vector3, spec: ProfileSpec, others: ProfileData[],
  opts: DrawingFaceOptions & { twin?: ProfileData | null; floorFeet?: boolean; id?: string } = {},
): ProfileData | null {
  const placement = prepareProfilePlacement(start, end, spec, others, opts)
  return placement && !placement.blocked ? placement.profile : null
}

/** Geometry plus any unresolved explicit face choice, shared by the ghost and both commits. */
export function prepareProfilePlacement(
  start: THREE.Vector3, end: THREE.Vector3, spec: ProfileSpec, others: ProfileData[],
  opts: DrawingFaceOptions & { twin?: ProfileData | null; floorFeet?: boolean; id?: string } = {},
): DrawingFacePlacement | null {
  let s = start.clone(), e = end.clone()
  const { twin, floorFeet = false } = opts
  if (floorFeet) {
    const dir = e.clone().sub(s).normalize()
    if (Math.abs(dir.y) > 0.99) {
      const { w, h } = specDims(spec)
      const lo = s.y <= e.y ? s : e
      if (lo.y > 0 && lo.y <= Math.max(w, h)) lo.y = 0
    }
  }
  let built: ProfileData | null
  if (twin) {
    // run the same way as the twin, so its quaternion — and with it the roll — carries over
    const td = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(...twin.quaternion).normalize())
    if (e.clone().sub(s).dot(td) < 0) [s, e] = [e, s]
    built = buildProfile(s, e, spec, opts.id)
    if (built && Math.abs(e.clone().sub(s).normalize().dot(td)) > 0.999) built = { ...built, quaternion: [...twin.quaternion] as [number, number, number, number] }
  } else {
    built = buildProfile(s, e, spec, opts.id)
  }
  if (!built) return null
  const pairedTarget = opts.startFace && opts.startAlignmentFace?.profileId === opts.startFace.profileId
    ? others.find((p) => p.id === opts.startFace!.profileId) : undefined
  const direction = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(...built.quaternion))
  const normalOf = (ref: NonNullable<DrawingFaceOptions['startFace']>) => new THREE.Vector3()
    .setComponent(ref.axis, ref.side).applyQuaternion(new THREE.Quaternion(...pairedTarget!.quaternion).normalize())
  // A chosen seat and edge fix the starting section. An incidental joint at the
  // changing far end must not move or rotate it after the user has picked it.
  const startOnly = !!pairedTarget && normalOf(opts.startFace!).dot(direction) > 1 - 1e-6
    && Math.abs(normalOf(opts.startAlignmentFace!).dot(direction)) < 1e-6
  const profile = faceAlignOnCreate(built, others, startOnly)
  return opts.startFace || opts.endFace
    ? constrainDrawingFaces(profile, others, opts)
    : { profile, issue: null, blocked: false }
}

/** Create a profile and report geometric conflicts. */
export function tryAddProfile(start: THREE.Vector3, end: THREE.Vector3, spec: ProfileSpec, faces: DrawingFaceOptions = {}): boolean {
  const { showToast, language } = useToolStore.getState()
  const t = translations[language]
  // Align section faces before applying explicit drawing constraints.
  const placement = prepareProfilePlacement(start, end, spec, useStore.getState().profiles, faces)
  if (!placement) { showToast(t.toastTooShort, 'error'); return false }
  if (placement.issue) {
    const message = placement.issue === 'face-direction' ? t.faceDirectionBlocked
      : placement.issue === 'face-oblique' ? t.faceObliqueBlocked
      : placement.issue === 'face-end-conflict' ? t.faceEndConflict : t.toastTooShort
    showToast(message, placement.blocked ? 'error' : 'info')
  }
  if (placement.blocked) return false
  const candidate = placement.profile
  const result = placement.referenceProfiles
    ? useStore.getState().commitDocument({ profiles: [...placement.referenceProfiles, candidate] })
    : useStore.getState().addProfile(candidate)
  if (!reportEditResult(result)) return false
  const st = useStore.getState()
  const { conflictIds, equipmentConflictIds } = analyzeFrame(st.profiles, st.connectors, st.panels, st.fittings, st.equipment)
  if (conflictIds.has(candidate.id) || equipmentConflictIds.has(candidate.id)) showToast(t.toastOverlap, 'error')
  return true
}

/** Place a connector, oriented to the members it was dropped on */
export function placeConnector(
  point: THREE.Vector3, type: string, surfaceNormal?: THREE.Vector3 | null,
  choice: number | string = 0, searchPoint = point,
): void {
  const { profiles, connectors, equipment, panels, fittings, addConnector } = useStore.getState()
  const { seat, occupied, allowed, reason } = resolveConnectorPlacement(type, point, profiles, connectors, surfaceNormal, choice, searchPoint, { equipment, panels, fittings })
  const { showToast, language } = useToolStore.getState()
  const t = translations[language]
  if (occupied) { showToast(t.connectorOccupied, 'info'); return }
  if (!allowed) {
    showToast(reason === 'collision' ? t.connectorReasonCollision : reason === 'equipment' ? t.connectorReasonEquipment : reason === 'unverified' ? t.connectorReasonUnverified : t.connectorNoSeat, 'info')
    return
  }
  reportEditResult(addConnector({
    id: nextId('c'),
    type,
    series: seat.series,
    position: seat.position,
    quaternion: seat.quaternion,
    profileSpec: seat.profileSpec,
    mountSeries: seat.mountSeries,
  }))
}
