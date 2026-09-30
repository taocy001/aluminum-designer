import * as THREE from 'three'
import type { ConnectorData, FittingData, PanelData, ProfileData } from '../store/useStore'
import { findConflicts } from './analysis'
import { computeAllTrims, computeTrims, trimmedBox, type ProfileTrims } from './jointUtils'
import { closestOnSegment, getProfileAxis, getProfileDir, getProfileEndpoints } from './geometryCore'
import { memberBox } from './dragSnap'
import { unflushPairs } from './faceAlign'
import { findSpecMismatches, sharedEdge, crossesSeries, flushFace } from './specCompat'
import type { Joint } from './repairJoints'
import { auditBrackets, seatFor } from './bracketSeat'
import { fittingSolids } from './fittingGeometry'
import { lowestPointY, MIN_LENGTH } from './profileFactory'
import { panelBox, shelfEdges, type ShelfEdge } from './shelfSupport'
import { specDims } from './specUtils'
import type { OBB } from './obb'

export interface SuggestDoc {
  profiles: ProfileData[]
  connectors: ConnectorData[]
  panels: PanelData[]
  fittings: FittingData[]
}

/** What a suggestion says it does, so it can be held to it */
export type Claim =
  | { kind: 'shelf'; panelId: string; edge: ShelfEdge }
  /** both ends join something */
  | { kind: 'close'; hardwareId?: string }
  /** one end joins something, the other is left for the next member */
  | { kind: 'open' }

export interface Verdict { ok: boolean; why?: string }
/** A single suggestion search holds an immutable document. Reuse its existing checks
 * across candidates with the same neighbours; every proposed result is still checked. */
export type VetCache = Map<string, Map<string, unknown>>

/** Share a geometry check whose inputs are identical even when unrelated panels or
 * fittings change the wider neighbourhood key. The cache lives for one search only. */
export function cachedCheck<T>(cache: VetCache | undefined, name: string, parts: Array<Array<{ id: string }>>, calculate: () => T): T {
  if (!cache) return calculate()
  const key = JSON.stringify([name, ...parts.map((items) => items.map((item) => item.id))])
  const entry = cache.get(key)
  if (entry?.has('value')) return entry.get('value') as T
  const value = calculate()
  cache.set(key, new Map([['value', value]]))
  return value
}

/** how far round a new member anything it could disturb can be (mm) */
export const NEIGHBOURHOOD = 250
/** an end this close to the ground is standing on it (mm) */
const FLOOR_EPS = 1

/** The exact same directed endpoint joints as joints(after), restricted to the new member.
 * Neither check below uses joints between two existing members, so enumerating those again
 * would add quadratic work without changing either verdict. */
function memberJoints(member: ProfileData, profiles: ProfileData[]): Joint[] {
  const out: Joint[] = [], own = getProfileEndpoints(member), direction = getProfileDir(member)
  for (const p of profiles) {
    if (p.id === member.id || Math.abs(direction.dot(getProfileDir(p))) > 0.9) continue
    const other = getProfileEndpoints(p)
    for (const at of [own.start, own.end]) if (closestOnSegment(at, other.start, other.end).point.distanceTo(at) <= 30) out.push({ a: member, b: p, at })
    for (const at of [other.start, other.end]) if (closestOnSegment(at, own.start, own.end).point.distanceTo(at) <= 30) out.push({ a: p, b: member, at })
  }
  return out
}

function obbBox(o: OBB): THREE.Box3 {
  const r = new THREE.Vector3()
  for (let k = 0; k < 3; k++) {
    const h = o.half.getComponent(k)
    r.x += Math.abs(o.axes[k].x) * h; r.y += Math.abs(o.axes[k].y) * h; r.z += Math.abs(o.axes[k].z) * h
  }
  return new THREE.Box3(o.center.clone().sub(r), o.center.clone().add(r))
}

