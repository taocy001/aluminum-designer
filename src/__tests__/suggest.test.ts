import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { suggestNext, focusOf, type Candidate } from '../utils/suggest'
import { findConflicts } from '../utils/analysis'
import { computeAllTrims, trimmedBox } from '../utils/jointUtils'
import { getProfileDir, getProfileEndpoints } from '../utils/geometryCore'
import { countUnflush } from '../utils/faceAlign'
import { prepareProfile } from '../utils/profileFactory'
import { migrateFittings } from '../utils/migrate'
import { auditBrackets, seatFor } from '../utils/bracketSeat'
import { vet } from '../utils/suggestGate'
import type { ConnectorData, FittingData, PanelData, ProfileData, ProfileSpec } from '../store/useStore'

interface Doc { profiles: ProfileData[]; connectors: ConnectorData[]; panels: PanelData[]; fittings: FittingData[] }

const loaded = import.meta.glob(['../../examples/*.json', '../../examples/flat/*.json'], { eager: true }) as Record<string, { default: Partial<Doc> & { profiles: ProfileData[] } }>
const docs = new Map<string, Doc>()
for (const [path, mod] of Object.entries(loaded)) {
  const name = path.split('/').pop()!
  if (name.startsWith('connector-demo')) continue     // isolated hardware samples
  const d = mod.default
  docs.set(name, { profiles: d.profiles, connectors: d.connectors ?? [], panels: d.panels ?? [], fittings: migrateFittings(d.profiles, d.fittings ?? []) })
}
const files = [...docs.keys()].sort()

const same = (a: ProfileData, b: ProfileData) => {
  const x = getProfileEndpoints(a), y = getProfileEndpoints(b)
  return a.spec === b.spec && ((x.start.distanceTo(y.start) < 12 && x.end.distanceTo(y.end) < 12)
    || (x.start.distanceTo(y.end) < 12 && x.end.distanceTo(y.start) < 12))
}
const first = (it: Iterator<Candidate>, n: number) => {
  const out: Candidate[] = []
  while (out.length < n) {
    const next = it.next()
    if (next.done) break
    out.push(next.value)
  }
  return out
}

// ---- the test's own yardsticks. None of them is the gate: a check that shares the
// ---- implementation's code shares its blind spots.

function panelBox(b: PanelData): THREE.Box3 {
  const q = new THREE.Quaternion(...b.quaternion).normalize()
  const box = new THREE.Box3()
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    box.expandByPoint(new THREE.Vector3(sx * b.width / 2, sy * b.height / 2, sz * b.thickness / 2).applyQuaternion(q).add(new THREE.Vector3(...b.position)))
  }
  return box
}
/** how deep two axis-aligned boxes run into each other: the shallowest of the three */
function depth(a: THREE.Box3, b: THREE.Box3): number {
  return Math.min(...(['x', 'y', 'z'] as const).map((k) => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k])))
}
/** every edge of every lying board that metal carries, the way examples.test asks it */
function carriedEdges(profiles: ProfileData[], panels: PanelData[]): Set<string> {
  const trims = computeAllTrims(profiles)
  const metal = profiles.map((p) => trimmedBox(p, trims.get(p.id)!))
  const out = new Set<string>()
  for (const b of panels) {
    const box = panelBox(b)
    const size = box.getSize(new THREE.Vector3())
    if (size.y > 40) continue
    const carried = (axis: 'x' | 'z', at: number) => {
      const other = axis === 'x' ? 'z' : 'x'
      return metal.some((m) => {
        const run = Math.min(m.max[axis], box.max[axis]) - Math.max(m.min[axis], box.min[axis])
        const overlap = Math.min(m.max[other], box.max[other]) - Math.max(m.min[other], box.min[other])
        return run >= size[axis] * 0.7 && Math.abs(m.max.y - box.min.y) <= 0.1
          && overlap > 0.01 && m.min[other] - 25 <= at && at <= m.max[other] + 25
      })
    }
    const edges = [carried('z', box.min.x), carried('z', box.max.x), carried('x', box.min.z), carried('x', box.max.z)]
    edges.forEach((c, i) => { if (c) out.add(`${b.id}:${i}`) })
  }
  return out
}
function emptyCorners(profiles: ProfileData[]): Set<string> {
  const trims = computeAllTrims(profiles)
  const solid = new Map(profiles.map((p) => [p.id, trimmedBox(p, trims.get(p.id)!)]))
  const out = new Set<string>()
  for (const p of profiles) {
    const t = trims.get(p.id)!
    const { start, end } = getProfileEndpoints(p)
    const dir = end.clone().sub(start).normalize()
    for (const [tip, cut, sign, name] of [[start, t.start.trim, 1, 's'], [end, t.end.trim, -1, 'e']] as const) {
      if (cut <= 0.5) continue
      const probe = tip.clone().addScaledVector(dir, sign * cut / 2)
      if (![...solid].some(([id, box]) => id !== p.id && box.containsPoint(probe))) out.add(`${p.id}:${name}`)
    }
  }
  return out
}
const noEdge = (a: ProfileSpec, b: ProfileSpec) => [a, b].sort().join() === '2020,4040'

