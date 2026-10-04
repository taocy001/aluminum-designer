import type { ProfileSpec } from '../store/useStore'
import { profileSlotDimensions, specDims } from './specUtils'

/** Extrusion series a connector is made for: 20, 30 or 40 */
export type ConnectorSeries = 20 | 30 | 40

/**
 * How a connector wants to sit on the frame. Each part is modelled in its own way, so the
 * fit also records which of the part's own axes carries the meaning — guessing a convention
 * and hoping the geometry matches is how parts end up mounted edge-on.
 *
 *  - 'corner': two arms run back along two members meeting at a point
 *  - 'inline': one axis runs along a single member, pointing outward
 *  - 'face':   a plate lies against a member, its normal out of the mounting face
 *  - 'free':   no inference, placed as dropped
 */
export type ConnectorFit = 'corner' | 'inline' | 'face' | 'free'

/**
 * How a part meets the metal — the thing that decides where it actually goes.
 *
 *  - `angle`: two flanges at ninety degrees, sitting in the **inside** of the corner. One
 *    flange lies on the face of A that looks towards B, the other on the face of B that looks
 *    towards A. This is the ordinary cast corner bracket.
 *  - `plate`: one flat plate lying across the **outside** face the two members share, both
 *    bolts in that one plane. Needs a coplanar face; an angle bracket does not.
 *  - `inline`: on the end of one member, along its axis.
 *  - `surface`: flat against one face of one member, wherever it is put.
 */
export type SeatKind = 'angle' | 'plate' | 'inline' | 'surface'

/** A local axis of the modelled part */
export type LocalAxis = 'x' | 'y' | 'z' | '-x' | '-y' | '-z'

export interface FitAxes {
  /** corner: the two arms. inline: [alongMember]. face: [plateNormal, alongMember?] */
  primary: LocalAxis
  secondary?: LocalAxis
  /**
   * inline parts only: does the primary axis point out of the member's end, or back into it?
   * An end cap faces out; a levelling foot's mounting face points up toward its post.
   */
  towards?: 'out' | 'in'
}

export interface FastenerRecipe {
  /** bolts per connector, with the thread that matches the series */
  bolts: number
  /** T-slot nuts per connector */
  nuts: number
}

export interface ConnectorSpecEntry {
  type: string
  labelZh: string
  labelEn: string
  fit: ConnectorFit
  /** Model axes defined in connectorGeometry.ts. */
  axes: FitAxes
  fasteners: FastenerRecipe
  /** a bracket in the sense of "what a butt joint needs" */
  isCornerBracket?: boolean
  /** how it meets the metal, which is what decides where it goes */
  seat: SeatKind
}

