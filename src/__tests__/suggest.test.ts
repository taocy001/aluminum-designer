import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { suggestNext, focusOf, type Candidate } from '../utils/suggest'
import { findConflicts } from '../utils/analysis'
import { computeAllTrims, trimmedBox } from '../utils/jointUtils'
import { getProfileEndpoints } from '../utils/geometryCore'
import { countUnflush } from '../utils/faceAlign'
import { prepareProfile } from '../utils/profileFactory'
import { migrateFittings } from '../utils/migrate'
import type { ConnectorData, FittingData, PanelData, ProfileData, ProfileSpec } from '../store/useStore'

interface Doc { profiles: ProfileData[]; connectors: ConnectorData[]; panels: PanelData[]; fittings: FittingData[] }

const loaded = import.meta.glob(['../../examples/*.json', '../../examples/flat/*.json'], { eager: true }) as Record<string, { default: Partial<Doc> & { profiles: ProfileData[] } }>
const docs = new Map<string, Doc>()
for (const [path, mod] of Object.entries(loaded)) {
  const name = path.split('/').pop()!
  if (name.startsWith('connector-demo')) continue     // a showcase, not a thing anybody builds
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
  for (let r = it.next(); !r.done && out.length < n; r = it.next()) out.push(r.value)
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
        return run >= size[axis] * 0.7 && m.max.y >= box.min.y - 2 && m.min.y <= box.max.y + 2
          && m.min[other] - 25 <= at && at <= m.max[other] + 25
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
    if (noEdge(m.spec, p.spec) && depth(mine.clone().expandByScalar(30), box) > 0) out.push(`2020 meets 4040 ${p.id}`)
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
  it('there are drawings to learn from', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  /**
   * Take each member out of each example in turn, point at the three drawn before it, and
   * ask. The member that was taken out is the answer a person would have wanted.
   */
  it('finds the member that was taken out: first most of the time, in the top three nearly always', () => {
    let n = 0, top1 = 0, top3 = 0
    const bad: string[] = []
    for (const name of files) {
      const doc = docs.get(name)!
      doc.profiles.forEach((gone, i) => {
        const rest = { ...doc, profiles: doc.profiles.filter((_, j) => j !== i) }
        const focus = doc.profiles.slice(Math.max(0, i - 3), i).reverse().map((p) => p.id)
        const top = first(suggestNext(rest, focus), 3)
        const k = top.findIndex((c) => same(c.member, gone))
        n++
        if (k === 0) top1++
        if (k >= 0) top3++
        // what it offers first is judged in full, whether it was the member taken out or not
        if (top[0]) for (const f of faultsOf(rest, top[0])) bad.push(`${name} #${i}: ${top[0].rule} ${top[0].member.spec}@${top[0].member.position.map(Math.round)} — ${f}`)
      })
    }
    expect(bad).toEqual([])
    expect(top1 / n).toBeGreaterThanOrEqual(0.7)
    expect(top3 / n).toBeGreaterThanOrEqual(0.85)
  })

  /**
   * A finished drawing has little left to add. The desk is allowed one more than the rest:
   * its knee space is open on purpose, and a floor rail across it passes every check there
   * is — only the person sitting there knows it is wrong.
   */
  describe.each(files)('%s, finished', (name) => {
    it('asks for at most one more member, and that one is sound', () => {
      const doc = docs.get(name)!
      const all = [...suggestNext(doc, focusOf(doc.profiles, []))]
      expect(all.length).toBeLessThanOrEqual(name.startsWith('desk-with-pedestal') ? 2 : 1)
      for (const c of all) expect(faultsOf(doc, c)).toEqual([])
    })
  })

  it('never joins a 2020 to a 4040: there is no part for it', () => {
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

  it('a press is quick on every cabinet of the flat', () => {
    const slow: string[] = []
    for (const name of files.filter((f) => /^\d\d-/.test(f))) {
      const doc = docs.get(name)!
      let worst = 0
      for (let i = 0; i < doc.profiles.length; i += 3) {
        const rest = { ...doc, profiles: doc.profiles.filter((_, j) => j !== i) }
        const t0 = performance.now()
        suggestNext(rest, focusOf(rest.profiles, [])).next()
        worst = Math.max(worst, performance.now() - t0)
      }
      if (worst > 50) slow.push(`${name} ${worst.toFixed(0)} ms`)
    }
    expect(slow).toEqual([])
  })

  it('a key turned down comes last, and the same member keeps the same key', () => {
    const doc = docs.get('01-kitchen-base.json')!
    const rest = { ...doc, profiles: doc.profiles.slice(0, -1) }
    const focus = focusOf(rest.profiles, [])
    const [a, b] = first(suggestNext(rest, focus), 2)
    expect(a).toBeTruthy()
    expect(first(suggestNext(rest, focus), 1)[0].key).toBe(a.key)
    const next = first(suggestNext(rest, focus, new Set([a.key])), 1)[0]
    if (b) expect(next.key).toBe(b.key)
    else expect(next.key).toBe(a.key)
  })
})
