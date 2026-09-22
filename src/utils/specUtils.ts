import type { ProfileSpec } from '../store/useStore'

export const ALL_SPECS: ProfileSpec[] = ['2020', '2040', '3030', '3040', '4040']

/** Cross-section dimensions (mm) for a spec such as "2040" → w=20, h=40 */
export function specDims(spec: string): { w: number; h: number; hw: number; hh: number } {
  const w = Number(spec.substring(0, 2)) || 20
  const h = Number(spec.substring(2)) || w
  return { w, h, hw: w / 2, hh: h / 2 }
}

/**
 * Where the T-slots run across a face, measured from the middle of that face.
 *
 * A face carries one slot per 20 mm of width, evenly spaced — so a 20 face has a single slot
 * down the middle, and a 40 face has two, ten either side of the middle, with solid metal in
 * between. This is the same rule `getProfileShape` draws the section with, and it is the
 * reason a bracket cannot simply be centred on a 40 face: the bolt would land on the metal.
 */
export function slotOffsets(faceWidth: number): number[] {
  const n = Math.max(1, Math.floor(faceWidth / 20))
  const pitch = faceWidth / n
  return Array.from({ length: n }, (_, i) => -faceWidth / 2 + (i + 0.5) * pitch)
}

/** The slot line nearest `want` on a face this wide */
export function nearestSlot(faceWidth: number, want = 0): number {
  return slotOffsets(faceWidth).reduce((best, s) => (Math.abs(s - want) < Math.abs(best - want) ? s : best))
}

/** Grid step used for all placement rounding (mm) */
export const GRID_STEP = 5

export function roundToGrid(v: number, step = GRID_STEP): number {
  return Math.round(v / step) * step
}
