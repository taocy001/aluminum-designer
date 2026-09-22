import * as THREE from 'three'
import { useStore, type ConnectorData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { analyzeFrame } from './analysis'
import { connectorEntry, seriesOf } from './connectorCatalog'
import { fitConnector } from './connectorFit'
import { getProfileDir, getProfileEndpoints } from './geometryCore'
import { specDims } from './specUtils'
import { nextId } from './profileFactory'
import { translations } from './translations'

/** a joint already has a part if one sits within this of it (mm) */
const OCCUPIED_MM = 30

export interface AutoConnectResult {
  placed: number
  /** joints that already had something on them */
  skipped: number
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

      const placement = fitConnector(type, at, profiles, null)
      // step back along this member for each part already sitting on the same point
      const crowd = placedAt.filter((v) => v.distanceTo(at) <= OCCUPIED_MM).length
      const inward = (where === tr.start ? 1 : -1) * crowd * specDims(p.spec).w
      const spot = at.clone().addScaledVector(getProfileDir(p), inward)
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
