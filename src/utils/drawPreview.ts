import * as THREE from 'three'
import type { ProfileData, ProfileSpec } from '../store/useStore'
import { prepareProfilePlacement } from './profileFactory'
import { computeTrims } from './jointUtils'
import type { DrawingFaceOptions } from './faceAlign'
import { drawingContacts } from './drawContacts'

/** Resolve the numeric drawing input once for the ghost, HUD, mouse and Enter commits. */
export function drawingInput(start: THREE.Vector3, end: THREE.Vector3, faces: DrawingFaceOptions, input = '') {
  if (input.trim() === '') return { end, faces }
  const length = Number(input)
  if (!Number.isFinite(length) || length < 10 || start.distanceTo(end) < 1) return null
  return { end: start.clone().addScaledVector(end.clone().sub(start).normalize(), length),
    faces: { ...faces, exactLength: length } }
}

/** The same section alignment and end cuts as a committed member, without allocating
 * a document ID or touching the drawing/history while the pointer moves. */
export function prepareDrawingPreview(start: THREE.Vector3, end: THREE.Vector3, spec: ProfileSpec, profiles: ProfileData[], faces: DrawingFaceOptions = {}, input = '') {
  const resolved = drawingInput(start, end, faces, input)
  if (!resolved) return null
  let id = '__drawing_preview__'
  const ids = new Set(profiles.map((p) => p.id))
  while (ids.has(id)) id += '_'
  const placement = prepareProfilePlacement(start, resolved.end, spec, profiles, { ...resolved.faces, id })
  if (!placement) return null
  const { profile } = placement
  const referenceProfiles = placement.referenceProfiles ?? profiles
  const trims = computeTrims(profile, [...referenceProfiles, profile])
  const contacts = drawingContacts(profile, trims, referenceProfiles, resolved.faces, placement)
  const quaternion = new THREE.Quaternion(...profile.quaternion).normalize()
  const position = new THREE.Vector3(...profile.position)
    .addScaledVector(new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion), trims.start.trim)
  return { profile, referenceProfiles, trims, position, quaternion, contacts, issue: placement.issue, blocked: placement.blocked,
    cutLength: isFinite(trims.cutLength) && trims.cutLength > 0.1 ? trims.cutLength : 1 }
}