/** The fixtures use B6 for 2020/2040 and I8 for 4040. No listed connector
 * adapts these slots. Identify actual perpendicular contacts independently of vet. */
function unsupportedMixedMembers(doc: Doc): Set<string> {
  const trims = computeAllTrims(doc.profiles)
  const bodies = new Map(doc.profiles.map((p) => [p.id, trimmedBox(p, trims.get(p.id)!)]))
  const ids = new Set<string>()
  const b6 = (spec: ProfileSpec) => spec === '2020' || spec === '2040'
  for (let i = 0; i < doc.profiles.length; i++) {
    const a = doc.profiles[i]
    for (const b of doc.profiles.slice(i + 1)) {
      if (!((b6(a.spec) && b.spec === '4040') || (a.spec === '4040' && b6(b.spec)))) continue
      if (Math.abs(getProfileDir(a).dot(getProfileDir(b))) > 0.1) continue
      if (depth(bodies.get(a.id)!.clone().expandByScalar(0.5), bodies.get(b.id)!) <= 0) continue
      ids.add(a.id); ids.add(b.id)
    }
  }
  return ids
}

/** Everything that must hold of a suggestion, asked of the whole drawing, before and after */
function faultsOf(doc: Doc, c: Candidate): string[] {
  const out: string[] = []
  const m = c.member
  const after = [...doc.profiles, m]
  const trims = computeAllTrims(after)
  const mine = trimmedBox(m, trims.get(m.id)!)
  if (mine.min.y < -0.5) out.push('below the floor')
  for (const p of doc.profiles) {
    const box = trimmedBox(p, trims.get(p.id)!)
    if (depth(mine, box) > 0.5) out.push(`box overlaps ${p.spec}@${p.position.map(Math.round)}`)
    if (noEdge(m.spec, p.spec) && depth(mine.clone().expandByScalar(0.1), box) > 0) out.push(`2020 meets 4040 ${p.id}`)
  }
  for (const b of doc.panels) if (depth(mine, panelBox(b)) > 0.5) out.push(`box overlaps board ${b.id}`)
  const key = (x: { a: string; b: string }) => [x.a, x.b].sort().join('|')
  const was = new Set(findConflicts(doc.profiles, computeAllTrims(doc.profiles), doc.connectors, doc.panels, doc.fittings).map(key))
  for (const k of findConflicts(after, trims, doc.connectors, doc.panels, doc.fittings).map(key)) if (!was.has(k)) out.push(`clash ${k}`)
  if (countUnflush(after) > countUnflush(doc.profiles)) out.push('a joint nothing bolts')
  const cornersWere = emptyCorners(doc.profiles)
  for (const k of emptyCorners(after)) if (!cornersWere.has(k)) out.push(`empty corner ${k}`)
  const carriedWere = carriedEdges(doc.profiles, doc.panels)
  const carriedNow = carriedEdges(after, doc.panels)
  for (const k of carriedWere) if (!carriedNow.has(k)) out.push(`shelf edge dropped ${k}`)
  if (c.rule === 'shelf' && carriedNow.size <= carriedWere.size) out.push('shelf rail carries nothing new')
  return out
}

