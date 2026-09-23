import { noteNext } from './opLog'
import * as THREE from 'three'
import { useStore, type ConnectorData, type ProfileData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { analyzeFrame } from './analysis'
import { connectorEntry, connectorLabel, seriesOf, type ConnectorSeries } from './connectorCatalog'
import { fitConnector } from './connectorFit'
import { closestOnSegment, getProfileEndpoints } from './geometryCore'
import { flushFace, sharedEdge } from './specCompat'
import { seatFor } from './bracketSeat'
import { nextId } from './profileFactory'
import { translations } from './translations'

/** a joint already has a part if one sits within this of it (mm) */
const OCCUPIED_MM = 30
/** how close an end has to be to another member's centreline to be its joint partner (mm) */
const PARTNER_TOL = 30

/** The member this end butts into: the nearest one whose centreline it lands on */
function partnerAt(at: THREE.Vector3, self: ProfileData, profiles: ProfileData[]): ProfileData | null {
  let best: { p: ProfileData; d: number } | null = null
  for (const q of profiles) {
    if (q.id === self.id) continue
    const { start, end } = getProfileEndpoints(q)
    const d = closestOnSegment(at, start, end).point.distanceTo(at)
    if (d > PARTNER_TOL) continue
    if (!best || d < best.d) best = { p: q, d }
  }
  return best?.p ?? null
}

export interface AutoConnectResult {
  placed: number
  /** joints that already had something on them */
  skipped: number
  /** parts of this type left stranded by a member that moved, cleared away */
  removed?: number
  /** joints that want one and cannot take one: no line is a slot on both members */
  unbolted?: number
  /** why nothing was placed, when nothing was */
  reason?: 'no-frame' | 'needs-a-surface' | 'nothing-open'
}

/**
 * Put the held connector on every joint that wants one and has not got one.
 *
 * The frame already knows where its joints are: trimming marks each end as butting against
 * something, continuing through, or free. A corner bracket belongs on a butt, an end cap or
 * a foot on a free end. Parts that go on a flat face are left alone — which face they sit on
 * is a choice nobody can make from the geometry alone.
 *
 * Orientation comes from the same `fitConnector` used when a part is dropped by hand, and
 * the series from the member it lands on, so a 40-series corner gets a 40-series bracket.
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

  // Every joint of this kind the frame has, whether or not something sits on it. Moving a
  // member leaves its bracket behind in mid-air, and since a bracket cannot be dragged back
  // this is where it gets cleared: one press puts the hardware back where the frame is now.
  const wanted: THREE.Vector3[] = []

  const { trims } = analyzeFrame(profiles)
  // Only parts that were already there block a joint. Two rails butting into the same post
  // is two joints and takes two brackets, one on each rail — deduping by point would order
  // half the hardware. The second one is nudged along its own member so it reads as its own
  // part rather than sitting inside the first.
  const existing = connectors.map((c) => new THREE.Vector3(...c.position))
  const isFree = (v: THREE.Vector3) => !existing.some((p) => p.distanceTo(v) <= OCCUPIED_MM)

  const made: ConnectorData[] = []
  let skipped = 0
  /** joints that want this part but offer it nowhere to bolt */
  let unbolted = 0
  for (const p of profiles) {
    const tr = trims.get(p.id)
    if (!tr) continue
    const { start, end } = getProfileEndpoints(p)
    for (const [where, at] of [[tr.start, start], [tr.end, end]] as const) {
      // a corner bracket goes where an end butts into something; a cap or a foot where
      // nothing is attached at all
      const wantsOne = entry.fit === 'corner' ? where.butt : where.partners === 0
      if (!wantsOne) continue
      wanted.push(at.clone())
      if (!isFree(at)) { skipped++; continue }

      // Where the part goes is a question about bolts, not about points. `seatBracket` puts
      // the back on the face the two members share and each hole on a slot line; a part
      // dropped on the centreline is a marker, not something that can be fitted.
      const partner = partnerAt(at, p, profiles)
      const seat = partner ? seatFor(type, p, partner, at) : null
      let position: [number, number, number]
      let quaternion: [number, number, number, number]
      let series: ConnectorSeries
      if (seat) {
        position = seat.position
        quaternion = seat.quaternion
        series = seat.series
      } else if (partner && connectorEntry(type)?.isCornerBracket) {
        // There is a joint here and this part cannot be bolted to it. Putting one there
        // anyway makes a drawing that cannot be built and a cut list that has been paid for,
        // so it is skipped. Sections with no edge in common are not a fault to be reported —
        // they are simply not a joint these parts make, and the frame check already says so.
        if (sharedEdge(p.spec, partner.spec)) unbolted++
        continue
      } else {
        // caps, feet and the like sit on an end, where there is no second member to line up to
        const face = partner ? flushFace(p, partner, at) : null
        const spot = at.clone()
        if (face) spot.addScaledVector(face.normal, face.offset)
        const placement = fitConnector(type, at, profiles, null)
        position = [spot.x, spot.y, spot.z]
        quaternion = placement.quaternion
        series = placement.series ?? seriesOf(p.spec)
      }
      // Two rails butting into the same post used to be stepped apart along their own
      // members so they did not draw inside each other. They do not need it: their planes
      // are the cross products of two different pairs of axes, so they already land on
      // different faces of the post. The step only pushed them off their slots.
      made.push({ id: nextId('c'), type, series, position, quaternion })
    }
  }

  // A part of this type sitting at no joint at all is left over from a member that has since
  // moved. Other types are somebody's deliberate choice and are not ours to remove.
  const stale = connectors
    .filter((c) => c.type === type && !c.locked)
    .filter((c) => {
      const v = new THREE.Vector3(...c.position)
      return !wanted.some((w) => w.distanceTo(v) <= OCCUPIED_MM * 2)
    })
    .map((c) => c.id)

  if (made.length === 0 && stale.length === 0) {
    useToolStore.getState().showToast(unbolted ? t.toastAutoUnbolted(unbolted) : t.toastAutoNothingOpen, 'info')
    return { placed: 0, skipped, unbolted, reason: 'nothing-open' }
  }
  noteNext(`fit ${connectorLabel(type, useToolStore.getState().language)}`)
  if (stale.length > 0) store.removeConnectors(stale, made.length === 0)
  if (made.length > 0) store.addItems([], made, false)
  useToolStore.getState().showToast(t.toastAutoConnected(made.length, skipped, stale.length, unbolted), unbolted ? 'info' : 'success')
  return { placed: made.length, skipped, removed: stale.length, unbolted }
}