/** everything close enough to the new member to be affected by it */
export function neighbourhood(member: ProfileData, doc: SuggestDoc, cache?: VetCache): SuggestDoc {
  const box = memberBox(member).expandByScalar(NEIGHBOURHOOD)
  // A search holds one immutable document. Its unchanged world bounds are identical
  // for every candidate; the candidate box and all four original filters stay fresh.
  const geometry = cachedCheck(cache, 'neighbourhood-geometry', [doc.profiles, doc.connectors, doc.panels, doc.fittings], () => ({
    profiles: doc.profiles.map((p) => ({ part: p, box: memberBox(p) })),
    connectors: doc.connectors.map((c) => ({ part: c, point: new THREE.Vector3(...c.position) })),
    panels: doc.panels.map((b) => ({ part: b, box: panelBox(b) })),
    // Both fitting states are evaluated, including fronts outside their openings.
    fittings: doc.fittings.map((f) => ({ part: f,
      boxes: [...fittingSolids(f, 0), ...fittingSolids(f, 1)].map(obbBox) })),
  }))
  return {
    profiles: geometry.profiles.filter((p) => p.box.intersectsBox(box)).map((p) => p.part),
    connectors: geometry.connectors.filter((c) => box.containsPoint(c.point)).map((c) => c.part),
    panels: geometry.panels.filter((b) => b.box.intersectsBox(box)).map((b) => b.part),
    fittings: geometry.fittings.filter((f) => f.boxes.some((bounds) => bounds.intersectsBox(box))).map((f) => f.part),
  }
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

/** what one member gives up at a joint and nothing else fills: the example drawings' test */
export function emptyCorners(profiles: ProfileData[], trims: Map<string, ProfileTrims>): Set<string> {
  const solid = profiles.map((p) => ({ id: p.id, box: trimmedBox(p, trims.get(p.id)!) }))
  const out = new Set<string>()
  for (const p of profiles) {
    const t = trims.get(p.id)!
    const { start, end } = getProfileEndpoints(p)
    const dir = end.clone().sub(start).normalize()
    for (const [name, tip, cut, sign] of [['start', start, t.start.trim, 1], ['end', end, t.end.trim, -1]] as const) {
      if (cut <= 0.5) continue
      const probe = tip.clone().addScaledVector(dir, sign * cut / 2)
      if (!solid.some((s) => s.id !== p.id && s.box.containsPoint(probe))) out.add(`${p.id}:${name}`)
    }
  }
  return out
}

function grew(before: Set<string>, after: Iterable<string>): string | null {
  for (const k of after) if (!before.has(k)) return k
  return null
}

/**
 * Compare the candidate neighbourhood before and after insertion using the checks below,
 * including fitting geometry at sampled open positions.
 */
export function vet(member: ProfileData, claim: Claim, doc: SuggestDoc, frame?: THREE.Box3 | null, cache?: VetCache): Verdict {
  const { w, h } = specDims(member.spec)
  if (member.length < Math.max(MIN_LENGTH, 2 * Math.max(w, h))) return { ok: false, why: 'short' }
  if (lowestPointY(member) < -0.5) return { ok: false, why: 'floor' }
  if (frame) {
    const { start, end } = getProfileEndpoints(member)
    // its centreline stays within the cabinet it belongs to — to within its own section, which
    // is how far the outer member the drawing is still missing would stand out
    const room = frame.clone().expandByScalar(Math.max(w, h) / 2 + 0.5)
    if (!room.containsPoint(start) || !room.containsPoint(end)) return { ok: false, why: 'outside' }
  }

  const near = neighbourhood(member, doc, cache)
  const after = [...near.profiles, member]
  const key = JSON.stringify([near.profiles, near.connectors, near.panels, near.fittings].map((parts) => parts.map((part) => part.id)))
  const baseline = cache?.get(key) ?? new Map<string, unknown>()
  cache?.set(key, baseline)
  const once = <T,>(name: string, calculate: () => T): T => {
    if (baseline.has(name)) return baseline.get(name) as T
    const value = calculate()
    baseline.set(name, value)
    return value
  }

  // pairs no part is made for are neither suggested nor counted
  const candidateJoints = memberJoints(member, near.profiles)
  for (const j of candidateJoints) {
    if (!sharedEdge(j.a.spec, j.b.spec)) return { ok: false, why: 'no-shared-edge' }
  }

  // Reject unanchored candidates using their own trim calculation before recalculating
  // every existing member. Accepted candidates still receive all after checks.
  const mine = computeTrims(member, after)
  if (mine.cutLength < Math.max(MIN_LENGTH, 2 * Math.max(w, h))) return { ok: false, why: 'short' }

  // what the member claims to join
  const axis = getProfileAxis(member)
  const { start, end } = getProfileEndpoints(member)
  const foot = (pt: THREE.Vector3) => axis === 'y' && pt.y <= FLOOR_EPS
  const sJoined = mine.start.partners > 0 || foot(start)
  const eJoined = mine.end.partners > 0 || foot(end)
  if (claim.kind === 'close' && !(sJoined && eJoined)) return { ok: false, why: 'loose-end' }
  if (claim.kind === 'open' && !(sJoined || eJoined)) return { ok: false, why: 'loose' }
  if (claim.kind === 'shelf' && !(mine.start.partners > 0 && mine.end.partners > 0)) return { ok: false, why: 'loose-end' }

  const tb = once('trims', () => cachedCheck(cache, 'trims', [near.profiles], () => computeAllTrims(near.profiles)))
  const ta = computeAllTrims(after)

  // (a) nothing new passes through anything, shut and open
  const clashes = (ps: ProfileData[], t: Map<string, ProfileTrims>, fs: FittingData[]) =>
    new Set(findConflicts(ps, t, near.connectors, near.panels, fs).map((c) => pairKey(c.a, c.b)))
  let g = grew(once('closed-clashes', () => clashes(near.profiles, tb, near.fittings)), clashes(after, ta, near.fittings))
  if (g) return { ok: false, why: `clash ${g}` }
  const opened = near.fittings.map((f) => ({ ...f, open: 1 }))
  if (opened.length) {
    g = grew(once('open-clashes', () => clashes(near.profiles, tb, opened)), clashes(after, ta, opened))
    if (g) return { ok: false, why: `clash-open ${g}` }
  }

  // (c) every joint it makes can be bolted
  if (candidateJoints.some((j) => sharedEdge(j.a.spec, j.b.spec) && !seatFor('bracket', j.a, j.b, j.at))) return { ok: false, why: 'unbuildable' }

  // (d) nothing that could be bolted before stops being boltable
  // These two checks depend only on each pair's untrimmed geometry. Adding a member
  // cannot alter any existing pair, so every new failure must involve that member.
  // Preserve the full check's insertion order: old→new first, then new→old.
  const pairs = near.profiles.map((p, i) => ({ p, i })).filter(({ p }) => sharedEdge(p.spec, member.spec))
  const unflush = pairs.flatMap(({ p, i }) => unflushPairs([p, member]).map((u) => ({
    key: pairKey(u.a, u.b), order: i + (u.a === member.id ? near.profiles.length : 0),
  }))).sort((a, b) => a.order - b.order)
  if (unflush.length) return { ok: false, why: `unflush ${unflush[0].key}` }
  // a joint between two series is a note, not a fault — the drawing it copies has the same
  // ones — but faces that do not meet are a joint nothing can bolt
  const mismatches = pairs.flatMap(({ p, i }) => {
    const faults = findSpecMismatches([p, member]).filter((m) => m.kind === 'face')
    if (!faults.length) return []
    // A forward series note upgraded to a reverse face fault keeps its original Map
    // insertion place. Check that first direction independently to retain that ordering.
    const ends = getProfileEndpoints(p)
    const touch = [ends.start, ends.end].map((pt) => ({ pt,
      d: closestOnSegment(pt, start, end).point.distanceTo(pt) })).sort((a, b) => a.d - b.d)[0]
    const forward = touch.d <= 30 && (crossesSeries(p.spec, member.spec) || !flushFace(p, member, touch.pt))
    return faults.map((m) => ({ key: pairKey(m.a, m.b), order: i + (forward ? 0 : near.profiles.length) }))
  }).sort((a, b) => a.order - b.order)
  if (mismatches.length) return { ok: false, why: `mismatch ${mismatches[0].key}` }
  if (near.connectors.length) {
    const before = once('brackets', () => cachedCheck(cache, 'brackets', [near.profiles, near.connectors], () => new Set(auditBrackets(near.profiles, near.connectors, tb).map((f) => f.id))))
    const now = new Set(auditBrackets(after, near.connectors, ta).map((f) => f.id))
    g = grew(before, now)
    if (g) return { ok: false, why: `bracket ${g}` }
    if (claim.kind === 'close' && claim.hardwareId
      && (!before.has(claim.hardwareId) || now.has(claim.hardwareId))) return { ok: false, why: 'hardware-not-restored' }
  } else if (claim.kind === 'close' && claim.hardwareId) {
    return { ok: false, why: 'hardware-not-restored' }
  }

  // no corner is left empty
  g = grew(once('empty-corners', () => emptyCorners(near.profiles, tb)), emptyCorners(after, ta))
  if (g) return { ok: false, why: `empty-corner ${g}` }

  // (g) a shelf rail carries the edge it was offered for, and no shelf loses one
  if (near.panels.length) {
    const was = once('shelves', () => new Set(shelfEdges(near.panels, near.profiles, tb).filter((e) => e.carried).map((e) => `${e.panelId}:${e.edge}`)))
    const now = new Set(shelfEdges(near.panels, after, ta).filter((e) => e.carried).map((e) => `${e.panelId}:${e.edge}`))
    for (const k of was) if (!now.has(k)) return { ok: false, why: `shelf-lost ${k}` }
    if (claim.kind === 'shelf' && !now.has(`${claim.panelId}:${claim.edge}`)) return { ok: false, why: 'shelf-not-carried' }
  } else if (claim.kind === 'shelf') {
    return { ok: false, why: 'shelf-not-carried' }
  }
  return { ok: true }
}
