import * as THREE from 'three'
import type { ProfileData, ProfileSpec } from '../store/useStore'
import { specDims } from './specUtils'
import { seriesOf } from './connectorCatalog'
import { getProfileDir, getProfileEndpoints, closestOnSegment, crossExtentAlong } from './geometryCore'

/**
 * Whether two sections have an edge in common at all.
 *
 * A rough, spec-only test: a 2040 and a 4040 share their 40 side, a 2020 and a 2040 share
 * their 20 side, a 2020 and a 4040 share nothing. It says whether a joint between them
 * could ever line up — not whether the one that was actually drawn does.
 */
export function sharedEdge(a: ProfileSpec, b: ProfileSpec): boolean {
  const da = specDims(a), db = specDims(b)
  return [da.w, da.h].some((v) => v === db.w || v === db.h)
}

export function crossesSeries(a: ProfileSpec, b: ProfileSpec): boolean {
  return seriesOf(a) !== seriesOf(b)
}

/**
 * The direction a corner bracket's back would face at a joint between these two members.
 *
 * A bracket is a flat plate bent at ninety degrees: one leg lies in a slot along one member,
 * the other in a slot along the other. Both legs are in the same plane, so that plane is
 * perpendicular to both member axes — which leaves the cross product, and only that.
 * Parallel members have no such corner.
 */
export function bracketNormal(a: ProfileData, b: ProfileData): THREE.Vector3 | null {
  const n = new THREE.Vector3().crossVectors(getProfileDir(a), getProfileDir(b))
  if (n.lengthSq() < 1e-6) return null
  return n.normalize()
}

/** how far two faces may sit apart and still take one flat bracket (mm) */
const FLUSH_TOL = 0.5

/**
 * Where a flat bracket can lie across this joint, if anywhere.
 *
 * Each member offers two faces perpendicular to `n`, at its centreline plus and minus its
 * half section. The bracket needs one face from each that are the same plane — that is what
 * "the two profiles share an edge" means once the parts are actually placed, and it is why a
 * rail centred on a wider post does not work while the same rail pushed flush to one of the
 * post's faces does.
 */
export function flushFace(a: ProfileData, b: ProfileData, at: THREE.Vector3): { normal: THREE.Vector3; offset: number } | null {
  const n0 = bracketNormal(a, b)
  if (!n0) return null
  const ea = crossExtentAlong(a, n0)
  const eb = crossExtentAlong(b, n0)
  // both centrelines pass through the joint, so measure each from its own axis
  const aAxis = new THREE.Vector3(...a.position).sub(at)
  const bAxis = new THREE.Vector3(...b.position).sub(at)
  const aBase = aAxis.clone().projectOnVector(n0).dot(n0)
  const bBase = bAxis.clone().projectOnVector(n0).dot(n0)

  // the plate lies on the shared plane, measured along n0 from the joint point; when both
  // sides are flush, take the one furthest out, which is the face a tool can actually reach
  let best: { normal: THREE.Vector3; offset: number } | null = null
  for (const sa of [1, -1]) {
    for (const sb of [1, -1]) {
      const fa = aBase + sa * ea
      const fb = bBase + sb * eb
      if (Math.abs(fa - fb) > FLUSH_TOL) continue
      if (!best || Math.abs(fa) > Math.abs(best.offset)) best = { normal: n0.clone(), offset: fa }
    }
  }
  return best
}

export type MismatchKind = 'face' | 'series'

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
 * Joints that no flat bracket can be bolted across.
 *
 * A joint is an end of one member landing on another member — the same shape the trimming
 * rules work on. Members running parallel are skipped: they meet end to end or side by side,
 * which is a plate's job, not a bracket's.
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
      const touch = [ea.start, ea.end]
        .map((pt) => ({ pt, d: closestOnSegment(pt, eb.start, eb.end).point.distanceTo(pt) }))
        .sort((x, y) => x.d - y.d)[0]
      if (touch.d > JOINT_TOL) continue
      if (!bracketNormal(a, b)) continue          // parallel: not a bracket joint

      // Two conditions, and both have to hold. The sections must have an edge in common,
      // or the bracket has no edge to line up to and no hole pattern that matches; and the
      // parts as placed must present that edge to each other, which is what a plate lying
      // flat across the corner means. A 2020 pushed against one face of a 4040 satisfies the
      // second and still fails the first.
      const kind: MismatchKind | null = !sharedEdge(a.spec, b.spec) || !flushFace(a, b, touch.pt) ? 'face'
        : crossesSeries(a.spec, b.spec) ? 'series'
        : null
      if (!kind) continue

      const key = [a.id, b.id].sort().join('|')
      const seen = worst.get(key)
      if (seen && !(seen.kind === 'series' && kind === 'face')) continue
      worst.set(key, { a: a.id, b: b.id, specs: [a.spec, b.spec], kind, at: touch.pt.clone() })
    }
  }
  return [...worst.values()]
}
