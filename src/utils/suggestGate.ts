import * as THREE from 'three'
import type { ConnectorData, EquipmentData, FittingData, PanelData, ProfileData } from '../store/useStore'
import { createConflictFinder, findConflicts, trimmedOBB } from './analysis'
import { equipmentClearance } from './equipmentGeometry'
import { findEquipmentConflicts } from './equipmentChecks'
import { computeAllTrims, getThroughRule, trimmedBox, type ProfileTrims } from './jointUtils'
import { closestOnSegment, getProfileAxis, getProfileDir, getProfileEndpoints } from './geometryCore'
import { memberBox } from './dragSnap'
import { unflushPairs } from './faceAlign'
import type { Joint } from './repairJoints'
import { auditBrackets } from './bracketSeat'
import { cachedHardwareSupports } from './connectorAuditCache'
import { unsupportedProfileJoint } from './connectorSupport'
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
  equipment?: EquipmentData[]
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
const searchPartKeys = new WeakMap<VetCache, WeakMap<Array<{ id: string }>, string>>()
const searchSnapshots = new WeakMap<VetCache, string>()
const searchIds = new WeakMap<VetCache, Map<string, number>>()
const publicSnapshots = new WeakMap<VetCache, string>()
const documentSnapshot = (doc: SuggestDoc) => JSON.stringify([doc.profiles, doc.connectors,
  doc.panels, doc.fittings, doc.equipment ?? [], getThroughRule()])

/** Internal synchronous search context. Refresh it whenever the generator resumes. */
export function createVetSearchCache(doc: SuggestDoc): VetCache {
  const cache: VetCache = new Map()
  searchSnapshots.set(cache, documentSnapshot(doc))
  return cache
}

export function refreshVetSearchCache(cache: VetCache, doc: SuggestDoc): void {
  const snapshot = documentSnapshot(doc)
  if (searchSnapshots.get(cache) !== snapshot) {
    cache.clear(); searchPartKeys.delete(cache); searchIds.delete(cache)
    searchSnapshots.set(cache, snapshot)
  }
}

function validatePublicCache(cache: VetCache | undefined, doc: SuggestDoc): void {
  if (!cache || searchSnapshots.has(cache)) return
  const snapshot = documentSnapshot(doc)
  if (publicSnapshots.get(cache) !== snapshot) {
    cache.clear(); searchPartKeys.delete(cache); searchIds.delete(cache)
    publicSnapshots.set(cache, snapshot)
  }
}

/** Share a geometry check whose inputs are identical even when unrelated panels or
 * fittings change the wider neighbourhood key. The cache lives for one search only. */
