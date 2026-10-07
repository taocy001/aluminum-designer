import * as THREE from 'three'
import type { ConnectorData, ProfileData } from '../store/useStore'
import { connectorInstallationKey, connectorPlacementCandidates, createConnectorPlacementValidator, resolveConnectorPlacement, type ConnectorPlacementCandidate, type ConnectorPlacementOptions } from './connectorPlacement'
import { connectorEntry } from './connectorCatalog'
import { endCapSeat } from './bracketSeat'
import { computeAllTrims } from './jointUtils'

const sameRotation = (a: ConnectorData['quaternion'], b: ConnectorData['quaternion']) =>
  Math.abs(new THREE.Quaternion(...a).normalize().dot(new THREE.Quaternion(...b).normalize())) > 1 - 1e-8
const sameModel = (part: ConnectorData, seat: Partial<ConnectorData>) =>
  seat.series === (part.series ?? 20) && (part.type !== 'end-cap'
    || seat.profileSpec === (part.profileSpec ?? `${part.series ?? 20}${part.series ?? 20}`))

type RecoveryCandidate = Omit<ConnectorPlacementCandidate, 'seat' | 'legs'> & {
  seat: ReturnType<typeof resolveConnectorPlacement>['seat']; legs: string[]
}
function nearbySeats(type: string, point: THREE.Vector3, profiles: ProfileData[], connectors: ConnectorData[], options: ConnectorPlacementOptions): RecoveryCandidate[] {
  if (connectorEntry(type)?.fit !== 'inline') return connectorPlacementCandidates(type, point, profiles, connectors, undefined, undefined, options)
  const trims = computeAllTrims(profiles), seats = new Map<string, RecoveryCandidate>()
  for (const profile of profiles) for (const side of [-1, 1] as const) {
    const end = endCapSeat(profile, side, trims.get(profile.id)!)
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(...end.quaternion))
    if (type !== 'end-cap' && normal.y > -.999) continue
    const at = new THREE.Vector3(...end.position)
    const resolved = resolveConnectorPlacement(type, at, profiles, connectors, normal, 0, at, options)
    const key = connectorInstallationKey({ type, ...resolved.seat })
    seats.set(key, { seat: resolved.seat, key, legs: [profile.id], allowed: resolved.allowed,
      occupied: resolved.occupied, reason: resolved.reason })
  }
  return [...seats.values()]
}

/** Repair only unambiguous nearby installations, keeping IDs and all valid or locked parts. */
export function repairConnectorSeats(type: string, profiles: ProfileData[], connectors: ConnectorData[], options: ConnectorPlacementOptions = {}) {
  const validate = createConnectorPlacementValidator(profiles, options)
  const result = [...connectors]
  let repaired = 0
  for (let index = 0; index < result.length; index++) {
    const part = result[index]
    if (part.type !== type || part.locked || part.panelMount) continue
    const others = result.filter((_, other) => other !== index)
    if (validate(part, others).reason !== 'no-joint') continue
    const point = new THREE.Vector3(...part.position)
    const candidates = nearbySeats(type, point, profiles, others, options)
      .filter((candidate) => candidate.allowed && sameModel(part, candidate.seat)
        && sameRotation(part.quaternion, candidate.seat.quaternion)
        && point.distanceTo(new THREE.Vector3(...candidate.seat.position)) <= 20)
    // A changed frame can have several plausible destinations. Leave that decision to the editor.
    if (candidates.length !== 1) continue
    const { position, quaternion, series, profileSpec, mountSeries } = candidates[0].seat
    result[index] = { ...part, position, quaternion, series, profileSpec, mountSeries, supportBinding: undefined }
    repaired++
  }
  const unresolved = result.filter((part) => part.type === type
    && !validate(part, result.filter((other) => other.id !== part.id)).allowed).length
  return { connectors: result, repaired, unresolved }
}

/** Existing parts use the same physical seats and obstruction checks as new placement. */
export function snapDraggedConnector(
  part: ConnectorData, proposed: THREE.Vector3, origin: THREE.Vector3,
  profiles: ProfileData[], connectors: ConnectorData[], allowedAxes: readonly number[], threshold: number,
  options: ConnectorPlacementOptions = {}, previousKey?: string | null,
) {
  if (part.panelMount) return null
  const candidates = nearbySeats(part.type, proposed, profiles, connectors,
    { ...options, excludeConnectorId: part.id }).filter((candidate) => candidate.allowed
      && sameModel(part, candidate.seat)
      && candidate.seat.position.every((value, axis) => allowedAxes.includes(axis) || Math.abs(value - origin.getComponent(axis)) < .05)
      && (allowedAxes.length !== 1 || sameRotation(part.quaternion, candidate.seat.quaternion)))
    .map((candidate) => ({ candidate, distance: proposed.distanceTo(new THREE.Vector3(...candidate.seat.position)) }))
    .filter(({ distance }) => distance <= threshold)
    .sort((a, b) => a.distance - b.distance
      || Number(sameRotation(part.quaternion, b.candidate.seat.quaternion)) - Number(sameRotation(part.quaternion, a.candidate.seat.quaternion)))
  const best = candidates[0]
  if (!best) return null
  // Keep the current slot through tiny pointer jitter without trapping the part there.
  return candidates.find(({ candidate, distance }) => candidate.key === previousKey && distance <= best.distance + 2)?.candidate
    ?? best.candidate
}
