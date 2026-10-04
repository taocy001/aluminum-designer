import * as THREE from 'three'
import type { ProfileData } from '../store/useStore'
import { auditBrackets, seatsFor } from './bracketSeat'
import { connectorHitsBody } from './connectorCollision'
import { hardwareReference } from './connectorHardware'
import { trimmedOBB } from './analysis'
import { computeAllTrims, type ProfileTrims } from './jointUtils'

const PAIR_TYPES = ['inside-corner', 'bracket', 'gusset', 't-bracket'] as const
const results = new Map<string, boolean>()
const contacts = new Map<string, boolean>()
const LIMIT = 512
const geometryKey = (p: ProfileData, t: ProfileTrims) => [p.spec, p.length, p.position,
  p.quaternion, p.miterCuts, t.start.trim, t.end.trim, t.cutLength]

/** Actual cut-body contact, including a 0.5 mm separation tolerance on each SAT axis. */
export function actualTouching(
  a: ProfileData, b: ProfileData, trims: Map<string, ProfileTrims> = computeAllTrims([a, b]),
): boolean {
  if (a.id === b.id) return false
  const ta = trims.get(a.id), tb = trims.get(b.id)
  if (!ta || !tb) return false
  const key = JSON.stringify([geometryKey(a, ta), geometryKey(b, tb)])
  const cached = contacts.get(key)
  if (cached !== undefined) return cached
  const left = trimmedOBB(a, ta), right = trimmedOBB(b, tb)
  const delta = right.center.clone().sub(left.center)
  const axes = [...left.axes, ...right.axes]
  for (const x of left.axes) for (const y of right.axes) {
    const cross = new THREE.Vector3().crossVectors(x, y)
    if (cross.lengthSq() > 1e-8) axes.push(cross.normalize())
  }
  const radius = (body: typeof left, axis: THREE.Vector3) => body.axes.reduce(
    (sum, direction, i) => sum + Math.abs(direction.dot(axis)) * body.half.getComponent(i), 0)
  const touching = axes.every((axis) => Math.abs(delta.dot(axis))
    <= radius(left, axis) + radius(right, axis) + 0.5 + 1e-7)
  if (contacts.size >= LIMIT) contacts.delete(contacts.keys().next().value!)
  contacts.set(key, touching)
  return touching
}

/**
 * Does a verified connector fit this pair's actual cut bodies? This deliberately
 * excludes other parts: it describes pair compatibility, not an available placement
 * in the full assembly. Placement validation separately checks every obstacle.
 */
export function supportsProfileJoint(
  a: ProfileData, b: ProfileData, at: THREE.Vector3,
  trims: Map<string, ProfileTrims> = computeAllTrims([a, b]),
): boolean {
  if (a.id === b.id) return false
  const ta = trims.get(a.id), tb = trims.get(b.id)
  if (!ta || !tb) return false
  // Include values rather than references or IDs: repairs mutate poses and trims,
  // while suggestions repeatedly create equivalent members with fresh IDs.
  const key = JSON.stringify([geometryKey(a, ta), geometryKey(b, tb), at.toArray()])
  const cached = results.get(key)
  if (cached !== undefined) return cached
  const profiles = [a, b]
  let bodies: ReturnType<typeof trimmedOBB>[] | undefined
  const supported = PAIR_TYPES.some((type) => seatsFor(type, a, b, at).some((seat) => {
    const reference = hardwareReference(type, seat.series)
    if (!reference?.verified || !reference.supportedSeries.includes(seat.series)) return false
    const part = { id: 'joint-support-candidate', type, ...seat }
    if (auditBrackets(profiles, [part], trims).length) return false
    bodies ??= [trimmedOBB(a, ta), trimmedOBB(b, tb)]
    return bodies.every((body) => !connectorHitsBody(part, body))
  }))
  if (results.size >= LIMIT) results.delete(results.keys().next().value!)
  results.set(key, supported)
  return supported
}

/** Nearby centre lines alone do not imply a joint; actual separated bodies are not a mismatch. */
export function unsupportedProfileJoint(
  a: ProfileData, b: ProfileData, at: THREE.Vector3,
  trims: Map<string, ProfileTrims> = computeAllTrims([a, b]),
): boolean {
  // A separated pair cannot be an unsupported contact. Avoid enumerating and
  // auditing hardware until the cheaper physical-contact prerequisite holds.
  return actualTouching(a, b, trims) && !supportsProfileJoint(a, b, at, trims)
}
