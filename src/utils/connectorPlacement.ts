import * as THREE from 'three'
import type { ConnectorData, ProfileData } from '../store/useStore'
import { connectorEntry } from './connectorCatalog'
import { connectorSeatAt, connectorSeatsAt, type BracketSeat } from './bracketSeat'

function seatKey(seat: BracketSeat): string {
  const quaternion = new THREE.Quaternion(...seat.quaternion).normalize().toArray()
  const sign = (quaternion.find((value) => Math.abs(value) > 1e-12) ?? 1) < 0 ? -1 : 1
  const rounded = (value: number) => Number(value.toFixed(6))
  return JSON.stringify([
    seat.position.map(rounded), quaternion.map((value) => rounded(value * sign)),
    seat.series, seat.legs,
  ])
}

/** Resolve one explicit placement choice, without advancing past occupied seats. */
export function resolveConnectorPlacement(
  type: string, point: THREE.Vector3, profiles: ProfileData[], connectors: ConnectorData[],
  normal?: THREE.Vector3 | null, choice: number | string = 0,
  searchPoint = point,
) {
  const corner = connectorEntry(type)?.fit === 'corner'
  const candidates = corner ? connectorSeatsAt(type, point, profiles, normal, searchPoint) : []
  const keys = candidates.map(seatKey)
  const index = typeof choice === 'string' ? Math.max(0, keys.indexOf(choice))
    : candidates.length ? ((choice % candidates.length) + candidates.length) % candidates.length : 0
  const candidate = candidates[index]
  const seat = candidate ? { ...candidate, seated: true } : connectorSeatAt(type, point, profiles, normal)
  const position = new THREE.Vector3(...seat.position)
  const quaternion = new THREE.Quaternion(...seat.quaternion).normalize()
  const occupied = connectors.some((c) => c.type === type && (c.series ?? 20) === seat.series
    && new THREE.Vector3(...c.position).distanceTo(position) <= 1
    && Math.abs(new THREE.Quaternion(...c.quaternion).normalize().dot(quaternion)) > 0.999)
  return { seat, index, keys, key: keys[index] ?? null, count: candidates.length, legs: candidate?.legs,
    occupied, allowed: !corner || candidates.length > 0 }
}
