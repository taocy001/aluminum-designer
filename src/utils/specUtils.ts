import type { ProfileSpec } from '../store/useStore'

export const ALL_SPECS: ProfileSpec[] = ['2020', '2040', '3030', '3040', '4040']

/** Cross-section dimensions (mm) for a spec such as "2040" → w=20, h=40 */
export function specDims(spec: string): { w: number; h: number; hw: number; hh: number } {
  const w = Number(spec.substring(0, 2)) || 20
  const h = Number(spec.substring(2)) || w
  return { w, h, hw: w / 2, hh: h / 2 }
}

/** Grid step used for all placement rounding (mm) */
export const GRID_STEP = 5

export function roundToGrid(v: number, step = GRID_STEP): number {
  return Math.round(v / step) * step
}
