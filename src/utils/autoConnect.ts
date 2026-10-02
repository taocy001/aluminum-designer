import { noteNext } from './opLog'
import { reportEditResult } from './editFeedback'
import * as THREE from 'three'
import { useStore, type ConnectorData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { analyzeFrame, connectorOBB, trimmedOBB } from './analysis'
import { obbPenetration, type OBB } from './obb'
import { connectorEntry, connectorLabel, seriesOf, type ConnectorSeries } from './connectorCatalog'
import { fitConnector, jointPartnersAt } from './connectorFit'
import { getProfileDir, getProfileEndpoints } from './geometryCore'
import { sharedEdge } from './specCompat'
import { auditBrackets, connectorSeatAt, endCapSeat, seatsFor } from './bracketSeat'
import { nextId } from './profileFactory'
import { translations } from './translations'
import { equipmentClearance } from './equipmentGeometry'

/** a joint already has a part if one sits within this of it (mm) */
const OCCUPIED_MM = 30

/** A cap occupies one end plane; its square section may use a different roll convention. */
function sameCapSeat(a: Pick<ConnectorData, 'position' | 'quaternion' | 'series'>,
  b: Pick<ConnectorData, 'position' | 'quaternion' | 'series'>): boolean {
  if ((a.series ?? 20) !== (b.series ?? 20)) return false
  if (new THREE.Vector3(...a.position).distanceTo(new THREE.Vector3(...b.position)) > 1) return false
  const qa = new THREE.Quaternion(...a.quaternion).normalize(), qb = new THREE.Quaternion(...b.quaternion).normalize()
  const axis = (x: number, y: number, z: number, q: THREE.Quaternion) => new THREE.Vector3(x, y, z).applyQuaternion(q)
  if (axis(0, 0, 1, qa).dot(axis(0, 0, 1, qb)) <= 0.999) return false
  // The square plate/plug permit quarter turns, but an arbitrary roll leaves its corners proud.
  const x = axis(1, 0, 0, qa)
  return Math.max(Math.abs(x.dot(axis(1, 0, 0, qb))), Math.abs(x.dot(axis(0, 1, 0, qb)))) > 0.999
}

/** Check candidate overlap against placed connectors and frame solids. */
function crowded(part: ConnectorData, placed: ConnectorData[], metal: OBB[]): boolean {
  const box = connectorOBB(part)
  if (placed.some((q) => obbPenetration(box, connectorOBB(q), 1) > 1)) return true
  return metal.some((m) => obbPenetration(box, m, 3) > 3)
}

export interface AutoConnectResult {
  placed: number
  /** Installation positions already occupied by a valid connector. */
  skipped: number
  /** parts of this type left stranded by a member that moved, cleared away */
  removed?: number
  /** No valid seat, or every candidate is obstructed by metal or another connector. */
  unbolted?: number
  /** Candidates obstructed by an equipment body or its reserved space. */
  blocked?: number
  /** why nothing was placed, when nothing was */
  reason?: 'no-frame' | 'needs-a-surface' | 'nothing-open' | 'edit-rejected'
}

/**
 * Add missing connectors to compatible inferred joints and free ends.
 * Corner seats follow each member pair and shared slot line. Face-mounted types require explicit placement.
 */
export function autoConnect(type: string): AutoConnectResult {
  const entry = connectorEntry(type)
  const store = useStore.getState()
  const t = translations[useToolStore.getState().language]
  const { profiles, connectors } = store
  if (!entry || profiles.length === 0) return { placed: 0, skipped: 0, reason: 'no-frame' }
  if (entry.fit === 'face' || entry.fit === 'free') {
    useToolStore.getState().showToast(t.toastAutoNeedsSurface, 'info')
    return { placed: 0, skipped: 0, reason: 'needs-a-surface' }
  }

  // Track current joints and end seats to remove obsolete unlocked connectors.
  const wanted: THREE.Vector3[] = []
  const capSeats: ReturnType<typeof endCapSeat>[] = []

  const { trims } = analyzeFrame(profiles)
  const metal = profiles.map((q) => trimmedOBB(q, trims.get(q.id)!))
  const reserved = store.equipment.map(equipmentClearance)
  const equipmentBlocked = (c: ConnectorData) => {
    const box = connectorOBB(c)
    return reserved.some((e) => obbPenetration(box, e, 1) > 0)
  }
  // Valid connectors with the same fit occupy their existing seats.
  const badBrackets = new Set(auditBrackets(profiles, connectors, trims).map((c) => c.id))
  const active = connectors.filter((c) => c.type !== type || c.locked || !badBrackets.has(c.id))
  const validExisting = active.filter((c) => connectorEntry(c.type)?.fit === entry.fit
    && (entry.fit !== 'corner' || !badBrackets.has(c.id)))
  const occupied = (candidate: ConnectorData) => [...validExisting, ...made].some((c) =>
    type === 'end-cap' ? c.type === 'end-cap' && sameCapSeat(c, candidate)
      : new THREE.Vector3(...c.position).distanceTo(new THREE.Vector3(...candidate.position)) <= 1
        && Math.abs(new THREE.Quaternion(...c.quaternion).normalize().dot(new THREE.Quaternion(...candidate.quaternion).normalize())) > 0.999)

  const made: ConnectorData[] = []
  let skipped = 0
  // Installation positions with no valid, unobstructed seat.
  let unbolted = 0
  let blocked = 0
  const visitedPairs = new Set<string>()
  for (const p of profiles) {
    const tr = trims.get(p.id)
    if (!tr) continue
    const { start, end } = getProfileEndpoints(p)
    for (const [where, at] of [[tr.start, start], [tr.end, end]] as const) {
      if (entry.fit === 'corner') {
        for (const { a, b, at: joint } of jointPartnersAt(at, p, profiles)) {
          const key = JSON.stringify([a.id, b.id])
          if (visitedPairs.has(key)) continue
          visitedPairs.add(key)
          wanted.push(joint)
          const candidates = seatsFor(type, a, b, joint)
            .filter((s) => auditBrackets(profiles, [{ id: 'candidate', type, ...s }], trims).length === 0)
          if (!candidates.length) { if (sharedEdge(a.spec, b.spec)) unbolted++; continue }
          // Each shared slot line can receive one bracket. Opposite T-joint sides are
          // alternatives for that line; they must not consume a second slot's seat.
          const across = new THREE.Vector3().crossVectors(getProfileDir(a), getProfileDir(b)).normalize()
          const lanes = new Map<number, typeof candidates>()
          for (const seat of candidates) {
            const lane = Math.round(new THREE.Vector3(...seat.position).dot(across) * 1000)
            lanes.set(lane, [...(lanes.get(lane) ?? []), seat])
          }
          for (const seats of lanes.values()) {
            const options = seats.map((s) => ({ id: 'candidate', type, ...s }))
            if (options.some(occupied)) { skipped++; continue }
            const available = options.filter((c) => !crowded(c, [...active, ...made], metal))
            const legal = available.find((c) => !equipmentBlocked(c))
            if (!legal) { if (available.length) blocked++; else unbolted++; continue }
            made.push({ ...legal, id: nextId('c') })
          }
        }
        continue
      }
      // Inline parts use a free end.
      if (where.partners !== 0) continue
      // Feet require a free end whose outward direction points down.
      if (entry.axes.towards === 'in') {
        const outward = getProfileDir(p)
        if (at.distanceTo(start) < at.distanceTo(end)) outward.negate()
        if (outward.y > -0.9) continue
      }
      const cap = type === 'end-cap' ? endCapSeat(p, where === tr.start ? -1 : 1, tr) : null
      if (cap) capSeats.push(cap)
      wanted.push(cap ? new THREE.Vector3(...cap.position) : at.clone())

      let position: [number, number, number]
      let quaternion: [number, number, number, number]
      let series: ConnectorSeries
      if (cap) {
        position = cap.position
        quaternion = cap.quaternion
        series = cap.series
      } else if (entry.fit === 'inline' && entry.axes.towards === 'in') {
        // The model origin is halfway up the foot, while the member endpoint is its top.
        // Use the same end seat as manual placement and the specific post being processed.
        const inline = connectorSeatAt(type, at, [p])
        position = inline.position
        quaternion = inline.quaternion
        series = inline.series
      } else {
        const placement = fitConnector(type, at, profiles, null)
        position = [at.x, at.y, at.z]
        quaternion = placement.quaternion
        series = placement.series ?? seriesOf(p.spec)
      }
      const part = { id: nextId('c'), type, series, position, quaternion }
      if (occupied(part)) { skipped++; continue }
      if (equipmentBlocked(part)) { blocked++; continue }
      made.push(part)
    }
  }

  // Remove obsolete connectors only for the requested type.
  const stale = connectors
    .filter((c) => c.type === type && !c.locked)
    .filter((c) => {
      if (type === 'end-cap') return !capSeats.some((seat) => sameCapSeat(c, seat))
      const v = new THREE.Vector3(...c.position)
      return badBrackets.has(c.id) || !wanted.some((w) => w.distanceTo(v) <= OCCUPIED_MM * 2)
    })
    .map((c) => c.id)

  if (made.length === 0 && stale.length === 0) {
    useToolStore.getState().showToast(blocked ? t.toastAutoEquipmentBlocked(blocked)
      : unbolted ? t.toastAutoUnbolted(unbolted) : t.toastAutoNothingOpen, 'info')
    return { placed: 0, skipped, unbolted, blocked, reason: 'nothing-open' }
  }
  noteNext(`fit ${connectorLabel(type, useToolStore.getState().language)}`)
  if (!reportEditResult(store.commitDocument({ connectors: [...connectors.filter((c) => !stale.includes(c.id)), ...made] }))) {
    return { placed: 0, skipped, removed: 0, unbolted, blocked, reason: 'edit-rejected' }
  }
  useToolStore.getState().showToast(t.toastAutoConnected(made.length, skipped, stale.length, unbolted, blocked), unbolted || blocked ? 'info' : 'success')
  return { placed: made.length, skipped, removed: stale.length, unbolted, blocked }
}
