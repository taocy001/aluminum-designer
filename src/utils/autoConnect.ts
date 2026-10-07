import { noteNext } from './opLog'
import { repairConnectorSeats } from './connectorRecovery'
import { reportEditResult } from './editFeedback'
import * as THREE from 'three'
import { useStore, type ConnectorData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { analyzeFrame } from './analysis'
import { connectorEntry, connectorLabel, seriesOf, type ConnectorSeries } from './connectorCatalog'
import { endCornerSeats } from './connectorMounting'
import { fitConnector, jointPartnersAt } from './connectorFit'
import { getProfileDir, getProfileEndpoints } from './geometryCore'
import { auditBrackets, connectorSeatAt, endCapSeat, seatsFor } from './bracketSeat'
import { nextId } from './profileFactory'
import { translations } from './translations'
import { connectorInstallationKey, createConnectorPlacementValidator } from './connectorPlacement'

export interface AutoConnectResult {
  placed: number
  repaired?: number
  unresolved?: number
  /** Installation positions already occupied by a valid connector. */
  skipped: number
  /** Existing connectors are preserved; retained for result consumers. */
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
  const { profiles } = store
  if (!entry || profiles.length === 0) return { placed: 0, skipped: 0, reason: 'no-frame' }
  if (entry.fit === 'face' || entry.fit === 'free') {
    useToolStore.getState().showToast(t.toastAutoNeedsSurface, 'info')
    return { placed: 0, skipped: 0, reason: 'needs-a-surface' }
  }

  const { trims } = analyzeFrame(profiles)
  const options = { equipment: store.equipment, panels: store.panels, fittings: store.fittings }
  const validate = createConnectorPlacementValidator(profiles, options)
  const { connectors, repaired, unresolved } = repairConnectorSeats(type, profiles, store.connectors, options)
  const repairFeedback = repaired || unresolved ? t.toastAutoRepaired(repaired, unresolved) : ''
  const made: ConnectorData[] = []
  let skipped = 0
  // Installation positions with no valid, unobstructed seat.
  let unbolted = 0
  let blocked = 0
  const visitedPairs = new Set<string>()
  const visitedSeats = new Set<string>()
  const consider = (part: ConnectorData) => {
    const key = connectorInstallationKey(part)
    if (visitedSeats.has(key)) return
    visitedSeats.add(key)
    const status = validate(part, [...connectors, ...made])
    if (status.occupied) skipped++
    else if (status.reason === 'equipment') blocked++
    else if (!status.allowed) unbolted++
    else made.push({ ...part, id: nextId('c') })
  }
  for (const p of [...profiles].sort((a, b) => a.id.localeCompare(b.id))) {
    const tr = trims.get(p.id)
    if (!tr) continue
    const { start, end } = getProfileEndpoints(p)
    for (const [where, at] of [[tr.start, start], [tr.end, end]] as const) {
      if (type === 'corner-3way') {
        for (const seat of endCornerSeats(at, profiles)) consider({ id: 'candidate', type, ...seat })
        continue
      }
      if (entry.fit === 'corner') {
        for (const { a, b, at: joint } of jointPartnersAt(at, p, profiles)) {
          const key = JSON.stringify([a.id, b.id])
          if (visitedPairs.has(key)) continue
          visitedPairs.add(key)
          const candidates = seatsFor(type, a, b, joint)
            .filter((s) => auditBrackets(profiles, [{ id: 'candidate', type, ...s }], trims).length === 0)
          if (!candidates.length) { unbolted++; continue }
          // Reversing an asymmetric inner bracket is an alternative at the same slot.
          const slots: Array<typeof candidates> = []
          for (const seat of candidates) {
            const group = slots.find(alternatives => new THREE.Vector3(...alternatives[0].position)
              .distanceTo(new THREE.Vector3(...seat.position)) < 1)
            if (group) group.push(seat)
            else slots.push([seat])
          }
          for (const alternatives of slots) {
            const available = alternatives.map(seat => ({ id: 'candidate', type, ...seat }))
            const selected = available.find(c => { const status = validate(c, [...connectors, ...made]); return status.allowed || status.occupied }) ?? available[0]
            consider(selected)
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

      let position: [number, number, number]
      let quaternion: [number, number, number, number]
      let series: ConnectorSeries
      if (cap) {
        position = cap.position
        quaternion = cap.quaternion
        series = cap.series
      } else if (entry.fit === 'inline' && entry.axes.towards === 'in') {
        // Manual and automatic placement align the physical top with the post end.
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
      consider({ id: 'candidate', type, series, position, quaternion, profileSpec: p.spec })
    }
  }

  if (made.length === 0 && repaired === 0) {
    useToolStore.getState().showToast([blocked ? t.toastAutoEquipmentBlocked(blocked)
      : unbolted ? t.toastAutoUnbolted(unbolted) : t.toastAutoNothingOpen, repairFeedback].filter(Boolean).join(' · '), 'info')
    return { placed: 0, skipped, removed: 0, unbolted, blocked, repaired, unresolved, reason: 'nothing-open' }
  }
  noteNext(`fit ${connectorLabel(type, useToolStore.getState().language)}`)
  if (!reportEditResult(store.commitDocument({ connectors: [...connectors, ...made] }))) {
    return { placed: 0, skipped, removed: 0, unbolted, blocked, repaired: 0, unresolved, reason: 'edit-rejected' }
  }
  useToolStore.getState().showToast([t.toastAutoConnected(made.length, skipped, 0, unbolted, blocked), repairFeedback].filter(Boolean).join(' · '), unbolted || blocked || unresolved ? 'info' : 'success')
  return { placed: made.length, skipped, removed: 0, unbolted, blocked, repaired, unresolved }
}
