import * as THREE from 'three'
import type { ProfileData, ProfileSpec } from '../store/useStore'
import { getProfileAxis, getProfileDir, getProfileEndpoints, closestOnSegment, crossExtentAlong, type Axis } from './geometryCore'
import { memberBox } from './dragSnap'
import { prepareProfile } from './profileFactory'
import { shelfEdges, oppositeEdge, panelBox } from './shelfSupport'
import { vet, NEIGHBOURHOOD, type Claim, type SuggestDoc } from './suggestGate'

export type { SuggestDoc } from './suggestGate'

/**
 * The next member: what the drawing most likely needs, built the way a hand-drawn one is.
 *
 * Three rules, and all three only ever copy what is already there — a section, a roll, a
 * length, a height — so a suggestion never invents a dimension:
 *
 *  - shelf: a board lying flat is carried on all four sides. An edge that is not gets the
 *    rail that carries the edge opposite, mirrored across the board.
 *  - bridge: two parallel members of one length, lined up, want joining at their ends — the
 *    top rail between two posts, the side rail between a front and a back one.
 *  - copy: a member at one end of a partner is repeated at the partner's other end — the
 *    back post from the front one, the top rail from the bottom one.
 *
 * Each candidate is then put through every check the tool makes of a finished drawing
 * (see suggestGate), and only one that leaves nothing worse is offered.
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
/** a parallel member closer than this over half its length already takes that route: a
 *  second rail forty millimetres from the first is never what was meant (mm) */
const DUP_LATERAL = 45
const BRIDGE_MIN = 100
const BRIDGE_MAX = 2500
const Y = new THREE.Vector3(0, 1, 0)

interface Raw {
  s: THREE.Vector3; e: THREE.Vector3; spec: ProfileSpec; twin: ProfileData | null
  rule: SuggestRule; reason: SuggestReason; src: string[]; base: number; claim: Claim
}

interface Seg { p: ProfileData; a: THREE.Vector3; b: THREE.Vector3; axis: Axis | null; box: THREE.Box3 }

function segs(profiles: ProfileData[]): Seg[] {
  return profiles.map((p) => {
    const { start, end } = getProfileEndpoints(p)
    return { p, a: start, b: end, axis: getProfileAxis(p), box: memberBox(p) }
  })
}

function touches(x: Seg, y: Seg): boolean {
  for (const pt of [x.a, x.b]) if (closestOnSegment(pt, y.a, y.b).point.distanceTo(pt) <= JT) return true
  for (const pt of [y.a, y.b]) if (closestOnSegment(pt, x.a, x.b).point.distanceTo(pt) <= JT) return true
  return false
}

/**
 * What the suggestions are about: the members joined to the focus, and anything within
 * reach of it. Scoping to the cabinet in hand is what keeps a press quick on a flat of
 * twelve, and it is also what a person means — the next member of *this* cabinet.
 */
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
    if (closestOnSegment(pt, q.a, q.b).point.distanceTo(pt) <= JT) body = true
  }
  return body ? 'body' : 'free'
}

/** lateral distance between two parallel lines and how much of the shorter they share */
function coaxial(a0: THREE.Vector3, a1: THREE.Vector3, b0: THREE.Vector3, b1: THREE.Vector3): { lateral: number; overlap: number } | null {
  const d = a1.clone().sub(a0); const L = d.length(); if (L < 1e-6) return null
  d.divideScalar(L)
  const bd = b1.clone().sub(b0); const LB = bd.length(); if (LB < 1e-6) return null
  if (Math.abs(bd.divideScalar(LB).dot(d)) < 0.99) return null
  const off = b0.clone().sub(a0)
  const lateral = off.clone().addScaledVector(d, -off.dot(d)).length()
  const t0 = b0.clone().sub(a0).dot(d), t1 = b1.clone().sub(a0).dot(d)
  const ov = Math.min(L, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1))
  return { lateral, overlap: Math.max(0, ov) / Math.min(L, LB) }
}

const round = (v: THREE.Vector3) => v.toArray().map((x) => Math.round(x) || 0).join(',')
export function candidateKey(rule: SuggestRule, m: ProfileData): string {
  const { start, end } = getProfileEndpoints(m)
  const [a, b] = [round(start), round(end)].sort()
  return `${rule}|${m.spec}|${a}|${b}`
}

/** a parallel member of about this length to copy the section and roll from */
function findTwin(all: Seg[], axis: Axis, length: number, near: THREE.Vector3, scope: Set<string>): ProfileData | null {
  let best: { s: Seg; d: number } | null = null
  for (const s of all) {
    if (s.axis !== axis || Math.abs(s.p.length - length) > LEN_TOL) continue
    const d = s.box.distanceToPoint(near) + (scope.has(s.p.id) ? 0 : 1e6)
    if (!best || d < best.d) best = { s, d }
  }
  return best?.s.p ?? null
}

