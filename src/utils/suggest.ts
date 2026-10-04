import * as THREE from 'three'
import type { ConnectorData, ProfileData, ProfileSpec } from '../store/useStore'
import { getProfileAxis, getProfileDir, getProfileEndpoints, crossExtentAlong, type Axis } from './geometryCore'
import { memberBox } from './dragSnap'
import { buildProfile, prepareProfile } from './profileFactory'
import { shelfEdges, oppositeEdge, panelBox } from './shelfSupport'
import { vet, cachedCheck, createVetSearchCache, refreshVetSearchCache, NEIGHBOURHOOD, type Claim, type SuggestDoc, type VetCache } from './suggestGate'
import { cachedHardwareSupports } from './connectorAuditCache'
import { computeAllTrims, getThroughRule } from './jointUtils'

export type { SuggestDoc } from './suggestGate'

/**
 * Generate candidate members from shelf edges, matching parallel members and repeated members.
 * Reuse existing section, roll and dimensions, then apply the checks in suggestGate.
 */

export type SuggestRule = 'shelf' | 'bridge' | 'copy'
export type SuggestReason = 'shelf' | 'bridge' | 'ring' | 'copyClosed' | 'copyOpen'

export interface Candidate {
  /** stable across presses: rule, section and both ends to the millimetre */
  key: string
  rule: SuggestRule
  reasons: SuggestReason[]
  member: ProfileData
  /** the members it was derived from */
  anchors: string[]
  score: number
  claim: Claim
}

/** an end within this of another member's end or centreline has landed on it (mm) */
const JT = 30
const LEN_TOL = 45
/** Only almost coincident members duplicate a route. An inboard bearing rail or a drawer
 * mounting rail can run close to a perimeter member and still serve a different purpose. */
const DUP_LATERAL = 5
const BRIDGE_MIN = 100
const BRIDGE_MAX = 2500
const Y = new THREE.Vector3(0, 1, 0)

interface Raw {
  s: THREE.Vector3; e: THREE.Vector3; spec: ProfileSpec; twin: ProfileData | null
  rule: SuggestRule; reason: SuggestReason; src: string[]; base: number; claim: Claim
  /** Existing hardware that this copy must actually restore. */
  hardware?: ConnectorData
  /** A generated hardware recipe's stable geometry key; focus ranking is separate. */
  geometryKey?: string
}

interface Seg { p: ProfileData; a: THREE.Vector3; b: THREE.Vector3; axis: Axis | null; box: THREE.Box3 }

function segs(profiles: ProfileData[]): Seg[] {
  return profiles.map((p) => {
    const { start, end } = getProfileEndpoints(p)
    return { p, a: start, b: end, axis: getProfileAxis(p), box: memberBox(p) }
  })
}

function segmentDistanceSq(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
  const px = p.x - a.x, py = p.y - a.y, pz = p.z - a.z
  const lengthSq = dx * dx + dy * dy + dz * dz
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy + pz * dz) / lengthSq)) : 0
  return (px - t * dx) ** 2 + (py - t * dy) ** 2 + (pz - t * dz) ** 2
}

function touches(x: Seg, y: Seg): boolean {
  for (const pt of [x.a, x.b]) if (segmentDistanceSq(pt, y.a, y.b) <= JT * JT) return true
  for (const pt of [y.a, y.b]) if (segmentDistanceSq(pt, x.a, x.b) <= JT * JT) return true
  return false
}

/** Include members joined to the focus and members intersecting its expanded neighbourhood. */
export function scopeOf(all: Seg[], focus: Set<string>): Seg[] {
  if (focus.size === 0) return all
  const inScope = new Set<string>()
  const queue = all.filter((s) => focus.has(s.p.id))
  for (const s of queue) inScope.add(s.p.id)
  const reachBox = new THREE.Box3()
  for (const s of queue) reachBox.union(s.box)
  reachBox.expandByScalar(NEIGHBOURHOOD)
  while (queue.length) {
    const cur = queue.pop()!
    const bx = cur.box.clone().expandByScalar(JT + 1)
    for (const o of all) {
      if (inScope.has(o.p.id) || !bx.intersectsBox(o.box) || !touches(cur, o)) continue
      inScope.add(o.p.id); queue.push(o)
    }
  }
  return all.filter((s) => inScope.has(s.p.id) || s.box.intersectsBox(reachBox))
}

type Landing = 'floor' | 'end' | 'body' | 'free'