export const CONNECTOR_CATALOG: ConnectorSpecEntry[] = [
  // arms along +X and +Y
  { type: 'bracket',       labelZh: 'L型角码',   labelEn: 'L-Bracket',     fit: 'corner', seat: 'angle', axes: { primary: 'x', secondary: 'y' }, fasteners: { bolts: 2, nuts: 2 }, isCornerBracket: true },
  { type: 'inside-corner', labelZh: '内角码',     labelEn: 'Inside Corner', fit: 'corner', seat: 'angle', axes: { primary: 'x', secondary: 'y' }, fasteners: { bolts: 2, nuts: 2 }, isCornerBracket: true },
  { type: 'gusset',        labelZh: '加强筋',     labelEn: 'Gusset',        fit: 'corner', seat: 'plate', axes: { primary: 'x', secondary: 'y' }, fasteners: { bolts: 2, nuts: 2 } },
  // the T's crossbar lies along X on the through member, the stem along Y on the branch
  { type: 't-bracket',     labelZh: 'T型角码',    labelEn: 'T-Bracket',     fit: 'corner', seat: 'plate', axes: { primary: 'y', secondary: 'x' }, fasteners: { bolts: 3, nuts: 3 }, isCornerBracket: true },
  { type: 'corner-3way',   labelZh: '三维角码',   labelEn: '3-Way Corner',  fit: 'corner', seat: 'angle', axes: { primary: 'x', secondary: 'y' }, fasteners: { bolts: 3, nuts: 3 }, isCornerBracket: true },
  // plates that bridge two members end to end: the long side runs along the member
  { type: 'flat-plate',    labelZh: '直连板',     labelEn: 'Flat Plate',    fit: 'inline', seat: 'inline', axes: { primary: 'x' }, fasteners: { bolts: 4, nuts: 4 } },
  { type: 'joining-plate', labelZh: '对接板',     labelEn: 'Joining Plate', fit: 'inline', seat: 'inline', axes: { primary: 'z' }, fasteners: { bolts: 2, nuts: 2 } },
  { type: 'end-cap',       labelZh: '端盖',       labelEn: 'End Cap',       fit: 'inline', seat: 'inline', axes: { primary: 'z' }, fasteners: { bolts: 0, nuts: 0 } },
  // Parts under a post: local +Y points toward the post's bottom mounting face.
  { type: 'caster-mount',  labelZh: '脚轮座',     labelEn: 'Caster Mount',  fit: 'inline', seat: 'inline', axes: { primary: 'y', towards: 'in' }, fasteners: { bolts: 4, nuts: 4 } },
  { type: 'foot',          labelZh: '调节脚',     labelEn: 'Leveling Foot', fit: 'inline', seat: 'inline', axes: { primary: 'y', towards: 'in' }, fasteners: { bolts: 1, nuts: 1 } },
  // plates lying against a face: `primary` is the plate normal
  { type: 'cross-bracket', labelZh: '十字连接板', labelEn: 'Cross Plate',   fit: 'face',   seat: 'surface', axes: { primary: 'z' }, fasteners: { bolts: 4, nuts: 4 } },
  { type: 't-nut',         labelZh: '滑块螺母',   labelEn: 'T-Nut',         fit: 'face',   seat: 'surface', axes: { primary: 'y' }, fasteners: { bolts: 1, nuts: 0 } },
  { type: 'hinge',         labelZh: '合页',       labelEn: 'Hinge',         fit: 'face',   seat: 'surface', axes: { primary: 'x', secondary: 'z' }, fasteners: { bolts: 4, nuts: 4 } },
  { type: 'pivot',         labelZh: '轴承座',     labelEn: 'Pivot',         fit: 'face',   seat: 'surface', axes: { primary: 'y' }, fasteners: { bolts: 2, nuts: 2 } },
]

const BY_TYPE = new Map(CONNECTOR_CATALOG.map((c) => [c.type, c]))

export function connectorEntry(type: string): ConnectorSpecEntry | undefined {
  return BY_TYPE.get(type)
}

export function connectorLabel(type: string, language: 'zh' | 'en'): string {
  const e = BY_TYPE.get(type)
  if (!e) return type
  return language === 'zh' ? e.labelZh : e.labelEn
}

/** The series a profile spec belongs to: 2020 and 2040 are 20 series, 4040 is 40 */
export function seriesOf(spec: ProfileSpec): ConnectorSeries {
  const { w, h } = specDims(spec)
  const base = Math.min(w, h)
  return base >= 40 ? 40 : base >= 30 ? 30 : 20
}

/** Instance scale relative to the 20 series; slot insert sections compensate for this scale. */
export function connectorScale(series: ConnectorSeries): number {
  return series / 20
}

/** Local insert section before instance scaling; its physical size matches the series slot cavity. */
export function insideCornerSection(series: ConnectorSeries = 20): { depth: number; width: number } {
  const slot = profileSlotDimensions(series), scale = connectorScale(series)
  return { depth: slot.depth / scale, width: slot.width / scale }
}

/** Thread that goes with a series, the way suppliers pair them */
export function boltThread(series: ConnectorSeries): string {
  return series === 40 ? 'M8' : series === 30 ? 'M6' : 'M5'
}

/** Typical bolt length for the outside-bracket case */
export function boltLength(series: ConnectorSeries): number {
  return series === 40 ? 16 : series === 30 ? 12 : 10
}

export function boltLabel(series: ConnectorSeries, language: 'zh' | 'en'): string {
  const name = `${boltThread(series)}×${boltLength(series)}`
  return language === 'zh' ? `螺栓 ${name}` : `Bolt ${name}`
}