function generate(doc: SuggestDoc, all: Seg[], scope: Seg[]): Raw[] {
  const out: Raw[] = []
  const scopeIds = new Set(scope.map((s) => s.p.id))

  // R1 — a shelf is carried on all four sides
  const scopeBox = new THREE.Box3()
  for (const s of scope) scopeBox.union(s.box)
  const panels = doc.panels.filter((b) => panelBox(b).intersectsBox(scopeBox))
  if (panels.length) {
    const edges = shelfEdges(panels, scope.map((s) => s.p))
    for (const e of edges) {
      if (e.carried) continue
      const opp = edges.find((o) => o.panelId === e.panelId && o.edge === oppositeEdge(e.edge))
      if (!opp?.carried || !opp.by) continue
      const twin = scope.find((s) => s.p.id === opp.by)?.p
      if (!twin) continue
      const box = panelBox(panels.find((b) => b.id === e.panelId)!)
      const ax = e.edge[0] as 'x' | 'z'
      const mirror = (v: THREE.Vector3) => { const r = v.clone(); r[ax] = box.min[ax] + box.max[ax] - v[ax]; return r }
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
      const twin = findTwin(all, bax, dist, pa.clone().add(pb).multiplyScalar(0.5), scopeIds)
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
  for (const r of generate(doc, all, scope)) {
    const axis = r.twin ? getProfileAxis(r.twin) : null
    // strict anchoring: a structural member lands on the floor or at another member's end,
    // never in the middle of a beam — that is what keeps it from sprouting posts everywhere
    if (r.rule !== 'shelf') {
      const la = landing(r.s, axis, all), lb = landing(r.e, axis, all)
      if (la === 'body' || lb === 'body') continue
      const landed = (l: Landing) => l === 'floor' || l === 'end'
      if (!landed(la) && !landed(lb)) continue
      if (r.rule === 'bridge' && !(landed(la) && landed(lb))) continue
      if (r.rule === 'copy' && landed(la) && landed(lb)) { r.reason = 'copyClosed'; r.base = 0.5; r.claim = { kind: 'close' } }
      // left hanging at one end, a copy is only a guess about where the drawing is going,
      // so it is offered only for a member being worked on now
      else if (r.rule === 'copy' && focusSet.size > 0 && !focusSet.has(r.src[0])) continue
    }
    const box = new THREE.Box3().setFromPoints([r.s, r.e]).expandByScalar(60)
    const others = all.filter((s) => s.box.intersectsBox(box)).map((s) => s.p)
    const member = prepareProfile(r.s, r.e, r.spec, others, { twin: r.twin, floorFeet: true })
    if (!member) continue
    // a member that is already there is not a suggestion
    const { start, end } = getProfileEndpoints(member)
    if (all.some((s) => { const c = coaxial(start, end, s.a, s.b); return c !== null && c.lateral <= DUP_LATERAL && c.overlap >= 0.5 })) continue
    const r0 = Math.min(...r.src.map((id) => rank.get(id) ?? Infinity))
    const score = r.base + (isFinite(r0) ? 1.5 / (1 + r0) : 0)
    scored.push({ key: candidateKey(r.rule, member), rule: r.rule, reasons: [r.reason], member, anchors: r.src, score, claim: r.claim })
  }

  // one member offered for two reasons is one suggestion with both reasons
  const merged: Candidate[] = []
  for (const c of scored.sort((a, b) => b.score - a.score)) {
    const { start, end } = getProfileEndpoints(c.member)
    const same = merged.find((k) => {
      const e = getProfileEndpoints(k.member)
      const co = coaxial(start, end, e.start, e.end)
      return co !== null && co.lateral <= 5 && co.overlap >= 0.9
    })
    if (same) { for (const why of c.reasons) if (!same.reasons.includes(why)) same.reasons.push(why); continue }
    merged.push(c)
  }
  // a bridge that finishes a ring of four is the likeliest of all
  for (const c of merged) {
    if (c.rule !== 'bridge') continue
    const [m, n] = c.anchors.map((id) => all.find((s) => s.p.id === id)!)
    const ends = [c.member].map(getProfileEndpoints)[0]
    const closes = all.some((s) => s.p.id !== m.p.id && s.p.id !== n.p.id && touches(s, m) && touches(s, n)
      && !(closestOnSegment(ends.start, s.a, s.b).point.distanceTo(ends.start) <= JT))
    if (closes) { c.score += 0.1; c.reasons.push('ring') }
  }

  const mid = (c: Candidate) => { const e = getProfileEndpoints(c.member); return e.start.clone().add(e.end).multiplyScalar(0.5) }
  const low = (c: Candidate) => { const e = getProfileEndpoints(c.member); return Math.min(e.start.y, e.end.y) }
  merged.sort((a, b) =>
    Number(skipped.has(a.key)) - Number(skipped.has(b.key))
    || b.score - a.score
    || mid(a).distanceTo(focusMid) - mid(b).distanceTo(focusMid)
    || low(a) - low(b)
    || a.member.length - b.member.length)

  for (const c of merged) {
    if (vet(c.member, c.claim, doc, frame).ok) { yield c; continue }
    // a rectangular section may fit turned a quarter the other way
    const { w, h } = { w: Number(c.member.spec.slice(0, 2)), h: Number(c.member.spec.slice(2)) }
    if (w === h) continue
    const dir = getProfileDir(c.member)
    const q = new THREE.Quaternion().setFromAxisAngle(dir, Math.PI / 2).multiply(new THREE.Quaternion(...c.member.quaternion)).normalize()
    const rolled = { ...c.member, quaternion: [q.x, q.y, q.z, q.w] as [number, number, number, number] }
    if (vet(rolled, c.claim, doc, frame).ok) yield { ...c, member: rolled }
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
