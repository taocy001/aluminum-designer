import type { ConnectorData, ProfileSpec } from '../store/useStore'
import { specDims } from './specUtils'
import { insideCornerDimensions, bracketDimensions } from './connectorHardware'
import { connectorMeshes } from './connectorGeometry'
import * as THREE from 'three'
import { accessoryMountPoints } from './connectorAccessoryReferences'

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

export interface ConnectorSpecEntry {
  type: string
  labelZh: string
  labelEn: string
  fit: ConnectorFit
  /** Model axes defined in connectorGeometry.ts. */
  axes: FitAxes
  /** a bracket in the sense of "what a butt joint needs" */
  isCornerBracket?: boolean
  /** how it meets the metal, which is what decides where it goes */
  seat: SeatKind
}

export const CONNECTOR_CATALOG: ConnectorSpecEntry[] = [
  // arms along +X and +Y
  { type: 'bracket',       labelZh: 'L型角码',   labelEn: 'L-Bracket',     fit: 'corner', seat: 'angle', axes: { primary: 'x', secondary: 'y' }, isCornerBracket: true },
  { type: 'inside-corner', labelZh: '内角码',     labelEn: 'Inside Corner', fit: 'corner', seat: 'angle', axes: { primary: 'x', secondary: 'y' }, isCornerBracket: true },
  { type: 'gusset',        labelZh: '加强角码',   labelEn: 'Gusset Bracket', fit: 'corner', seat: 'angle', axes: { primary: 'x', secondary: 'y' } },
  // the T's crossbar lies along X on the through member, the stem along Y on the branch
  { type: 't-bracket',     labelZh: 'T型角码',    labelEn: 'T-Bracket',     fit: 'corner', seat: 'plate', axes: { primary: 'y', secondary: 'x' }, isCornerBracket: true },
  { type: 'corner-3way',   labelZh: '三维角码',   labelEn: '3-Way Corner',  fit: 'corner', seat: 'angle', axes: { primary: 'x', secondary: 'y' }, isCornerBracket: true },
  // plates that bridge two members end to end: the long side runs along the member
  { type: 'flat-plate',    labelZh: '直连板',     labelEn: 'Flat Plate',    fit: 'face', seat: 'surface', axes: { primary: 'y', secondary: 'x' } },
  { type: 'joining-plate', labelZh: '对接板',     labelEn: 'Joining Plate', fit: 'face', seat: 'surface', axes: { primary: 'x', secondary: 'z' } },
  { type: 'end-cap',       labelZh: '端盖',       labelEn: 'End Cap',       fit: 'inline', seat: 'inline', axes: { primary: 'z' } },
  // Parts under a post: local +Y points toward the post's bottom mounting face.
  { type: 'caster-mount',  labelZh: '脚轮',       labelEn: 'Caster',        fit: 'inline', seat: 'inline', axes: { primary: 'y', towards: 'in' } },
  { type: 'foot',          labelZh: '调节脚',     labelEn: 'Leveling Foot', fit: 'inline', seat: 'inline', axes: { primary: 'y', towards: 'in' } },
  // plates lying against a face: `primary` is the plate normal
  { type: 'cross-bracket', labelZh: '十字连接板', labelEn: 'Cross Plate',   fit: 'face',   seat: 'surface', axes: { primary: 'z' } },
  { type: 't-nut',         labelZh: '滑块螺母',   labelEn: 'T-Nut',         fit: 'face',   seat: 'surface', axes: { primary: 'y', secondary: 'z' } },
  { type: 'hinge',         labelZh: '合页',       labelEn: 'Hinge',         fit: 'face',   seat: 'surface', axes: { primary: 'x', secondary: 'z' } },
  { type: 'pivot',         labelZh: '轴承座',     labelEn: 'Pivot',         fit: 'face',   seat: 'surface', axes: { primary: 'y' } },
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

/** Hardware family follows the slot system, independently of the outside dimensions. */
export function seriesOf(spec: ProfileSpec): ConnectorSeries {
  if (spec === '4040-B6') return 20
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
  const part = insideCornerDimensions(series), scale = connectorScale(series)
  return { depth: part.depth / scale, width: part.shoulderWidth / scale }
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

export function connectorMounts(type: string, series: ConnectorSeries = 20): ConnectorMount[] {
  const k = connectorScale(series)
  const normalized = (mounts: ConnectorMount[]) => mounts.map((m) => ({ ...m,
    bolts: m.bolts.map((v) => v.map((n) => n / k) as [number, number, number]) }))
  if (type === 'inside-corner') {
    const d = insideCornerDimensions(series)
    return normalized([
      { axis: 'x', normal: 'y', bolts: [[d.xScrew, 0, 0]] },
      { axis: 'y', normal: 'x', bolts: [[0, d.yScrew, 0]] },
    ])
  }
  if (type === 'bracket' || type === 'gusset') {
    const hole = type === 'gusset' ? 20 : bracketDimensions(series)?.slotCentre ?? 16
    return normalized([
      { axis: 'x', normal: 'y', bolts: [[hole, 0, 0]] },
      { axis: 'y', normal: 'x', bolts: [[0, hole, 0]] },
    ])
  }
  if (type === 'corner-3way') return normalized([
    { axis: 'x', normal: 'x', bolts: [[-20, 0, 0]] },
    { axis: 'y', normal: 'y', bolts: [[0, -20, 0]] },
    { axis: 'z', normal: 'z', bolts: [[0, 0, -20]] },
  ])
  const accessory = accessoryMountPoints(type, series)
  if (accessory) return normalized(accessory)
  return []
}

/** Envelope of the same meshes used for rendering and export, in local units. */
const extentCache = new Map<string, { centre: [number, number, number]; half: [number, number, number] }>()
export function connectorExtent(type: string, series: ConnectorSeries = 20, profileSpec?: ProfileSpec, mountSeries?: ConnectorData['mountSeries']) {
  const key = `${type}-${series}-${profileSpec ?? ''}-${mountSeries ?? ''}`
  let bounds = extentCache.get(key)
  if (!bounds) {
    const box = new THREE.Box3()
    for (const { geometry } of connectorMeshes(type, series, profileSpec, mountSeries)) {
      geometry.computeBoundingBox()
      if (geometry.boundingBox) box.union(geometry.boundingBox)
    }
    bounds = { centre: box.getCenter(new THREE.Vector3()).toArray(),
      half: box.getSize(new THREE.Vector3()).multiplyScalar(0.5).toArray() }
    extentCache.set(key, bounds)
  }
  return bounds
}
