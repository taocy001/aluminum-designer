import * as THREE from 'three'
import type { ProfileData } from '../store/useStore'
import { getProfileDir, getProfileEndpoints, closestOnSegment } from './geometryCore'
import { specDims } from './specUtils'

/** Young's modulus of the 6xxx aluminium these are extruded from (N/mm²) */
const E = 69000
/** kg → N */
const G = 9.80665
/** an end this close to another member's centreline is held up by it (mm) */
const SUPPORT_TOL = 30

export interface SectionProps {
  /** cross-sectional area (mm²) */
  area: number
  /** second moment of area with the long side of the section facing the load (mm⁴) */
  strong: number
  /** and the other way round */
  weak: number
}

/**
 * What each section is, as a beam.
 *
 * These are not measured off the outline this tool draws. That outline is solid but for the
 * slot notches — no central bore, no webs — so its second moment comes out about half again
 * too stiff, and a deflection figure that flatters the design is worse than no figure at all.
 * The numbers below are the typical published values for the common European T-slot series,
 * slot 6 on the 20s and slot 8 on the 30s and 40s. Manufacturers differ by roughly a tenth
 * either way, which matters far less than the difference between a 2020 and a 2040.
 */
const SECTIONS: Record<string, SectionProps> = {
  '2020': { area: 160, strong: 7000, weak: 7000 },
  '2040': { area: 286, strong: 48000, weak: 13000 },
  '3030': { area: 258, strong: 30000, weak: 30000 },
  '3040': { area: 340, strong: 65000, weak: 40000 },
  '4040': { area: 384, strong: 85000, weak: 85000 },
}

export function sectionProps(spec: string): SectionProps {
  const known = SECTIONS[spec]
  if (known) return known
  // an unlisted section falls back to the solid rectangle, halved — the same proportion the
  // listed ones bear to their own solid, so an addition to the catalogue is never wildly out
  const { w, h } = specDims(spec)
  return { area: w * h * 0.4, strong: (w * h ** 3) / 24, weak: (h * w ** 3) / 24 }
}

/** What a metre of it weighs (kg), from its area at the density of aluminium */
export function massPerMetre(spec: string): number {
  return sectionProps(spec).area * 0.0027
}

/** closest approach between two segments, as the parameter along the first (0…|ab|) */
function closestParam(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3): { t: number; dist: number } {
  const u = b.clone().sub(a)
  const v = d.clone().sub(c)
  const w0 = a.clone().sub(c)
  const A = u.dot(u), B = u.dot(v), C = v.dot(v), D = u.dot(w0), Ee = v.dot(w0)
  const den = A * C - B * B
  let sc: number, tc: number
  if (Math.abs(den) < 1e-9) { sc = 0; tc = C > 1e-9 ? Ee / C : 0 }
  else { sc = (B * Ee - C * D) / den; tc = (A * Ee - B * D) / den }
  sc = Math.min(1, Math.max(0, sc))
  tc = Math.min(1, Math.max(0, tc))
  const pa = a.clone().addScaledVector(u, sc)
  const pb = c.clone().addScaledVector(v, tc)
  return { t: sc * Math.sqrt(A), dist: pa.distanceTo(pb) }
}

export type Support = 'simple' | 'cantilever' | 'none'

export interface Deflection {
  /** the span that bends (mm) */
  span: number
  support: Support
  /** the load put on it (kg), at mid-span or at the free end */
  load: number
  /** how far the middle (or the free end) drops (mm) */
  sag: number
  /** span ÷ sag, the number a builder actually judges by */
  ratio: number
  /** the second moment used, which depends on which way the section is turned */
  I: number
  /** true when the section is lying the weak way round and turning it would help */
  turnHelps: boolean
}

/**
 * Where along a member it is held up.
 *
 * Not just its two ends: a rail running the length of a cabinet rests on every post it
 * crosses, and what bends is the longest gap between two of them. Measuring end to end
 * instead reported a kitchen wall rail as a 2.7 m span dropping ninety millimetres, when
 * three posts underneath it mean the worst span is the nine hundred left open for the hood.
 *
 * A member lying alongside is not a support, so anything parallel is ignored.
 */
interface Seg { id: string; start: THREE.Vector3; end: THREE.Vector3; dir: THREE.Vector3; mid: THREE.Vector3; reach: number }