/** where an end of a would-be member lands: on the floor, at another member's end, in the middle of one, or nowhere */
function landing(pt: THREE.Vector3, axis: Axis | null, all: Seg[]): Landing {
  if (axis === 'y' && pt.y <= 45) return 'floor'
  let body = false
  for (const q of all) {
    if (q.box.distanceToPoint(pt) > JT) continue
    if (axis && q.axis === axis) {
      // a coaxial member only counts end to end
      if (q.a.distanceTo(pt) < 2 || q.b.distanceTo(pt) < 2) return 'end'
      continue
    }
    if (q.a.distanceTo(pt) <= JT || q.b.distanceTo(pt) <= JT) return 'end'
    if (segmentDistanceSq(pt, q.a, q.b) <= JT * JT) body = true
  }
  return body ? 'body' : 'free'
}

/** lateral distance between two parallel lines and how much of the shorter they share */
function coaxial(a0: THREE.Vector3, a1: THREE.Vector3, b0: THREE.Vector3, b1: THREE.Vector3): { lateral: number; overlap: number } | null {
  const ax = a1.x - a0.x, ay = a1.y - a0.y, az = a1.z - a0.z
  const L = Math.sqrt(ax * ax + ay * ay + az * az); if (L < 1e-6) return null
  const dx = ax / L, dy = ay / L, dz = az / L
  const bx = b1.x - b0.x, by = b1.y - b0.y, bz = b1.z - b0.z
  const LB = Math.sqrt(bx * bx + by * by + bz * bz); if (LB < 1e-6) return null
  if (Math.abs((bx * dx + by * dy + bz * dz) / LB) < 0.99) return null
  const ox = b0.x - a0.x, oy = b0.y - a0.y, oz = b0.z - a0.z
  const t0 = ox * dx + oy * dy + oz * dz
  const lx = ox - t0 * dx, ly = oy - t0 * dy, lz = oz - t0 * dz
  const lateral = Math.sqrt(lx * lx + ly * ly + lz * lz)
  const t1 = (b1.x - a0.x) * dx + (b1.y - a0.y) * dy + (b1.z - a0.z) * dz
  const ov = Math.min(L, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1))
  return { lateral, overlap: Math.max(0, ov) / Math.min(L, LB) }
}

function routeAxis(a: THREE.Vector3, b: THREE.Vector3): Axis | null {
  const x = b.x - a.x, y = b.y - a.y, z = b.z - a.z, l = Math.sqrt(x * x + y * y + z * z)
  if (Math.abs(x) > 0.99 * l) return 'x'
  if (Math.abs(y) > 0.99 * l) return 'y'
  if (Math.abs(z) > 0.99 * l) return 'z'
  return null
}

const round = (v: THREE.Vector3) => `${Math.round(v.x) || 0},${Math.round(v.y) || 0},${Math.round(v.z) || 0}`
function rawGeometryKey(r: Raw): string {
  const claim = r.claim.kind === 'shelf' ? `${r.claim.panelId}:${r.claim.edge}` : r.hardware?.id ?? ''
  return `${r.rule}|${r.claim.kind}|${claim}|${r.spec}|${[round(r.s), round(r.e)].sort().join('|')}|${r.twin?.quaternion.join(',')}`
}

export function candidateKey(rule: SuggestRule, m: ProfileData): string {
  const { start, end } = getProfileEndpoints(m)
  return candidateKeyFromEndpoints(rule, m.spec, start, end)
}

function candidateKeyFromEndpoints(rule: SuggestRule, spec: ProfileSpec, start: THREE.Vector3, end: THREE.Vector3): string {
  const [a, b] = [round(start), round(end)].sort()
  return `${rule}|${spec}|${a}|${b}`
}

/** a parallel member of about this length to copy the section and roll from */
function findTwin(all: Seg[], axis: Axis, length: number, near: THREE.Vector3, scope: Set<string>, cache: Map<Axis, Map<number, Seg[]>>): ProfileData | null {
  let lengths = cache.get(axis)
  if (!lengths) { lengths = new Map(); cache.set(axis, lengths) }
  let matching = lengths.get(length)
  if (!matching) {
    matching = all.filter((s) => s.axis === axis && Math.abs(s.p.length - length) <= LEN_TOL)
    lengths.set(length, matching)
  }
  let best: { s: Seg; d: number } | null = null
  for (const s of matching) {
    const d = s.box.distanceToPoint(near) + (scope.has(s.p.id) ? 0 : 1e6)
    if (!best || d < best.d) best = { s, d }
  }
  return best?.s.p ?? null
}

interface HardwareRecipe {
  s: [number, number, number]
  e: [number, number, number]
  spec: ProfileSpec
  twinId: string
  hardwareId: string
  geometryKey: string
}
const hardwareRecipeCache = new Map<string, HardwareRecipe[]>()

