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
  /** why nothing was placed, when nothing was */
  reason?: 'no-frame' | 'needs-a-surface' | 'nothing-open'
}

/**
 * Add missing connectors to compatible inferred joints and free ends.
 * Use fitConnector for placement and the host member for the series. Face-mounted types require explicit placement.
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
      const wanted = entry.fit === 'corner' ? where.butt : where.partners === 0
      if (!wanted) continue
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

  if (made.length === 0) {
    useToolStore.getState().showToast(t.toastAutoNothingOpen, 'info')
    return { placed: 0, skipped, reason: 'nothing-open' }
  }
  store.addItems([], made, false)
  useToolStore.getState().showToast(t.toastAutoConnected(made.length, skipped), 'success')
  return { placed: made.length, skipped }
}
