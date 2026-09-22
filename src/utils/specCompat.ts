import * as THREE from 'three'
import type { ProfileData, ProfileSpec } from '../store/useStore'
import { specDims } from './specUtils'
import { seriesOf } from './connectorCatalog'
import { getProfileEndpoints, closestOnSegment } from './geometryCore'

/**
 * Whether two profiles can be bolted to each other at a joint.
 *
 * Extrusions are joined end-to-face with a bracket, and the bracket only sits flat if the
 * two sections share an edge: a 2040 meets a 4040 on their common 40 side, a 2020 meets the
 * 20 side of a 2040. A 2020 on a 4040 has nothing in common — it lands in the middle of a
 * 40 mm face with no edge to line up to and no hole pattern that matches.
 *
 * This is about the faces lining up. Slot width is a second, separate constraint: the 20
 * series runs a 6 mm slot and M5, the 30 and 40 series an 8 mm slot and M6/M8, and a nut
 * for one does not work in the other — so a joint that crosses series needs a bracket and
 * fasteners for each side, which is worth saying out loud even when the edges do match.
 */
export function sharedEdge(a: ProfileSpec, b: ProfileSpec): boolean {
  const da = specDims(a), db = specDims(b)
  return [da.w, da.h].some((v) => v === db.w || v === db.h)
}

export function crossesSeries(a: ProfileSpec, b: ProfileSpec): boolean {
  return seriesOf(a) !== seriesOf(b)
}

export type MismatchKind = 'edge' | 'series'

export interface SpecMismatch {
  a: string
  b: string
  specs: [ProfileSpec, ProfileSpec]
  kind: MismatchKind
  /** where the two meet, for the marker */
  at: THREE.Vector3
}

/** how close an end has to be to the other member's centreline to count as a joint (mm) */
const JOINT_TOL = 30

/**
 * Joints whose two members cannot be bolted together as drawn.
 *
 * A joint is an end of one member landing on another member's centreline — the same shape
 * the trimming rules work on. Only one entry per pair: the worst problem wins, since a pair
 * that shares no edge is already a bigger problem than one that merely crosses series.
 */
export function findSpecMismatches(profiles: ProfileData[]): SpecMismatch[] {
  const worst = new Map<string, SpecMismatch>()
  const ends = new Map<string, { start: THREE.Vector3; end: THREE.Vector3 }>()
  for (const p of profiles) ends.set(p.id, getProfileEndpoints(p))

  for (const a of profiles) {
    const ea = ends.get(a.id)!
    for (const b of profiles) {
      if (a.id === b.id) continue
      const eb = ends.get(b.id)!
      const touches = [ea.start, ea.end].some((pt) => closestOnSegment(pt, eb.start, eb.end).point.distanceTo(pt) <= JOINT_TOL)
      if (!touches) continue

      const kind: MismatchKind | null = !sharedEdge(a.spec, b.spec) ? 'edge'
        : crossesSeries(a.spec, b.spec) ? 'series'
        : null
      if (!kind) continue

      const key = [a.id, b.id].sort().join('|')
      const seen = worst.get(key)
      if (seen && !(seen.kind === 'series' && kind === 'edge')) continue
      const pt = [ea.start, ea.end]
        .map((p) => ({ p, d: closestOnSegment(p, eb.start, eb.end).point.distanceTo(p) }))
        .sort((x, y) => x.d - y.d)[0].p
      worst.set(key, { a: a.id, b: b.id, specs: [a.spec, b.spec], kind, at: pt.clone() })
    }
  }
  return [...worst.values()]
}