/** Cache only numeric generation recipes. Raw objects are edited during preparation,
 * so every search gets its own vectors, claim, and references to the current document. */
function generateHardware(doc: SuggestDoc, all: Seg[], scope: Seg[], cache: VetCache): Raw[] {
  if (!doc.connectors.length) return []
  // Trims are a pure result of the complete profile values and manufacturing rule.
  // Scope controls available templates; focus ranking is applied later for each search.
  const key = JSON.stringify([doc.profiles, doc.connectors, scope.map((s) => s.p.id), getThroughRule()])
  const cached = hardwareRecipeCache.get(key)
  if (cached) {
    const members = new Map(doc.profiles.map((p) => [p.id, p]))
    const hardware = new Map(doc.connectors.map((c) => [c.id, c]))
    return cached.map((r): Raw => ({ s: new THREE.Vector3(...r.s), e: new THREE.Vector3(...r.e),
      spec: r.spec, twin: members.get(r.twinId)!, hardware: hardware.get(r.hardwareId)!,
      geometryKey: r.geometryKey, rule: 'copy', reason: 'copyClosed', src: [r.twinId], base: 3,
      claim: { kind: 'close', hardwareId: r.hardwareId },
    }))
  }
  const raw = buildHardwareRaw(doc, all, scope, cache)
  const recipes = raw.map((r): HardwareRecipe => {
    r.geometryKey = rawGeometryKey(r)
    return { s: r.s.toArray(), e: r.e.toArray(), spec: r.spec,
      twinId: r.twin!.id, hardwareId: r.hardware!.id, geometryKey: r.geometryKey }
  })
  if (hardwareRecipeCache.size >= 8) hardwareRecipeCache.delete(hardwareRecipeCache.keys().next().value!)
  hardwareRecipeCache.set(key, recipes)
  return raw
}

function buildHardwareRaw(doc: SuggestDoc, all: Seg[], scope: Seg[], cache: VetCache): Raw[] {
  const out: Raw[] = []
  const scopeIds = new Set(scope.map((s) => s.p.id))

  // A placed bracket left without one of its members is concrete evidence of a missing
  // member. Copy a member from another bracket with the same pose, preserving its section,
  // roll and length. Its actual bolt support is checked again after preparation below.
  if (doc.connectors.length) {
    const trims = cachedCheck(cache, 'trims', [doc.profiles], () => computeAllTrims(doc.profiles))
    const { faults, supported } = cachedHardwareSupports(doc, trims)
    if (faults.size) {
      const members = new Map(all.map((s) => [s.p.id, s]))
      const templates = doc.connectors.filter((c) => !faults.has(c.id)).map((c) => ({
        c, pose: new THREE.Quaternion(...c.quaternion).normalize(), members: undefined as Seg[] | undefined,
      }))
      for (const hardware of doc.connectors.filter((c) => faults.has(c.id))) {
        const pose = new THREE.Quaternion(...hardware.quaternion).normalize()
        for (const template of templates) {
          const { c } = template
          if (c.type !== hardware.type || (c.series ?? 20) !== (hardware.series ?? 20)
            || Math.abs(pose.dot(template.pose)) < 0.999999) continue
          // Locate supports only for templates that can restore this hardware pose.
          if (!template.members) {
            template.members = (supported.get(c.id) ?? []).flatMap((id) => {
              const member = members.get(id)
              return member ? [member] : []
            })
          }
          const delta = new THREE.Vector3(...hardware.position).sub(new THREE.Vector3(...c.position))
          for (const m of template.members) if (scopeIds.has(m.p.id)) out.push({
            s: m.a.clone().add(delta), e: m.b.clone().add(delta), spec: m.p.spec, twin: m.p,
            rule: 'copy', reason: 'copyClosed', src: [m.p.id], base: 3, claim: { kind: 'close', hardwareId: hardware.id }, hardware,
          })
        }
      }
    }
  }
  return out
}