export function nutLabel(series: ConnectorSeries, language: 'zh' | 'en'): string {
  return language === 'zh' ? `T型螺母 ${boltThread(series)}` : `T-nut ${boltThread(series)}`
}

/** Contact points on the mounting surface, in the unscaled connector frame. */
export interface ConnectorMount {
  axis: 'x' | 'y' | 'z'
  normal: 'x' | 'y' | 'z'
  bolts: [number, number, number][]
}

export function connectorMounts(type: string): ConnectorMount[] {
  if (type === 't-bracket') return [
    { axis: 'x', normal: 'z', bolts: [[-22, 0, 0], [22, 0, 0]] },
    { axis: 'y', normal: 'z', bolts: [[0, 28, 0]] },
  ]
  if (type === 'gusset') return [
    { axis: 'x', normal: 'z', bolts: [[18, 0, 0]] },
    { axis: 'y', normal: 'z', bolts: [[0, 18, 0]] },
  ]
  if (connectorEntry(type)?.seat === 'angle') return [
    { axis: 'x', normal: 'y', bolts: [[16, 0, 0]] },
    { axis: 'y', normal: 'x', bolts: [[0, 16, 0]] },
    ...(type === 'corner-3way' ? [{ axis: 'z', normal: 'y', bolts: [[0, 0, 16]] } as ConnectorMount] : []),
  ]
  return []
}

/**
 * Approximate connector collision boxes in local coordinates.
 * Angle brackets originate at the inner flange vertex; plates at the intersection of their bolt lines.
 */
export function connectorExtent(type: string, series: ConnectorSeries = 20): { centre: [number, number, number]; half: [number, number, number] } {
  // The cap's plate is 20×20×3, with a 10×10×6 plug centred at local Z=4.
  if (type === 'end-cap') return { centre: [0, 0, 2.75], half: [10, 10, 4.25] }
  // The broad-phase envelope includes both inserts and their exposed connecting heel.
  if (type === 'inside-corner') {
    const { depth, width } = insideCornerSection(series)
    return { centre: [(20 - depth) / 2, (20 - depth) / 2, 0], half: [(20 + depth) / 2, (20 + depth) / 2, width / 2] }
  }
  if (type === 'gusset') return { centre: [11, 11, 2], half: [19, 19, 2] }
  if (type === 't-bracket') return { centre: [0, 15, 2], half: [35, 25, 2] }
  if (type === 'corner-3way') return { centre: [8, 9, 8], half: [12, 11, 12] }
  if (type === 'flat-plate') return { centre: [0, 1.75, 0], half: [30, 3.75, 9] }
  if (type === 'joining-plate') return { centre: [0, 0, 0], half: [3, 8, 25] }
  if (type === 'cross-bracket') return { centre: [0, 0, 0], half: [24, 24, 2] }
  if (type === 'hinge') return { centre: [0, 0, 0], half: [3, 15, 16] }
  if (type === 'pivot') return { centre: [0, 2, 0], half: [15, 8, 10] }
  if (type === 'caster-mount') return { centre: [0, -12, 0], half: [20, 14, 20] }
  if (type === 'foot') return { centre: [0, 12.5, 0], half: [18, 15.5, 18] }
  if (type === 't-nut') return { centre: [0, 1, 0], half: [9, 9, 3.5] }
  switch (connectorEntry(type)?.seat) {
    case 'angle':
      // two flanges reaching 30 out of the vertex, 18 across
      return { centre: [15, 15, 0], half: [15, 15, 9] }
    case 'plate':
      return { centre: [10, 10, 2], half: [20, 20, 2] }
    case 'inline':
      return { centre: [0, 0, 0], half: [30, 10, 10] }
    default: {
      // Offset face-mounted envelopes along the primary axis; T-nuts stay slot-centered.
      const entry = connectorEntry(type)
      const axis = entry?.axes.primary ?? 'z'
      const centre: [number, number, number] = [0, 0, 0]
      if (type !== 't-nut') centre[axis === 'x' ? 0 : axis === 'y' ? 1 : 2] = 12
      return { centre, half: [12, 12, 12] }
    }
  }
}
