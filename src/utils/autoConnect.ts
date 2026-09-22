import * as THREE from 'three'
import { useStore, type ConnectorData, type ProfileData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { analyzeFrame } from './analysis'
import { connectorEntry, seriesOf } from './connectorCatalog'
import { fitConnector } from './connectorFit'
import { closestOnSegment, getProfileDir, getProfileEndpoints } from './geometryCore'
import { flushFace } from './specCompat'
import { specDims } from './specUtils'
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
  const placedAt: THREE.Vector3[] = []

  const made: ConnectorData[] = []
  let skipped = 0
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

      // Sit the bracket on the faces it would actually be bolted to, not on the centreline
      // the joint is recorded at — a plate buried inside the profile is a marker, not a part.
      const partner = partnerAt(at, p, profiles)
      const face = partner ? flushFace(p, partner, at) : null
      const spot = at.clone()
      if (face) spot.addScaledVector(face.normal, face.offset)
      // step back along this member for each part already sitting on the same point
      const crowd = placedAt.filter((v) => v.distanceTo(at) <= OCCUPIED_MM).length
      if (crowd > 0) spot.addScaledVector(getProfileDir(p), (where === tr.start ? 1 : -1) * crowd * specDims(p.spec).w)
      const placement = fitConnector(type, at, profiles, null)
      made.push({
        id: nextId('c'),
        type,
        series: placement.series ?? seriesOf(p.spec),
        position: [spot.x, spot.y, spot.z],
        quaternion: placement.quaternion,
      })
      placedAt.push(at.clone())
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
    useToolStore.getState().showToast(t.toastAutoNothingOpen, 'info')
    return { placed: 0, skipped, reason: 'nothing-open' }
  }
  if (stale.length > 0) store.removeConnectors(stale, made.length === 0)
  if (made.length > 0) store.addItems([], made, false)
  useToolStore.getState().showToast(t.toastAutoConnected(made.length, skipped, stale.length), 'success')
  return { placed: made.length, skipped, removed: stale.length }
}
