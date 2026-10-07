import type { ProfileSpec } from '../store/useStore'

export const ALL_SPECS: ProfileSpec[] = ['2020', '2040', '3030', '3040', '4040', '4040-B6']

type SectionDimensions = Readonly<{ w: number; h: number; hw: number; hh: number }>
const sectionDimensions = new Map<string, SectionDimensions>(ALL_SPECS.map((spec) => {
  const w = Number(spec.substring(0, 2)), h = Number(spec.substring(2, 4))
  return [spec, Object.freeze({ w, h, hw: w / 2, hh: h / 2 })]
}))

/** Cross-section dimensions (mm) for a spec such as "2040" → w=20, h=40 */
export function specDims(spec: string): SectionDimensions {
  const known = sectionDimensions.get(spec)
  if (known) return known
  const w = Number(spec.substring(0, 2)) || 20
  const h = Number(spec.substring(2, 4)) || w
  return { w, h, hw: w / 2, hh: h / 2 }
}

export interface ProfileSlotDimensions {
  /** Nominal opening width. */
  width: number
  /** Distance from the reference face to the main cavity floor. */
  depth: number
  /** Distance from the reference face to the back of the retaining lip. */
  lipDepth: number
  /** Maximum cavity width; the CAD outline defines its chamfers and curved floor. */
  innerWidth: number
}

/** Measured from the Motedis B6/B8/I8 STEP sections in assets/profileSections.json. */
export function profileSlotDimensions(sectionWidth: number): ProfileSlotDimensions {
  if (sectionWidth >= 40) return { width: 8, depth: 12, lipDepth: 4.5, innerWidth: 20 }
  if (sectionWidth >= 30) return { width: 8, depth: 9, lipDepth: 2.2, innerWidth: 16.5 }
  return { width: 6, depth: 5.5, lipDepth: 1.5, innerWidth: 12 }
}

/** Slot centres follow the profile family's pitch, not a shared 20 mm subdivision. */
export function slotOffsets(faceWidth: number, series: 20 | 30 | 40 = 20): number[] {
  const n = Math.max(1, Math.floor(faceWidth / series))
  const pitch = faceWidth / n
  return Array.from({ length: n }, (_, i) => -faceWidth / 2 + (i + 0.5) * pitch)
}

/** The slot line nearest `want` on a face this wide. */
export function nearestSlot(faceWidth: number, want = 0, series: 20 | 30 | 40 = 20): number {
  return slotOffsets(faceWidth, series).reduce((best, s) => (Math.abs(s - want) < Math.abs(best - want) ? s : best))
}

/** Grid step used for all placement rounding (mm) */
export const GRID_STEP = 5

export function roundToGrid(v: number, step = GRID_STEP): number {
  return Math.round(v / step) * step
}