function generate(doc: SuggestDoc, all: Seg[], scope: Seg[], cache: VetCache): Raw[] {
  const out: Raw[] = []
  const scopeIds = new Set(scope.map((s) => s.p.id))
  const twins = new Map<Axis, Map<number, Seg[]>>()

  // R1 — a shelf is carried on all four sides
  const scopeBox = new THREE.Box3()
  for (const s of scope) scopeBox.union(s.box)
  const panels = doc.panels.filter((b) => panelBox(b).intersectsBox(scopeBox))
  if (panels.length) {
    const scopeProfiles = scope.map((s) => s.p)
    const trims = cachedCheck(cache, 'trims', [scopeProfiles], () => computeAllTrims(scopeProfiles))
    const edges = shelfEdges(panels, scopeProfiles, trims)
    for (const e of edges) {
      if (e.carried) continue
      const opp = edges.find((o) => o.panelId === e.panelId && o.edge === oppositeEdge(e.edge))
      if (!opp?.carried || !opp.by) continue
      const twin = scope.find((s) => s.p.id === opp.by)?.p
      if (!twin) continue
      const side = e.a.clone().add(e.b).multiplyScalar(0.5)
      const opposite = opp.a.clone().add(opp.b).multiplyScalar(0.5)
      const midpoint = side.clone().add(opposite).multiplyScalar(0.5)
      const normal = side.sub(opposite).normalize()
      const mirror = (v: THREE.Vector3) => v.clone().addScaledVector(normal, -2 * v.clone().sub(midpoint).dot(normal))
      const { start, end } = getProfileEndpoints(twin)
      out.push({ s: mirror(start), e: mirror(end), spec: twin.spec, twin, rule: 'shelf', reason: 'shelf', src: [twin.id], base: 0.9, claim: { kind: 'shelf', panelId: e.panelId, edge: e.edge } })
    }
  }

  // R2 — two parallel members of one length, lined up: join their ends
  for (let i = 0; i < scope.length; i++) for (let j = i + 1; j < scope.length; j++) {
    const m = scope[i], n = scope[j]
    if (!m.axis || m.axis !== n.axis || Math.abs(m.p.length - n.p.length) > LEN_TOL) continue
    const dm = getProfileDir(m.p)
    let [na, nb] = [n.a, n.b]
    if (n.b.clone().sub(n.a).dot(dm) < 0) [na, nb] = [nb, na]
    const w = na.clone().sub(m.a)
    const dist = w.length()
    if (dist < BRIDGE_MIN || dist > BRIDGE_MAX) continue
    const wn = w.clone().divideScalar(dist)
    if (Math.max(Math.abs(wn.x), Math.abs(wn.y), Math.abs(wn.z)) < 0.999) continue
    if (Math.abs(wn.dot(dm)) > 0.01) continue
    const bax: Axis = Math.abs(wn.x) > 0.99 ? 'x' : Math.abs(wn.y) > 0.99 ? 'y' : 'z'
    const pairs: Array<[THREE.Vector3, THREE.Vector3]> = [[m.a.clone(), na.clone()], [m.b.clone(), nb.clone()]]
    const built: Raw[] = []
    for (const [pa, pb] of pairs) {
      const twin = findTwin(all, bax, dist, pa.clone().add(pb).multiplyScalar(0.5), scopeIds, twins)
      if (!twin) continue
      const s = pa.clone(), e = pb.clone()
      if (m.axis === 'y') {
        // across the ends of two posts: the rail sits on them, its outer face flush with their ends
        const other = pa === pairs[0][0] ? m.b : m.a
        const inward = Math.sign(other.y - pa.y)
        const ext = crossExtentAlong(twin, Y)
        s.y += inward * ext; e.y += inward * ext
      } else if (bax === 'y') {
        // a post between two rails runs to their outer faces
        const [lo, hi] = s.y <= e.y ? [s, e] : [e, s]
        const [loM, hiM] = m.a.y <= na.y ? [m.p, n.p] : [n.p, m.p]
        lo.y -= crossExtentAlong(loM, Y); hi.y += crossExtentAlong(hiM, Y)
      }
      built.push({ s, e, spec: twin.spec, twin, rule: 'bridge', reason: 'bridge', src: [m.p.id, n.p.id], base: 0.8, claim: { kind: 'close' } })
    }
    out.push(...built)
  }

  // R3 — repeat a member at the far end of a partner it stands on
  for (const m of scope) {
    if (!m.axis) continue
    for (const end of [m.a, m.b]) {
      for (const r of scope) {
        if (r.p.id === m.p.id || !r.axis || r.axis === m.axis) continue
        const near = r.a.distanceTo(end) <= JT + 25 ? r.a : r.b.distanceTo(end) <= JT + 25 ? r.b : null
        if (!near) continue
        const far = near === r.a ? r.b : r.a
        const rd = far.clone().sub(near); const span = rd.length(); rd.normalize()
        const inset = end.clone().sub(near).dot(rd)
        const T = rd.clone().multiplyScalar(span - 2 * inset)
        out.push({
          s: m.a.clone().add(T), e: m.b.clone().add(T), spec: m.p.spec, twin: m.p, rule: 'copy', reason: 'copyOpen',
          src: [m.p.id, r.p.id], base: 0.45, claim: { kind: 'open' },
        })
      }
    }
  }
  return out
}

