import { panelMountSupports, panelMountFrame } from './panelMounts'
import * as THREE from 'three'
import type { ConnectorData, EquipmentData, FittingData, PanelData, ProfileData } from '../store/useStore'
import { connectorEntry, connectorMounts, connectorScale } from './connectorCatalog'
import { auditBrackets, connectorSeatAt, connectorSeatsAt, type BracketSeat } from './bracketSeat'
import { computeAllTrims, type ProfileTrims } from './jointUtils'
import { panelOBB, trimmedOBB } from './analysis'
import { equipmentClearance } from './equipmentGeometry'
import { fittingBodies } from './fittingGeometry'
import { connectorHitsBody, connectorsCollide } from './connectorCollision'
import { hardwareReference } from './connectorHardware'
import { nonCornerMounted, nonCornerSupports } from './connectorMounting'

export interface ConnectorPlacementOptions {
  excludeConnectorId?: string
  equipment?: EquipmentData[]
  panels?: PanelData[]
  fittings?: FittingData[]
  /** Limit selectable seats by every actual support, retaining the full frame for cuts and obstruction checks. */
  seatFilter?: (seat: Pick<BracketSeat, 'position' | 'quaternion' | 'series' | 'profileSpec' | 'mountSeries'>,
    supportIds: readonly string[]) => boolean
}
export type ConnectorPlacementReason = 'occupied' | 'collision' | 'equipment' | 'no-joint' | 'unverified'
export interface ConnectorPlacementStatus {
  occupied: boolean
  allowed: boolean
  reason?: ConnectorPlacementReason
}
export interface ConnectorPlacementCandidate extends ConnectorPlacementStatus {
  seat: BracketSeat & { seated: true }
  key: string
  legs: BracketSeat['legs']
}

function contacts(c: Pick<ConnectorData, 'type' | 'position' | 'quaternion' | 'series' | 'profileSpec' | 'mountSeries' | 'panelMount'>) {
  if (c.panelMount?.mode === 'direct') {
    const frame = panelMountFrame(c as ConnectorData)
    return [{ point: frame.railHole, normal: frame.normal }]
  }
  const q = new THREE.Quaternion(...c.quaternion).normalize(), k = connectorScale(c.series ?? 20)
  return connectorMounts(c.type, c.series ?? 20).flatMap((mount) => mount.bolts.map((bolt) => ({
    point: new THREE.Vector3(...bolt).multiplyScalar(k).applyQuaternion(q).add(new THREE.Vector3(...c.position)),
    normal: new THREE.Vector3(...(mount.normal === 'x' ? [1, 0, 0] : mount.normal === 'y' ? [0, 1, 0] : [0, 0, 1]) as [number, number, number]).applyQuaternion(q),
  })))
}

/** Stable identity from physical mounting holes, including symmetric arm permutations. */
export function connectorInstallationKey(c: Pick<ConnectorData, 'type' | 'position' | 'quaternion' | 'series' | 'profileSpec' | 'mountSeries' | 'panelMount'>): string {
  const rounded = (n: number) => Number(n.toFixed(4))
  const mounts = contacts(c).map(({ point, normal }) => [...point.toArray(), ...normal.toArray()].map(rounded))
  if (mounts.length) return JSON.stringify([c.type, c.series ?? 20, c.profileSpec, mounts.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))])
  const q = new THREE.Quaternion(...c.quaternion).normalize().toArray()
  const sign = (q.find((n) => Math.abs(n) > 1e-12) ?? 1) < 0 ? -1 : 1
  return JSON.stringify([c.type, c.series ?? 20, c.profileSpec, c.position.map(rounded), q.map((n) => rounded(n * sign))])
}

export function sameConnectorInstallation(a: ConnectorData, b: ConnectorData): boolean {
  if (a.type !== b.type || (a.series ?? 20) !== (b.series ?? 20)) return false
  if (new THREE.Vector3(...a.position).distanceTo(new THREE.Vector3(...b.position)) > 1) return false
  const ca = contacts(a), cb = contacts(b)
  if (ca.length) return ca.length === cb.length && ca.every((x) => cb.some((y) => x.point.distanceTo(y.point) <= 1 && x.normal.dot(y.normal) > 0.999))
  const qa = new THREE.Quaternion(...a.quaternion).normalize(), qb = new THREE.Quaternion(...b.quaternion).normalize()
  if (a.type === 'end-cap') {
    if (a.profileSpec !== b.profileSpec) return false
    const axis = (v: [number, number, number], q: THREE.Quaternion) => new THREE.Vector3(...v).applyQuaternion(q)
    if (axis([0, 0, 1], qa).dot(axis([0, 0, 1], qb)) < 0.999) return false
    const x = axis([1, 0, 0], qa)
    return (a.profileSpec === '2040' || a.profileSpec === '3040'
      ? Math.abs(x.dot(axis([1, 0, 0], qb)))
      : Math.max(Math.abs(x.dot(axis([1, 0, 0], qb))), Math.abs(x.dot(axis([0, 1, 0], qb))))) > 0.999
  }
  return Math.abs(qa.dot(qb)) > 0.999
}

/** Shared installation and obstruction checks for manual placement, editing and automatic filling. */
export function validateConnectorPlacement(
  part: ConnectorData, profiles: ProfileData[], connectors: ConnectorData[], options: ConnectorPlacementOptions = {},
): ConnectorPlacementStatus {
  return createConnectorPlacementValidator(profiles, options)(part, connectors)
}

