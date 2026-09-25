import * as THREE from 'three'
import type { ConnectorData, FittingData, PanelData, ProfileData } from '../store/useStore'
import { findConflicts } from './analysis'
import { computeAllTrims, trimmedBox, type ProfileTrims } from './jointUtils'
import { getProfileAxis, getProfileEndpoints } from './geometryCore'
import { memberBox } from './dragSnap'
import { unflushPairs } from './faceAlign'
import { findSpecMismatches, sharedEdge } from './specCompat'
import { joints, unbuildable } from './repairJoints'
import { auditBrackets } from './bracketSeat'
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
  | { kind: 'close' }
  /** one end joins something, the other is left for the next member */
  | { kind: 'open' }

export interface Verdict { ok: boolean; why?: string }

/** how far round a new member anything it could disturb can be (mm) */
export const NEIGHBOURHOOD = 250
/** an end this close to the ground is standing on it (mm) */
const FLOOR_EPS = 1

function obbBox(o: OBB): THREE.Box3 {
  const r = new THREE.Vector3()
  for (let k = 0; k < 3; k++) {
    const h = o.half.getComponent(k)
    r.x += Math.abs(o.axes[k].x) * h; r.y += Math.abs(o.axes[k].y) * h; r.z += Math.abs(o.axes[k].z) * h
  }
  return new THREE.Box3(o.center.clone().sub(r), o.center.clone().add(r))
}

/** everything close enough to the new member to be affected by it */
export function neighbourhood(member: ProfileData, doc: SuggestDoc): SuggestDoc {
  const box = memberBox(member).expandByScalar(NEIGHBOURHOOD)
  return {
    profiles: doc.profiles.filter((p) => memberBox(p).intersectsBox(box)),
    connectors: doc.connectors.filter((c) => box.containsPoint(new THREE.Vector3(...c.position))),
    panels: doc.panels.filter((b) => panelBox(b).intersectsBox(box)),
    // what the fitting is made of, shut and fully open — its front laps outside its opening
    fittings: doc.fittings.filter((f) => [...fittingSolids(f, 0), ...fittingSolids(f, 1)].some((o) => obbBox(o).intersectsBox(box))),
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
 * Would adding this member leave the drawing worse anywhere?
 *
 * Asked of the neighbourhood, before and after, so a fault the drawing already had never
 * blocks a suggestion and a fault the suggestion would add always does. Every check the tool
 * makes of a finished drawing is made here, and with every door and drawer opened as well.
 */
export function vet(member: ProfileData, claim: Claim, doc: SuggestDoc, frame?: THREE.Box3 | null): Verdict {
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

  const near = neighbourhood(member, doc)
  const after = [...near.profiles, member]

  // pairs no part is made for are neither suggested nor counted
  for (const j of joints(after)) {
    if ((j.a.id === member.id || j.b.id === member.id) && !sharedEdge(j.a.spec, j.b.spec)) return { ok: false, why: 'no-shared-edge' }
  }

  const tb = computeAllTrims(near.profiles)
  const ta = computeAllTrims(after)
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

  // (a) nothing new passes through anything, shut and open
  const clashes = (ps: ProfileData[], t: Map<string, ProfileTrims>, fs: FittingData[]) =>
    new Set(findConflicts(ps, t, near.connectors, near.panels, fs).map((c) => pairKey(c.a, c.b)))
  let g = grew(clashes(near.profiles, tb, near.fittings), clashes(after, ta, near.fittings))
  if (g) return { ok: false, why: `clash ${g}` }
  const opened = near.fittings.map((f) => ({ ...f, open: 1 }))
  if (opened.length) {
    g = grew(clashes(near.profiles, tb, opened), clashes(after, ta, opened))
    if (g) return { ok: false, why: `clash-open ${g}` }
  }

  // (c) every joint it makes can be bolted
  if (unbuildable(after).some((j) => j.a.id === member.id || j.b.id === member.id)) return { ok: false, why: 'unbuildable' }

  // (d) nothing that could be bolted before stops being boltable
  const specOf = new Map(after.map((p) => [p.id, p.spec]))
  const shared = (a: string, b: string) => sharedEdge(specOf.get(a)!, specOf.get(b)!)
  const unflush = (ps: ProfileData[]) => unflushPairs(ps).filter((u) => shared(u.a, u.b)).map((u) => pairKey(u.a, u.b))
  g = grew(new Set(unflush(near.profiles)), unflush(after))
  if (g) return { ok: false, why: `unflush ${g}` }
  // a joint between two series is a note, not a fault — the drawing it copies has the same
  // ones — but faces that do not meet are a joint nothing can bolt
  const mism = (ps: ProfileData[]) => findSpecMismatches(ps).filter((m) => m.kind === 'face' && shared(m.a, m.b)).map((m) => pairKey(m.a, m.b))
  g = grew(new Set(mism(near.profiles)), mism(after))
  if (g) return { ok: false, why: `mismatch ${g}` }
  if (near.connectors.length) {
    const faults = (ps: ProfileData[]) => auditBrackets(ps, near.connectors).map((f) => f.id)
    g = grew(new Set(faults(near.profiles)), faults(after))
    if (g) return { ok: false, why: `bracket ${g}` }
  }

  // no corner is left empty
  g = grew(emptyCorners(near.profiles, tb), emptyCorners(after, ta))
  if (g) return { ok: false, why: `empty-corner ${g}` }

  // (g) a shelf rail carries the edge it was offered for, and no shelf loses one
  if (near.panels.length) {
    const was = new Set(shelfEdges(near.panels, near.profiles, tb).filter((e) => e.carried).map((e) => `${e.panelId}:${e.edge}`))
    const now = new Set(shelfEdges(near.panels, after, ta).filter((e) => e.carried).map((e) => `${e.panelId}:${e.edge}`))
    for (const k of was) if (!now.has(k)) return { ok: false, why: `shelf-lost ${k}` }
    if (claim.kind === 'shelf' && !now.has(`${claim.panelId}:${claim.edge}`)) return { ok: false, why: 'shelf-not-carried' }
  } else if (claim.kind === 'shelf') {
    return { ok: false, why: 'shelf-not-carried' }
  }
  return { ok: true }
}