/**
 * Suggestions, best first, each already checked. Lazy: the checks are the expensive part,
 * and a press only ever needs the first one that passes.
 *
 * `focus` is what the person is working on, most recent first — the selection, else the
 * last few members drawn. `skipped` are keys already turned down; they come last.
 */
export function* suggestNext(doc: SuggestDoc, focus: string[], skipped: Set<string> = new Set()): Generator<Candidate> {
  const all = segs(doc.profiles)
  if (all.length === 0) return
  const focusSet = new Set(focus.filter((id) => all.some((s) => s.p.id === id)))
  const scope = scopeOf(all, focusSet)
  const rank = new Map([...focusSet].map((id, i) => [id, i]))
  const focusBox = new THREE.Box3()
  for (const s of scope) if (focusSet.size === 0 || focusSet.has(s.p.id)) focusBox.union(s.box)
  const focusMid = focusBox.getCenter(new THREE.Vector3())
  const frame = new THREE.Box3()
  for (const s of scope) frame.union(s.box)

  const scored: Candidate[] = []
  const baselineChecks = createVetSearchCache(doc)
  const rooms = new Map<string, THREE.Box3>()
  const raw = new Map<string, Raw>()
  const rawFocusRank = (r: Raw) => Math.min(...r.src.map((id) => rank.get(id) ?? Infinity))
  const addRaw = (r: Raw) => {
    const geometry = r.geometryKey ?? rawGeometryKey(r)
    const existing = raw.get(geometry)
    // Open copies need their source in the focus. Keep that usable derivation when
    // another, non-focused template happens to generate the same route first.
    const focused = (x: Raw) => x.rule === 'copy' && x.claim.kind === 'open' && focusSet.has(x.src[0])
    if (!existing || r.base > existing.base || (r.base === existing.base
      && (Number(focused(r)) > Number(focused(existing))
        || (focused(r) === focused(existing) && rawFocusRank(r) < rawFocusRank(existing))))) raw.set(geometry, r)
  }
  for (const r of generateHardware(doc, all, scope, baselineChecks)) addRaw(r)

  const ordered = (candidates: Candidate[]) => {
    // Geometry is unchanged during this synchronous sort. Keep its tie breakers
    // only for this call, so no cached pose can survive a yield or document edit.
    const geometry = new Map<ProfileData, { distance: number; low: number }>()
    const tie = (c: Candidate) => {
      let value = geometry.get(c.member)
      if (!value) {
        const e = getProfileEndpoints(c.member)
        value = { distance: e.start.clone().add(e.end).multiplyScalar(0.5).distanceTo(focusMid),
          low: Math.min(e.start.y, e.end.y) }
        geometry.set(c.member, value)
      }
      return value
    }
    return candidates.sort((a, b) => Number(skipped.has(a.key)) - Number(skipped.has(b.key))
      || b.score - a.score
      || tie(a).distance - tie(b).distance
      || tie(a).low - tie(b).low
      || a.member.length - b.member.length)
  }
  const yielded = new Set<string>()
  const yieldedRoutes = new Set<string>()
  const routeOf = (c: Candidate) => candidateKey('copy', c.member)
  const priority = new Set<Raw>()
  const hardwareCandidates: Candidate[] = []
  // Different brackets can require the exact same missing member. Reuse only
  // its construction and existing-route check; every hardware claim stays separate.
  const hardwareMembers = new Map<string, { member: ProfileData; key: string; duplicate?: boolean } | null>()
  for (const r of raw.values()) {
    if (!r.hardware || !r.twin) continue
    // Use exact raw coordinates, not the rounded candidate key: nearby routes
    // and different section rolls must still construct and validate independently.
    const geometry = `${r.rule}|${r.spec}|${r.s.x},${r.s.y},${r.s.z}|${r.e.x},${r.e.y},${r.e.z}|${r.twin.quaternion.join(',')}`
    let prepared = hardwareMembers.get(geometry)
    if (prepared === undefined) {
      const built = buildProfile(r.s, r.e, r.spec)
      if (!built) { hardwareMembers.set(geometry, null); continue }
      const member = { ...built, quaternion: [...r.twin.quaternion] as ProfileData['quaternion'] }
      prepared = { member, key: candidateKey(r.rule, member) }
      hardwareMembers.set(geometry, prepared)
    }
    if (!prepared) continue
    const { member, key } = prepared
    if (skipped.has(key)) continue
    priority.add(r)
    if (prepared.duplicate === undefined) {
      const { start, end } = getProfileEndpoints(member)
      const memberAxis = routeAxis(start, end)
      prepared.duplicate = all.some((s) => {
        if (memberAxis && s.axis && memberAxis !== s.axis) return false
        const c = coaxial(start, end, s.a, s.b); return c !== null && c.lateral <= DUP_LATERAL && c.overlap >= 0.5
      })
    }
    if (prepared.duplicate) continue
    const r0 = rawFocusRank(r)
    hardwareCandidates.push({ key, rule: r.rule, reasons: [r.reason], member, anchors: r.src,
      score: r.base + (isFinite(r0) ? 1.5 / (1 + r0) : 0), claim: r.claim })
  }
  // Every hardware copy scores at least 3; ordinary rules score at most 2.5 including
  // focus and ring bonuses. Check this leading group before generating or preparing
  // the lower-ranked rules. A subsequent next() still visits those other routes.
  const rejectedHardwarePoses = new Set<string>()
  for (const c of ordered(hardwareCandidates)) {
    if (yielded.has(c.key)) continue
    const pose = JSON.stringify([c.member.spec, c.member.length, c.member.position, c.member.quaternion])
    if (rejectedHardwarePoses.has(pose)) continue
    const result = vet(c.member, c.claim, doc, frame, baselineChecks)
    if (!result.ok) {
      // Several brackets can require the same member. A geometry failure applies
      // to all of them; restoring one specific bracket is checked separately.
      if (result.why !== 'hardware-not-restored') rejectedHardwarePoses.add(pose)
      continue
    }
    yielded.add(c.key); yieldedRoutes.add(routeOf(c)); yield c
    refreshVetSearchCache(baselineChecks, doc)
  }
  for (const r of generate(doc, all, scope, baselineChecks)) addRaw(r)
  const rawOrder = new Map([...raw.values()].map((r, i) => [r, i]))
  const preparationOrder = new Map<Candidate, number>()
  const unboosted = new Map<Candidate, number>()
  const scoreCeiling = (r: Raw) => {
    const r0 = rawFocusRank(r)
    const base = r.hardware ? 3 : r.rule === 'bridge' ? 0.9 : r.rule === 'copy' ? 0.5 : r.base
    return base + (isFinite(r0) ? 1.5 / (1 + r0) : 0)
  }
  const pending = [...raw.values()].filter((r) => !priority.has(r))
    .map((r) => ({ r, ceiling: scoreCeiling(r) }))
    .sort((a, b) => b.ceiling - a.ceiling || rawOrder.get(a.r)! - rawOrder.get(b.r)!)
  const remaining = new Set(pending.map(({ r }) => r))
  const prepare = (r: Raw) => {
    const roomKey = `${r.spec}:${Boolean(r.hardware)}`
    let room = rooms.get(roomKey)
    if (!room) {
      const extent = Math.max(Number(r.spec.slice(0, 2)), Number(r.spec.slice(2))) / 2
      room = frame.clone().expandByScalar(extent + (r.hardware ? 0.5 : 60.5))
      rooms.set(roomKey, room)
    }
    if (!room.containsPoint(r.s) || !room.containsPoint(r.e)) return
    const rawAxis = routeAxis(r.s, r.e)
    const rawLength = r.s.distanceTo(r.e)
    // Reject unchanged routes before fitting their sections. This does not suppress nearby
    // inboard routes, and avoids repeating face alignment for copies already in the frame.
    if (all.some((s) => {
      if (rawAxis && s.axis && rawAxis !== s.axis) return false
      const c = coaxial(r.s, r.e, s.a, s.b)
      return c !== null && c.lateral <= 0.1 && c.overlap >= 0.99
        && Math.abs(rawLength - s.p.length) <= 0.1
    })) return
    const axis = r.twin ? getProfileAxis(r.twin) : null
    // Anchor structural candidates to the floor or another member endpoint.
    if (r.rule !== 'shelf') {
      const la = landing(r.s, axis, all), lb = landing(r.e, axis, all)
      if ((la === 'body' || lb === 'body') && !r.hardware) return
      const landed = (l: Landing) => l === 'floor' || l === 'end'
      if (!landed(la) && !landed(lb) && !r.hardware) return
      if (r.rule === 'bridge' && !(landed(la) && landed(lb))) return
      if (r.rule === 'copy' && landed(la) && landed(lb)) {
        r.reason = 'copyClosed'
        if (!r.hardware) r.base = 0.5
        r.claim = r.hardware ? { kind: 'close', hardwareId: r.hardware.id } : { kind: 'close' }
      }
      // left hanging at one end, a copy is only a guess about where the drawing is going,
      // so it is offered only for a member being worked on now
      else if (r.rule === 'copy' && !r.hardware && focusSet.size > 0 && !focusSet.has(r.src[0])) return
    }
    const box = new THREE.Box3().setFromPoints([r.s, r.e]).expandByScalar(60)
    const others = all.filter((s) => s.box.intersectsBox(box)).map((s) => s.p)
    let member = r.hardware ? buildProfile(r.s, r.e, r.spec)
      : prepareProfile(r.s, r.e, r.spec, others, { twin: r.twin, floorFeet: true })
    // An existing bracket fixes the pose. Automatically rolling or shifting this copy
    // would discard the constraint that justified it in the first place.
    if (member && r.hardware && r.twin) member = { ...member, quaternion: [...r.twin.quaternion] }
    if (!member) return
    // a member that is already there is not a suggestion
    const { start, end } = getProfileEndpoints(member)
    const memberAxis = routeAxis(start, end)
    // A shelf bearer inside the board can run close to a perimeter rail that does not
    // carry it. Only an actual duplicate suppresses that proposal; vet still rejects
    // any overlapping or unmountable geometry.
    const duplicateReach = r.rule === 'shelf' ? 5 : DUP_LATERAL
    if (all.some((s) => {
      if (memberAxis && s.axis && memberAxis !== s.axis) return false
      const c = coaxial(start, end, s.a, s.b); return c !== null && c.lateral <= duplicateReach && c.overlap >= 0.5
    })) return
    const r0 = Math.min(...r.src.map((id) => rank.get(id) ?? Infinity))
    const score = r.base + (isFinite(r0) ? 1.5 / (1 + r0) : 0)
    const candidate: Candidate = { key: candidateKeyFromEndpoints(r.rule, member.spec, start, end), rule: r.rule, reasons: [r.reason], member, anchors: r.src, score, claim: r.claim }
    preparationOrder.set(candidate, rawOrder.get(r)!)
    scored.push(candidate)
  }

  // Rebuild with the original stable order whenever another score group is prepared.
  let mergedCount = -1
  let mergedCandidates: Candidate[] = []
  const mergePrepared = () => {
    // Rejecting or yielding a variant changes eligibility, not the scored geometry.
    // Reuse its stable merge, reasons and ring scores until preparation appends a member.
    if (mergedCount === scored.length) return mergedCandidates
    mergedCount = scored.length
    unboosted.clear()
    const merged: Candidate[] = []
    for (const source of [...scored].sort((a, b) => b.score - a.score || preparationOrder.get(a)! - preparationOrder.get(b)!)) {
      const c = { ...source, reasons: [...source.reasons] }
      unboosted.set(c, c.score)
      const { start, end } = getProfileEndpoints(c.member)
      const same = merged.find((k) => {
        if (k.member.spec !== c.member.spec) return false
        if (Math.abs(new THREE.Quaternion(...k.member.quaternion).dot(new THREE.Quaternion(...c.member.quaternion))) < 0.999999) return false
        if (k.claim.kind !== c.claim.kind) return false
        if (k.claim.kind === 'close' && c.claim.kind === 'close' && k.claim.hardwareId !== c.claim.hardwareId) return false
        if (k.claim.kind === 'shelf' && c.claim.kind === 'shelf'
          && (k.claim.panelId !== c.claim.panelId || k.claim.edge !== c.claim.edge)) return false
        const e = getProfileEndpoints(k.member)
        // Sharing the shorter route is insufficient: a long perimeter rail and a shorter
        // inboard bearer have different ends and can have different valid connections.
        return (start.distanceTo(e.start) <= 5 && end.distanceTo(e.end) <= 5)
          || (start.distanceTo(e.end) <= 5 && end.distanceTo(e.start) <= 5)
      })
      if (same) { for (const why of c.reasons) if (!same.reasons.includes(why)) same.reasons.push(why); continue }
      merged.push(c)
    }
    // Prioritize bridges that complete a four-member ring.
    for (const c of merged) {
      if (c.rule !== 'bridge') continue
      const [m, n] = c.anchors.map((id) => all.find((s) => s.p.id === id)!)
      const ends = [c.member].map(getProfileEndpoints)[0]
      const closes = all.some((s) => s.p.id !== m.p.id && s.p.id !== n.p.id && touches(s, m) && touches(s, n)
        && segmentDistanceSq(ends.start, s.a, s.b) > JT * JT)
      if (closes) { c.score += 0.1; c.reasons.push('ring') }
    }

    mergedCandidates = ordered(merged)
    return mergedCandidates
  }

  const rejected = new Set<string>()
  const variantOf = (c: Candidate) => `${c.member.id}|${JSON.stringify(c.claim)}`
  let cursor = 0
  const prepareRaw = (r: Raw) => { remaining.delete(r); prepare(r) }
  while (true) {
    while (cursor < pending.length && !remaining.has(pending[cursor].r)) cursor++
    const c = mergePrepared().find((candidate) => !yielded.has(candidate.key)
      && !yieldedRoutes.has(routeOf(candidate)) && !rejected.has(variantOf(candidate)))
    // A ring bonus must not hide a later candidate that could replace its merge winner.
    // Equal score bounds are prepared together so distance/height/length ties stay stable.
    if (cursor < pending.length && (!c || skipped.has(c.key)
      || pending[cursor].ceiling >= unboosted.get(c)! - 1e-10)) {
      const ceiling = pending[cursor].ceiling
      while (cursor < pending.length && pending[cursor].ceiling >= ceiling - 1e-10) {
        const r = pending[cursor++].r
        if (remaining.has(r)) prepareRaw(r)
      }
      continue
    }
    if (!c) break
    // Lower-scoring copies can contribute reasons to this same member. Resolve every raw
    // that could reach either pair of endpoints before offering the merged candidate.
    // Besides 60mm face alignment and one section of floor seating, copying a twin whose
    // direction differs within dot>0.999 can move the far end by sqrt(2*(1-.999))*length.
    const { start, end } = getProfileEndpoints(c.member)
    const related = [...remaining].filter((r) => {
      if (r.spec !== c.member.spec) return false
      // Only open copies can change claim during preparation, and only into close.
      // Shelf identities and hardware targets remain fixed.
      if (c.claim.kind === 'shelf') {
        if (r.claim.kind !== 'shelf' || r.claim.panelId !== c.claim.panelId || r.claim.edge !== c.claim.edge) return false
      } else if (r.claim.kind === 'shelf') return false
      if (c.claim.kind === 'open' && r.claim.kind !== 'open') return false
      if (c.claim.kind === 'close') {
        const target = r.claim.kind === 'close' ? r.claim.hardwareId : undefined
        if (target !== c.claim.hardwareId) return false
      }
      const section = Math.max(Number(r.spec.slice(0, 2)), Number(r.spec.slice(2)))
      const reach = 65.1 + section + (r.twin ? Math.sqrt(0.002) * (r.s.distanceTo(r.e) + section) : 0)
      return (r.s.distanceTo(start) <= reach && r.e.distanceTo(end) <= reach)
        || (r.s.distanceTo(end) <= reach && r.e.distanceTo(start) <= reach)
    })
    if (related.length) { for (const r of related) prepareRaw(r); continue }
    rejected.add(variantOf(c))
    if (vet(c.member, c.claim, doc, frame, baselineChecks).ok) {
      yielded.add(c.key); yieldedRoutes.add(routeOf(c)); yield c
      refreshVetSearchCache(baselineChecks, doc)
      continue
    }
    if (c.claim.kind === 'close' && c.claim.hardwareId) continue
    // a rectangular section may fit turned a quarter the other way
    const { w, h } = { w: Number(c.member.spec.slice(0, 2)), h: Number(c.member.spec.slice(2)) }
    if (w === h) continue
    const dir = getProfileDir(c.member)
    const q = new THREE.Quaternion().setFromAxisAngle(dir, Math.PI / 2).multiply(new THREE.Quaternion(...c.member.quaternion)).normalize()
    const rolled = { ...c.member, quaternion: [q.x, q.y, q.z, q.w] as [number, number, number, number] }
    if (vet(rolled, c.claim, doc, frame, baselineChecks).ok) {
      yielded.add(c.key); yieldedRoutes.add(routeOf(c)); yield { ...c, member: rolled }
      refreshVetSearchCache(baselineChecks, doc)
    }
  }
}

/**
 * The focus a press starts from: the selection, then the last few members drawn. Both, not
 * one or the other — after a suggestion is accepted the selection is that one member, and
 * the cabinet it belongs to is still the one being built.
 */
export function focusOf(profiles: ProfileData[], selectedIds: string[]): string[] {
  const ids = new Set(profiles.map((p) => p.id))
  const out = selectedIds.filter((id) => ids.has(id))
  for (const p of profiles.slice(-3).reverse()) if (!out.includes(p.id)) out.push(p.id)
  return out
}