function segmentOf(p: ProfileData): Seg {
  const { start, end } = getProfileEndpoints(p)
  return {
    id: p.id, start, end, dir: getProfileDir(p),
    mid: start.clone().add(end).multiplyScalar(0.5),
    reach: start.distanceTo(end) / 2,
  }
}

/** the members as segments, worked out once — asking each of them n times allocated n² vectors */
const segments = (all: ProfileData[]): Seg[] => all.map(segmentOf)

function supportsAlong(me: Seg, segs: Seg[]): number[] {
  const out: number[] = []
  for (const b of segs) {
    if (b.id === me.id) continue
    if (Math.abs(b.dir.dot(me.dir)) > 0.9) continue
    // two segments cannot touch if their midpoints are further apart than their two halves
    if (me.mid.distanceTo(b.mid) > me.reach + b.reach + SUPPORT_TOL) continue
    const near = closestParam(me.start, me.end, b.start, b.end)
    if (near.dist <= SUPPORT_TOL) out.push(near.t)
  }
  return out.sort((a, b) => a - b)
}

/**
 * How far a horizontal member sags under a load at its middle, plus its own weight.
 *
 * Null for anything that is not a beam: a post carries its load down its own axis, and a
 * member with nothing under either end is not spanning anything yet.
 */
export function deflect(p: ProfileData, all: ProfileData[], loadKg: number): Deflection | null {
  return deflectIn(p, segmentOf(p), segments(all), loadKg)
}

function deflectIn(p: ProfileData, me: Seg, segs: Seg[], loadKg: number): Deflection | null {
  if (Math.abs(me.dir.y) > 0.15) return null           // not horizontal: not a beam
  const held = supportsAlong(me, segs)
  if (held.length === 0) return null                    // nothing under it: not spanning yet

  // The worst of the two things that bend: the longest run between two supports, and the
  // longest tail hanging past the last one. A tail bends far more for its length, so they
  // are compared by how far each would actually drop, not by which is longer.
  let gap = 0
  for (let i = 1; i < held.length; i++) gap = Math.max(gap, held[i] - held[i - 1])
  const tail = Math.max(held[0], p.length - held[held.length - 1])

  const { w, h } = specDims(p.spec)
  const props = sectionProps(p.spec)
  // The load is straight down, so what resists it is the section's depth in world Y. Which
  // of the section's two axes stands up is decided by how the member was turned.
  const q = new THREE.Quaternion(...p.quaternion).normalize()
  const localX = new THREE.Vector3(1, 0, 0).applyQuaternion(q)
  const localY = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
  const depth = Math.abs(localY.y) >= Math.abs(localX.y) ? h : w
  const deep = depth >= Math.max(w, h) - 1e-6
  const I = deep ? props.strong : props.weak

  const F = loadKg * G                                  // N
  const wSelf = (massPerMetre(p.spec) * G) / 1000       // N/mm
  const simple = (L: number) => (F * L ** 3) / (48 * E * I) + (5 * wSelf * L ** 4) / (384 * E * I)
  const cantilever = (L: number) => (F * L ** 3) / (3 * E * I) + (wSelf * L ** 4) / (8 * E * I)

  const a = { span: gap, support: 'simple' as Support, sag: gap > 0 ? simple(gap) : 0 }
  const b = { span: tail, support: 'cantilever' as Support, sag: tail > 0 ? cantilever(tail) : 0 }
  const worst = b.sag > a.sag ? b : a
  if (worst.span <= 0) return null

  return {
    span: Math.round(worst.span),
    support: worst.support,
    load: loadKg,
    sag: Math.round(worst.sag * 100) / 100,
    ratio: worst.sag > 0 ? Math.round(worst.span / worst.sag) : Infinity,
    I,
    turnHelps: w !== h && !deep && props.strong > props.weak,
  }
}

/** the span/sag below which a shelf looks bent to the eye rather than merely calculated */
export const SLENDER = 200

/** Every horizontal member that sags more than one part in `SLENDER` under the given load */
export function saggingMembers(all: ProfileData[], loadKg: number): Array<{ id: string; d: Deflection }> {
  const segs = segments(all)
  const out: Array<{ id: string; d: Deflection }> = []
  for (const [i, p] of all.entries()) {
    const d = deflectIn(p, segs[i], segs, loadKg)
    if (d && d.ratio < SLENDER) out.push({ id: p.id, d })
  }
  return out.sort((a, b) => a.d.ratio - b.d.ratio)
}