describe('suggesting the next member', () => {
  it('loads example fixtures', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it('keeps a missing perimeter rail distinct from its nearby inboard bearer', () => {
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
    const profiles: ProfileData[] = []
    const add = (a: THREE.Vector3, b: THREE.Vector3) => {
      const p = prepareProfile(a, b, '2020', profiles)!
      profiles.push(p)
      return p
    }
    for (const x of [0, 600]) for (const z of [0, 400]) add(V(x, 0, z), V(x, 800, z))
    const front = add(V(0, 400, 0), V(600, 400, 0))
    const back = add(V(0, 400, 400), V(600, 400, 400))
    add(V(600, 400, 0), V(600, 400, 400))
    add(V(30, 400, 31), V(30, 400, 369))
    const expected = prepareProfile(V(0, 400, 0), V(0, 400, 400), '2020', profiles)!
    const doc: Doc = { profiles, connectors: [], panels: [], fittings: [] }
    const suggestions = [...suggestNext(doc, [front.id, back.id])]
    expect(suggestions.some((c) => same(c.member, expected))).toBe(true)
    for (const c of suggestions) expect(faultsOf(doc, c)).toEqual([])
  })

  it('keeps an open copy derived from the selected template when an earlier template proposes the same route', () => {
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
    const profiles: ProfileData[] = []
    const add = (s: THREE.Vector3, e: THREE.Vector3) => {
      const p = prepareProfile(s, e, '2020', profiles)!
      profiles.push(p)
      return p
    }
    add(V(0, 200, 0), V(0, 200, 400))
    const selected = add(V(1200, 200, 0), V(1200, 200, 400))
    add(V(0, 200, 0), V(600, 200, 0))
    add(V(1200, 200, 0), V(600, 200, 0))
    const expected = prepareProfile(V(600, 200, 0), V(600, 200, 400), '2020', profiles, { twin: selected })!
    const doc: Doc = { profiles, connectors: [], panels: [], fittings: [] }
    const c = [...suggestNext(doc, [selected.id])].find((s) => same(s.member, expected))
    expect(c).toBeTruthy()
    expect(c!.anchors[0]).toBe(selected.id)
    expect(faultsOf(doc, c!)).toEqual([])
  })

  it.each(['2020', '2040'] as const)('reconstructs a %s mid-span mounting rail from placed brackets and rejects a different empty route', (spec) => {
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
    const posts: ProfileData[] = []
    for (const x of [0, 600]) for (const z of [0, 400]) posts.push(prepareProfile(V(x, 0, z), V(x, 800, z), spec, posts)!)
    const left = prepareProfile(V(0, 200, 0), V(0, 200, 400), spec, posts)!
    const right = prepareProfile(V(600, 200, 0), V(600, 200, 400), spec, posts)!
    const full = [...posts, left, right]
    const connectors: ConnectorData[] = [left, right].flatMap((rail) => Object.values(getProfileEndpoints(rail)).map((at, i) => {
      const post = posts.find((p) => p.position[0] === rail.position[0] && p.position[2] === Math.round(at.z))!
      const seat = seatFor('inside-corner', rail, post, at)!
      return { id: `${rail.id}-bracket-${i}`, type: 'inside-corner', ...seat }
    }))
    expect(auditBrackets(full, connectors)).toEqual([])
    const doc: Doc = { profiles: [...posts, right], connectors, panels: [], fittings: [] }
    const faults = auditBrackets(doc.profiles, connectors)
    expect(faults).toHaveLength(2)
    const c = suggestNext(doc, []).next().value as Candidate
    expect(same(c.member, left)).toBe(true)
    expect(Math.abs(new THREE.Quaternion(...c.member.quaternion).dot(new THREE.Quaternion(...left.quaternion)))).toBeGreaterThan(0.999999)
    expect(auditBrackets([...doc.profiles, c.member], connectors)).toEqual([])
    expect(faultsOf(doc, c)).toEqual([])
    const wrong = prepareProfile(V(0, 260, 0), V(0, 260, 400), spec, doc.profiles)!
    expect(vet(wrong, { kind: 'close', hardwareId: faults[0].id }, doc)).toEqual({ ok: false, why: 'hardware-not-restored' })
  })

  /**
   * Remove each fixture member in turn and use up to three preceding members as focus.
   * Measure supported members among the first three suggestions. Members that require
   * an unavailable B6/I8 adapter must remain absent from the suggestions.
   */
  it('meets first-choice and top-three thresholds for supported fixture members', async () => {
    let n = 0, top1 = 0, top3 = 0, unsupported = 0
    const bad: string[] = []
    for (const name of files) {
      const doc = docs.get(name)!
      const unavailable = unsupportedMixedMembers(doc)
      for (let i = 0; i < doc.profiles.length; i++) {
        const gone = doc.profiles[i]
        const rest = { ...doc, profiles: doc.profiles.filter((_, j) => j !== i) }
        const focus = doc.profiles.slice(Math.max(0, i - 3), i).reverse().map((p) => p.id)
        const top = first(suggestNext(rest, focus), 3)
        const k = top.findIndex((c) => same(c.member, gone))
        if (unavailable.has(gone.id)) {
          unsupported++
          expect(vet(gone, { kind: 'close' }, rest)).toEqual({ ok: false, why: 'unbuildable' })
          expect(k).toBe(-1)
        } else {
          n++
          if (k === 0) top1++
          if (k >= 0) top3++
        }
        // what it offers first is judged in full, whether it was the member taken out or not
        if (top[0]) for (const f of faultsOf(rest, top[0])) bad.push(`${name} #${i}: ${top[0].rule} ${top[0].member.spec}@${top[0].member.position.map(Math.round)} — ${f}`)
        // Let the worker report progress during the exhaustive geometry checks.
        if (i % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }
    expect(bad).toEqual([])
    expect(n).toBeGreaterThan(600)
    expect(unsupported).toBe(143)
    expect(top1 / n).toBeGreaterThanOrEqual(0.7)
    expect(top3 / n).toBeGreaterThanOrEqual(0.85)
  }, 180_000)

  /** Validate proposed reinforcing rails and supports against the geometry checks. */
  describe.each(files)('%s, finished', (name) => {
    it('returns distinct candidates that pass the configured geometry checks', () => {
      const doc = docs.get(name)!
      const all = [...suggestNext(doc, focusOf(doc.profiles, []))]
      expect(new Set(all.map((c) => c.key)).size).toBe(all.length)
      for (const c of all) expect(faultsOf(doc, c)).toEqual([])
    })
  })

  it('rejects 2020-to-4040 joins under the supported section rules', () => {
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
    const ps: ProfileData[] = []
    const add = (a: THREE.Vector3, b: THREE.Vector3, spec: ProfileSpec) => ps.push(prepareProfile(a, b, spec, ps)!)
    // two 4040 posts a rail's length apart, and the only rail of that length is a 2020
    add(V(0, 0, 0), V(0, 800, 0), '4040')
    add(V(600, 0, 0), V(600, 800, 0), '4040')
    add(V(0, 10, 900), V(600, 10, 900), '2020')
    const doc = { profiles: ps, connectors: [], panels: [], fittings: [] }
    for (const c of suggestNext(doc, [])) {
      const e = getProfileEndpoints(c.member)
      for (const p of ps) {
        if (!noEdge(c.member.spec, p.spec)) continue
        const q = getProfileEndpoints(p)
        const seg = new THREE.Line3(q.start, q.end)
        for (const pt of [e.start, e.end]) expect(seg.closestPointToPoint(pt, true, new THREE.Vector3()).distanceTo(pt)).toBeGreaterThan(30)
      }
    }
  })

  it.each([['2040', false], ['3030', true]] as const)('checks actual slot compatibility before suggesting a %s rail between 4040 posts', (spec, supported) => {
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
    const profiles: ProfileData[] = []
    for (const x of [0, 600]) profiles.push(prepareProfile(V(x, 0, 0), V(x, 800, 0), '4040', profiles)!)
    const height = 800 - Number(spec.slice(2)) / 2
    const template = prepareProfile(V(0, height, 900), V(600, height, 900), spec, profiles)!
    profiles.push(template)
    const candidate = prepareProfile(V(0, height, 0), V(600, height, 0), spec, profiles)!
    const doc: Doc = { profiles, connectors: [], panels: [], fittings: [] }
    expect(vet(candidate, { kind: 'close' }, doc)).toEqual(supported ? { ok: true } : { ok: false, why: 'unbuildable' })
    const suggestions = [...suggestNext(doc, [])]
    expect(suggestions.some((item) => same(item.member, candidate))).toBe(supported)
    for (const item of suggestions) expect(faultsOf(doc, item)).toEqual([])
  })

  /**
   * Four members drawn by hand, and then nothing but accepting what is offered. The box
   * closes, and at no step is the drawing any worse than it was.
   */
  it.each([['2020', 0], ['2040', 0], ['2020', 10], ['2040', 10]] as const)('closes a %s box from four members by accepting, posts from y=%i', (spec, postFoot) => {
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
    let ps: ProfileData[] = []
    const add = (a: THREE.Vector3, b: THREE.Vector3) => { ps = [...ps, prepareProfile(a, b, spec, ps)!] }
    const h = Number(spec.slice(2)) / 2
    add(V(0, h, 0), V(600, h, 0))
    add(V(0, h, 0), V(0, h, 400))
    add(V(0, postFoot, 0), V(0, 700, 0))
    add(V(600, postFoot, 0), V(600, 700, 0))
    let accepts = 0
    while (ps.length < 12 && accepts < 10) {
      const doc = { profiles: ps, connectors: [], panels: [], fittings: [] }
      const c = suggestNext(doc, focusOf(ps, [ps[ps.length - 1].id])).next().value as Candidate | undefined
      if (!c) break
      expect(faultsOf(doc, c)).toEqual([])
      ps = [...ps, c.member]
      accepts++
    }
    expect(ps.length).toBe(12)
    expect(accepts).toBeLessThanOrEqual(8)
    expect(findConflicts(ps, computeAllTrims(ps))).toEqual([])
    expect(countUnflush(ps)).toBe(0)
  })

  it('meets the median suggestion-time limit for each numbered fixture', () => {
    const slow: string[] = [], measured: string[] = []
    for (const name of files.filter((f) => /^\d\d-/.test(f))) {
      const doc = docs.get(name)!
      let worst = 0, worstIndex = -1
      let worstTimings: number[] = []
      for (let i = 0; i < doc.profiles.length; i += 3) {
        const rest = { ...doc, profiles: doc.profiles.filter((_, j) => j !== i) }
        // Keep the 50 ms budget for every scene. Three independent searches distinguish
        // persistent CPU cost from a single garbage-collection or scheduling pause.
        const timings: number[] = []
        for (let run = 0; run < 3; run++) {
          const t0 = performance.now()
          suggestNext(rest, focusOf(rest.profiles, [])).next()
          timings.push(performance.now() - t0)
        }
        const median = [...timings].sort((a, b) => a - b)[1]
        if (median > worst) { worst = median; worstIndex = i; worstTimings = timings }
      }
      measured.push(`${name}: ${worst.toFixed(2)} ms (member ${worstIndex}; ${worstTimings.map((t) => t.toFixed(2)).join("/")})`)
      if (worst > 50) slow.push(`${name} ${worst.toFixed(0)} ms`)
    }
    console.info(measured.join('; '))
    expect(slow).toEqual([])
  }, 30_000)

  it('a key turned down comes last, and the same member keeps the same key', () => {
    // A partial box is independent of file member order and of later support additions.
    const profiles: ProfileData[] = []
    const add = (a: number[], b: number[]) => profiles.push(prepareProfile(new THREE.Vector3(...a), new THREE.Vector3(...b), '2020', profiles)!)
    add([0, 10, 0], [600, 10, 0])
    add([0, 10, 0], [0, 10, 400])
    add([0, 0, 0], [0, 700, 0])
    add([600, 0, 0], [600, 700, 0])
    const rest: Doc = { profiles, connectors: [], panels: [], fittings: [] }
    const focus = focusOf(rest.profiles, [])
    const [a, b] = first(suggestNext(rest, focus), 2)
    expect(a).toBeTruthy()
    expect(first(suggestNext(rest, focus), 1)[0].key).toBe(a.key)
    const next = first(suggestNext(rest, focus, new Set([a.key])), 1)[0]
    if (b) expect(next.key).toBe(b.key)
    else expect(next.key).toBe(a.key)
  })
})