/** Reuse frame geometry while evaluating a batch of seats or adding connectors. */
export function createConnectorPlacementValidator(profiles: ProfileData[], options: ConnectorPlacementOptions = {},
  trims: Map<string, ProfileTrims> = computeAllTrims(profiles)) {
  const members = profiles.map((p) => trimmedOBB(p, trims.get(p.id)!))
  const equipment = (options.equipment ?? []).map(equipmentClearance)
  const boards = [...(options.panels ?? []).map((p) => ({ body: panelOBB(p), id: p.id })), ...(options.fittings ?? []).flatMap((fitting) => fittingBodies(fitting).map((body) => ({ body, id: fitting.id })))]
  return (part: ConnectorData, connectors: ConnectorData[]): ConnectorPlacementStatus => {
    const others = connectors.filter((c) => c.id !== options.excludeConnectorId)
    if (others.some((c) => sameConnectorInstallation(part, c))) return { occupied: true, allowed: false, reason: 'occupied' }
    if (!hardwareReference(part.type, part.series ?? 20, part.profileSpec)?.verified) return { occupied: false, allowed: false, reason: 'unverified' }
    const corner = connectorEntry(part.type)?.fit === 'corner' && part.type !== 'corner-3way'
    if (part.panelMount ? !panelMountSupports(part, profiles, options.panels ?? [], trims) : !corner && !nonCornerMounted(part, profiles, trims)) return { occupied: false, allowed: false, reason: 'no-joint' }
    if (corner && auditBrackets(profiles, [part], trims).length) return { occupied: false, allowed: false, reason: 'no-joint' }
    if (equipment.some((body) => connectorHitsBody(part, body, 1, false)))
      return { occupied: false, allowed: false, reason: 'equipment' }
    if (others.some((c) => connectorsCollide(part, c))
      || members.some((body) => connectorHitsBody(part, body))
      || boards.some(({ body, id }) => connectorHitsBody(part, body, 1, false, id)))
      return { occupied: false, allowed: false, reason: 'collision' }
    return { occupied: false, allowed: true }
  }
}

export function connectorPlacementCandidates(
  type: string, point: THREE.Vector3, profiles: ProfileData[], connectors: ConnectorData[],
  normal?: THREE.Vector3 | null, searchPoint = point, options: ConnectorPlacementOptions = {},
): ConnectorPlacementCandidate[] {
  const seen = new Set<string>()
  const validate = createConnectorPlacementValidator(profiles, options)
  const cornerPair = connectorEntry(type)?.fit === 'corner' && type !== 'corner-3way'
  const trims = options.seatFilter && !cornerPair ? computeAllTrims(profiles) : undefined
  return connectorSeatsAt(type, point, profiles, normal, searchPoint).flatMap((candidate) => {
    const part = { id: 'candidate', type, ...candidate }, key = connectorInstallationKey(part)
    if (options.seatFilter) {
      const supportIds = cornerPair ? candidate.legs : nonCornerSupports(part, profiles, trims)
      if (!supportIds?.length || !options.seatFilter(candidate, supportIds)) return []
    }
    if (seen.has(key)) return []
    seen.add(key)
    return [{ seat: { ...candidate, seated: true as const }, legs: candidate.legs, key,
      ...validate(part, connectors) }]
  }).sort((a, b) => Number(b.allowed || b.occupied) - Number(a.allowed || a.occupied))
}

/** Resolve one explicit placement choice, without advancing past occupied or blocked seats. */
export function resolveConnectorPlacement(
  type: string, point: THREE.Vector3, profiles: ProfileData[], connectors: ConnectorData[],
  normal?: THREE.Vector3 | null, choice: number | string = 0,
  searchPoint = point, options: ConnectorPlacementOptions = {},
) {
  const corner = connectorEntry(type)?.fit === 'corner'
  const candidates = connectorPlacementCandidates(type, point, profiles, connectors, normal, searchPoint, options)
  const keys = candidates.map((c) => c.key)
  const index = typeof choice === 'string' ? Math.max(0, keys.indexOf(choice))
    : candidates.length ? ((choice % candidates.length) + candidates.length) % candidates.length : 0
  const candidate = candidates[index]
  let filteredFallback = corner && !!options.seatFilter
  let seat: ReturnType<typeof connectorSeatAt> = candidate?.seat ?? connectorSeatAt(type, point, filteredFallback ? [] : profiles, normal)
  if (!candidate && options.seatFilter && !corner) {
    const supportIds = nonCornerSupports({ id: 'candidate', type, ...seat }, profiles)
    filteredFallback = !supportIds?.length || !options.seatFilter(seat, supportIds)
    if (filteredFallback) seat = connectorSeatAt(type, point, [], normal)
  }
  const status = candidate ?? (filteredFallback
    ? { occupied: false, allowed: false, reason: 'no-joint' as const }
    : !hardwareReference(type, seat.series, seat.profileSpec)?.verified
    ? { occupied: false, allowed: false, reason: 'unverified' as const } : corner ? { occupied: false, allowed: false, reason: 'no-joint' as const }
    : validateConnectorPlacement({ id: 'candidate', type, ...seat }, profiles, connectors, options))
  return { seat, index, keys, key: keys[index] ?? null, count: candidates.length, legs: candidate?.legs,
    occupied: status.occupied, allowed: status.allowed, reason: status.reason, candidates }
}