export function cachedCheck<T>(cache: VetCache | undefined, name: string, parts: Array<Array<{ id: string }>>, calculate: () => T): T {
  if (!cache) return calculate()
  if (!searchSnapshots.has(cache)) {
    const key = JSON.stringify([name, parts, getThroughRule()])
    const entry = cache.get(key)
    if (entry?.has('value')) return entry.get('value') as T
    const value = calculate()
    cache.set(key, new Map([['value', value]]))
    return value
  }
  let ids = searchIds.get(cache)
  if (!ids) { ids = new Map(); searchIds.set(cache, ids) }
  let signatures = searchPartKeys.get(cache)
  if (!signatures) { signatures = new WeakMap(); searchPartKeys.set(cache, signatures) }
  // These arrays belong to one immutable search. Reuse their ID lists without
  // repeatedly serializing the entire document for each candidate.
  const key = `[${[JSON.stringify(name), ...parts.map((items) => {
    let signature = signatures!.get(items)
    if (signature === undefined) {
      signature = JSON.stringify(items.map((item) => {
        let id = ids!.get(item.id)
        if (id === undefined) { id = ids!.size; ids!.set(item.id, id) }
        return id
      }))
      signatures!.set(items, signature)
    }
    return signature
  })].join(',')}]`
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

/** Directed endpoint joints involving the new member. Existing pairs are checked
 * separately when insertion changes their cut bodies. */
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

interface NeighbourBounds {
  equipment: THREE.Box3[]
  profiles: THREE.Box3[]
  connectors: THREE.Vector3[]
  panels: THREE.Box3[]
  fittings: THREE.Box3[][]
}
const neighbourBoundsCache = new Map<string, NeighbourBounds>()

function documentBounds(doc: SuggestDoc): NeighbourBounds {
  const key = JSON.stringify([doc.profiles, doc.connectors, doc.panels, doc.fittings, doc.equipment ?? []])
  const cached = neighbourBoundsCache.get(key)
  if (cached) return cached
  const bounds = {
    equipment: (doc.equipment ?? []).map((e) => obbBox(equipmentClearance(e))),
    profiles: doc.profiles.map((p) => memberBox(p)),
    connectors: doc.connectors.map((c) => new THREE.Vector3(...c.position)),
    panels: doc.panels.map(panelBox),
    fittings: doc.fittings.map((f) => [...fittingSolids(f, 0), ...fittingSolids(f, 1)].map(obbBox)),
  }
  if (neighbourBoundsCache.size >= 8) neighbourBoundsCache.delete(neighbourBoundsCache.keys().next().value!)
  neighbourBoundsCache.set(key, bounds)
  return bounds
}

/** everything close enough to the new member to be affected by it */
export function neighbourhood(member: ProfileData, doc: SuggestDoc, cache?: VetCache): SuggestDoc {
  const box = memberBox(member).expandByScalar(NEIGHBOURHOOD)
  // Cache only numeric bounds; each result keeps the current document objects.
  const bounds = cachedCheck(cache, 'neighbourhood-geometry', [doc.profiles, doc.connectors, doc.panels, doc.fittings, doc.equipment ?? []], () => documentBounds(doc))
  return {
    equipment: (doc.equipment ?? []).filter((_part, i) => bounds.equipment[i].intersectsBox(box)),
    profiles: doc.profiles.filter((_part, i) => bounds.profiles[i].intersectsBox(box)),
    connectors: doc.connectors.filter((_part, i) => box.containsPoint(bounds.connectors[i])),
    panels: doc.panels.filter((_part, i) => bounds.panels[i].intersectsBox(box)),
    fittings: doc.fittings.filter((_part, i) => bounds.fittings[i].some((fitting) => fitting.intersectsBox(box))),
  }
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

const baselineConflictCache = new Map<string, Set<string>>()
const candidateTrimCache = new Map<string, ProfileTrims[]>()
const copyTrim = (t: ProfileTrims): ProfileTrims => ({ start: { ...t.start }, end: { ...t.end }, cutLength: t.cutLength })

/** A proposed member gets a fresh ID on every search. Its cut calculation depends
 * on geometry and manufacturing rules; keep numeric cuts and bind current IDs. */
function candidateTrims(profiles: ProfileData[], member: ProfileData, cache?: VetCache): Map<string, ProfileTrims> {
  const after = [...profiles, member]
  if (profiles.some((p) => p.id === member.id)) return computeAllTrims(after)
  const { id: _id, ...geometry } = member
  const baseline = cachedCheck(cache, 'trim-inputs', [profiles], () => JSON.stringify([profiles, getThroughRule()]))
  const key = `${baseline}|${JSON.stringify(geometry)}`
  const cached = candidateTrimCache.get(key)
  if (cached) return new Map(after.map((p, i) => [p.id, copyTrim(cached[i])]))
  const trims = computeAllTrims(after)
  if (candidateTrimCache.size >= 96) candidateTrimCache.delete(candidateTrimCache.keys().next().value!)
  candidateTrimCache.set(key, after.map((p) => copyTrim(trims.get(p.id)!)))
  return trims
}

/** Only existing geometry is shared between searches. Cut results and complete part
 * values make in-place edits, opening changes and manufacturing rules new snapshots. */
function baselineConflicts(doc: SuggestDoc, trims: Map<string, ProfileTrims>, fittings: FittingData[], affected: ReadonlySet<string>, conflicts: typeof findConflicts): Set<string> {
  const key = JSON.stringify([doc.profiles, doc.profiles.map((p) => trims.get(p.id)),
    doc.connectors, doc.panels, fittings, [...affected].sort()])
  const cached = baselineConflictCache.get(key)
  if (cached) return cached
  const result = new Set(conflicts(doc.profiles, trims, doc.connectors, doc.panels, fittings, affected)
    .map((c) => pairKey(c.a, c.b)))
  if (baselineConflictCache.size >= 32) baselineConflictCache.delete(baselineConflictCache.keys().next().value!)
  baselineConflictCache.set(key, result)
  return result
}

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

function grew(before: ReadonlySet<string>, after: Iterable<string>): string | null {
  for (const k of after) if (!before.has(k)) return k
  return null
}

/**
 * Compare the candidate neighbourhood before and after insertion using the checks below,
 * including fitting geometry at sampled open positions.
 */
export function vet(member: ProfileData, claim: Claim, doc: SuggestDoc, frame?: THREE.Box3 | null, cache?: VetCache): Verdict {
  validatePublicCache(cache, doc)
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
  const baseline = cachedCheck(cache, 'neighbourhood-baseline',
    [near.profiles, near.connectors, near.panels, near.fittings, near.equipment ?? []], () => new Map<string, unknown>())
  const once = <T,>(name: string, calculate: () => T): T => {
    if (baseline.has(name)) return baseline.get(name) as T
    const value = calculate()
    baseline.set(name, value)
    return value
  }

  const candidateJoints = memberJoints(member, near.profiles)
  const ta = candidateTrims(near.profiles, member, cache)
  if (candidateJoints.some((j) => unsupportedProfileJoint(j.a, j.b, j.at, ta))) return { ok: false, why: 'unbuildable' }

  // Compatibility, end anchoring and collision checks share these actual cut bodies.
  const mine = ta.get(member.id)!
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

  if (near.equipment?.length) {
    const clashes = (ps: ProfileData[], trims: Map<string, ProfileTrims>) => new Set(
      findEquipmentConflicts(near.equipment!, ps.map((p) => ({ id: p.id, obb: trimmedOBB(p, trims.get(p.id)!) })))
        .map((c) => `${c.kind}:${c.a}|${c.b}`))
    const added = grew(once('equipment-clashes', () => clashes(near.profiles, tb)), clashes(after, ta))
    if (added) return { ok: false, why: added }
  }

  // (a) nothing new passes through anything, shut and open
  // Only the added member and existing members whose cut bodies change can create
  // new collisions. All other part pairs retain the same geometry in both states.
  const changed = near.profiles.filter((p) => {
    const before = tb.get(p.id)!, after = ta.get(p.id)!
    return before.start.trim !== after.start.trim || before.cutLength !== after.cutLength
  }).map((p) => p.id)
  const changedKey = JSON.stringify([...changed].sort())
  const affectedBefore = new Set(changed), affectedAfter = new Set([...changed, member.id])
  const conflicts = cache ? cachedCheck(cache, 'conflict-geometry', [doc.profiles, doc.connectors, doc.panels, doc.fittings],
    () => createConflictFinder(doc.profiles, doc.connectors, doc.panels, doc.fittings)) : findConflicts
  const clashes = (ps: ProfileData[], t: Map<string, ProfileTrims>, fs: FittingData[], affected: ReadonlySet<string>) =>
    new Set(conflicts(ps, t, near.connectors, near.panels, fs, affected).map((c) => pairKey(c.a, c.b)))
  const beforeClashes = (name: string, fs: FittingData[]) => once(`${name}:${changedKey}`,
    () => changed.length ? baselineConflicts(near, tb, fs, affectedBefore, conflicts) : new Set<string>())
  const closedClashes = clashes(after, ta, near.fittings, affectedAfter)
  let g = closedClashes.size ? grew(beforeClashes('closed-clashes', near.fittings), closedClashes) : null
  if (g) return { ok: false, why: `clash ${g}` }
  const opened = near.fittings.map((f) => ({ ...f, open: 1 }))
  if (opened.length) {
    const openClashes = clashes(after, ta, opened, affectedAfter)
    g = openClashes.size ? grew(beforeClashes('open-clashes', opened), openClashes) : null
    if (g) return { ok: false, why: `clash-open ${g}` }
  }

  // New joints and existing joints with changed cut bodies need the same support check.
  const unflush = near.profiles.flatMap((p) => unflushPairs([p, member], ta))
  if (unflush.length) return { ok: false, why: `unflush ${pairKey(unflush[0].a, unflush[0].b)}` }
  if (changed.length) {
    const affectedPairs = near.profiles.flatMap((a, i) => near.profiles.slice(i + 1)
      .filter((b) => affectedBefore.has(a.id) || affectedBefore.has(b.id)).map((b) => [a, b]))
    const unsupported = (trims: Map<string, ProfileTrims>) => new Set(affectedPairs
      .flatMap((pair) => unflushPairs(pair, trims)).map((pair) => pairKey(pair.a, pair.b)))
    g = grew(once(`unflush:${changedKey}`, () => unsupported(tb)), unsupported(ta))
    if (g) return { ok: false, why: `unflush ${g}` }
  }
  if (near.connectors.length) {
    const before = once('brackets', () => cachedCheck(cache, 'brackets', [near.profiles, near.connectors], () => cachedHardwareSupports(near, tb).faults))
    // Adding support cannot invalidate an existing mounting face unless its profile
    // is shortened. Otherwise only the bracket claimed to be restored needs a check.
    const shortened = near.profiles.some((p) => {
      const b = tb.get(p.id)!, a = ta.get(p.id)!
      return a.start.trim > b.start.trim || a.start.trim + a.cutLength < b.start.trim + b.cutLength
    })
    const check = shortened ? near.connectors : near.connectors.filter((c) => claim.kind === 'close' && c.id === claim.hardwareId)
    const now = new Set(auditBrackets(after, check, ta).map((f) => f.id))
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
