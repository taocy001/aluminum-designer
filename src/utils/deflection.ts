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

/** how many of a member's two ends are held up by something else */
function supportsOf(p: ProfileData, all: ProfileData[]): number {
  const { start, end } = getProfileEndpoints(p)
  let n = 0
  for (const at of [start, end]) {
    for (const b of all) {
      if (b.id === p.id) continue
      const eb = getProfileEndpoints(b)
      if (closestOnSegment(at, eb.start, eb.end).point.distanceTo(at) <= SUPPORT_TOL) { n++; break }
    }
  }
  return n
}

/**
 * How far a horizontal member sags under a load at its middle, plus its own weight.
 *
 * Null for anything that is not a beam: a post carries its load down its own axis, and a
 * member with nothing under either end is not spanning anything yet.
 */
export function deflect(p: ProfileData, all: ProfileData[], loadKg: number): Deflection | null {
  const dir = getProfileDir(p)
  if (Math.abs(dir.y) > 0.15) return null              // not horizontal: not a beam
  const held = supportsOf(p, all)
  const support: Support = held >= 2 ? 'simple' : held === 1 ? 'cantilever' : 'none'
  if (support === 'none') return null

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

  const L = p.length
  const F = loadKg * G                                  // N
  const wSelf = (massPerMetre(p.spec) * G) / 1000       // N/mm
  const sag = support === 'simple'
    ? (F * L ** 3) / (48 * E * I) + (5 * wSelf * L ** 4) / (384 * E * I)
    : (F * L ** 3) / (3 * E * I) + (wSelf * L ** 4) / (8 * E * I)

  return {
    span: L,
    support,
    load: loadKg,
    sag: Math.round(sag * 100) / 100,
    ratio: sag > 0 ? Math.round(L / sag) : Infinity,
    I,
    turnHelps: w !== h && !deep && props.strong > props.weak,
  }
}

/** the span/sag below which a shelf looks bent to the eye rather than merely calculated */
export const SLENDER = 200

/** Every horizontal member that sags more than one part in `SLENDER` under the given load */
export function saggingMembers(all: ProfileData[], loadKg: number): Array<{ id: string; d: Deflection }> {
  const out: Array<{ id: string; d: Deflection }> = []
  for (const p of all) {
    const d = deflect(p, all, loadKg)
    if (d && d.ratio < SLENDER) out.push({ id: p.id, d })
  }
  return out.sort((a, b) => a.d.ratio - b.d.ratio)
}
