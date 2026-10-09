import { boardBlank, DEFAULT_FABRICATION } from './boardFabrication'
import { documentBoards } from './panelNesting'
import * as THREE from 'three'
import type { ConnectorData, FittingData, PanelData, ProfileData } from '../store/useStore'
import { computeAllTrims, type ProfileTrims, type ThroughRule } from './jointUtils'
import { fittingParts, fittingSolids } from './fittingGeometry'
import { connectorOBB, panelOBB, trimmedOBB } from './analysis'
import { obbCorners } from './obb'
import { fittingBoardNumber, partNumber } from './partNumbers'

/**
 * R12 ASCII DXF export using LINE and TEXT entities.
 * Includes front, top and right projections with overall dimensions and labelled board outlines.
 */

/** space between the three views, and around everything (mm) */
const GAP = 400
/** how tall the labels are (mm, drawing units) */
const TEXT_H = 60
/** dimension lines stand this far off the part */
const DIM_OFF = 140

type Pt = [number, number]

class Dxf {
  private out: string[] = []
  private layers = new Set<string>(['0'])

  line(layer: string, a: Pt, b: Pt): void {
    this.layers.add(layer)
    this.out.push('0\nLINE\n8\n' + layer
      + `\n10\n${n(a[0])}\n20\n${n(a[1])}\n30\n0\n11\n${n(b[0])}\n21\n${n(b[1])}\n31\n0`)
  }

  circle(layer: string, at: Pt, radius: number): void {
    this.layers.add(layer)
    this.out.push(`0\nCIRCLE\n8\n${layer}\n10\n${n(at[0])}\n20\n${n(at[1])}\n30\n0\n40\n${n(radius)}`)
  }

  rect(layer: string, min: Pt, max: Pt): void {
    this.line(layer, [min[0], min[1]], [max[0], min[1]])
    this.line(layer, [max[0], min[1]], [max[0], max[1]])
    this.line(layer, [max[0], max[1]], [min[0], max[1]])
    this.line(layer, [min[0], max[1]], [min[0], min[1]])
  }

  text(layer: string, at: Pt, s: string, height = TEXT_H): void {
    this.layers.add(layer)
    this.out.push('0\nTEXT\n8\n' + layer
      + `\n10\n${n(at[0])}\n20\n${n(at[1])}\n30\n0\n40\n${n(height)}\n1\n${escape(s)}`)
  }

  /** Draw dimensions as lines and text. */
  dim(layer: string, a: Pt, b: Pt, off: number, vertical = false): void {
    const label = n(Math.hypot(b[0] - a[0], b[1] - a[1]))
    if (vertical) {
      const x = Math.max(a[0], b[0]) + off
      this.line(layer, [a[0], a[1]], [x + 20, a[1]])
      this.line(layer, [b[0], b[1]], [x + 20, b[1]])
      this.line(layer, [x, a[1]], [x, b[1]])
      this.text(layer, [x + 30, (a[1] + b[1]) / 2 - TEXT_H / 2], label)
    } else {
      const y = Math.min(a[1], b[1]) - off
      this.line(layer, [a[0], a[1]], [a[0], y - 20])
      this.line(layer, [b[0], b[1]], [b[0], y - 20])
      this.line(layer, [a[0], y], [b[0], y])
      this.text(layer, [(a[0] + b[0]) / 2 - label.length * TEXT_H * 0.3, y - TEXT_H - 20], label)
    }
  }

  toString(): string {
    const tables = [...this.layers].map((name, i) =>
      `0\nLAYER\n2\n${name}\n70\n0\n62\n${[7, 1, 3, 5, 2, 4, 6][i % 7]}\n6\nCONTINUOUS`).join('\n')
    return [
      '0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1009\n9\n$INSUNITS\n70\n4\n0\nENDSEC',
      `0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n${this.layers.size}\n${tables}\n0\nENDTAB\n0\nENDSEC`,
      `0\nSECTION\n2\nENTITIES\n${this.out.join('\n')}\n0\nENDSEC`,
      '0\nEOF',
    ].join('\n') + '\n'
  }
}

function n(v: number): string { return (Math.round(v * 1000) / 1000).toString() }
function escape(s: string): string { return s.replace(/[\r\n]+/g, ' ') }

/** The three ways a frame is drawn: what each view keeps from the model */
const VIEWS = [
  { name: 'FRONT', label: 'FRONT (X-Y)', x: (v: THREE.Vector3) => v.x, y: (v: THREE.Vector3) => v.y },
  { name: 'TOP', label: 'TOP (X-Z)', x: (v: THREE.Vector3) => v.x, y: (v: THREE.Vector3) => -v.z },
  { name: 'RIGHT', label: 'RIGHT (Z-Y)', x: (v: THREE.Vector3) => -v.z, y: (v: THREE.Vector3) => v.y },
] as const

/** Outline of a box as seen in a view: the projection of its eight corners, as a rectangle */
function projectPoints(points: THREE.Vector3[], view: typeof VIEWS[number]): { min: Pt; max: Pt } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const v of points) {
    const px = view.x(v), py = view.y(v)
    x0 = Math.min(x0, px); x1 = Math.max(x1, px)
    y0 = Math.min(y0, py); y1 = Math.max(y1, py)
  }
  return { min: [x0, y0], max: [x1, y1] }
}

/** The convex outline of a solid's actual projected corners, including rotated members. */
function silhouette(points: THREE.Vector3[], view: typeof VIEWS[number]): Pt[] {
  const unique = new Map<string, Pt>()
  for (const p of points) {
    const xy: Pt = [view.x(p), view.y(p)]
    unique.set(`${n(xy[0])},${n(xy[1])}`, xy)
  }
  const ordered = [...unique.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (a: Pt, b: Pt, c: Pt) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  const half = (list: Pt[]) => {
    const out: Pt[] = []
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 1e-6) out.pop()
      out.push(p)
    }
    return out
  }
  if (ordered.length <= 2) return ordered
  return [...half(ordered).slice(0, -1), ...half([...ordered].reverse()).slice(0, -1)]
}

export interface DxfInput {
  profiles: ProfileData[]
  panels: PanelData[]
  fittings: FittingData[]
  connectors?: ConnectorData[]
  rule?: ThroughRule
  trims?: Map<string, ProfileTrims>
}

/**
 * Write the drawing.
 *
 * The three views are laid out left to right with their own origins, each with its overall
 * width and height dimensioned, and the boards follow underneath as a cut sheet.
 */
export function buildDxf({ profiles, panels, fittings, connectors = [], rule, trims: suppliedTrims }: DxfInput): string {
  const d = new Dxf()
  const trims = suppliedTrims ?? computeAllTrims(profiles, rule)

  const members = profiles.map((p) => ({ number: partNumber('profile', p.id), points: obbCorners(trimmedOBB(p, trims.get(p.id)!)) }))
  const hardware = connectors.map((c) => ({ number: partNumber('connector', c.id), points: obbCorners(connectorOBB(c)) }))
  const boards = panels.map((b) => ({ number: partNumber('panel', b.id), points: obbCorners(panelOBB(b)) }))
  const fittingBoards = fittings.flatMap((f) => {
    const parts = fittingParts(f).boards
    return fittingSolids(f, 0).map((body, i) => ({ number: fittingBoardNumber(f.id, parts[i].key), points: obbCorners(body) }))
  })
  const all = [...members, ...hardware, ...boards, ...fittingBoards]
  const whole = all.flatMap((part) => part.points)
  if (!whole.length) whole.push(new THREE.Vector3())

  let cursor = 0
  for (const view of VIEWS) {
    const bounds = projectPoints(whole, view)
    const dx = cursor - bounds.min[0]
    const dy = -bounds.min[1]
    const at = (p: Pt): Pt => [p[0] + dx, p[1] + dy]

    for (const [layer, solids] of [['MEMBERS', members], ['CONNECTORS', hardware], ['BOARDS', boards], ['FITTINGS', fittingBoards]] as const) {
      for (const solid of solids) {
        const outline = silhouette(solid.points, view)
        for (let i = 0; i < outline.length; i++) d.line(layer, at(outline[i]), at(outline[(i + 1) % outline.length]))
      }
    }

    const lo = at(bounds.min), hi = at(bounds.max)
    if (all.length > 0) {
      d.dim('DIMS', [lo[0], lo[1]], [hi[0], lo[1]], DIM_OFF)
      d.dim('DIMS', [hi[0], lo[1]], [hi[0], hi[1]], DIM_OFF, true)
    }
    // Place identifiers outside the projection, ordered by their projected centres.
    const labelH = TEXT_H * 0.4, labelStep = labelH * 1.8
    const labels = all.map((part) => {
      const projected = projectPoints(part.points, view)
      return { number: part.number, centre: at([(projected.min[0] + projected.max[0]) / 2,
        (projected.min[1] + projected.max[1]) / 2]) }
    }).sort((a, b) => b.centre[1] - a.centre[1] || a.centre[0] - b.centre[0] || a.number.localeCompare(b.number))
    const labelTop = Math.max(hi[1], (labels.length - 1) * labelStep)
    const labelX = hi[0] + DIM_OFF + TEXT_H * 2
    labels.forEach((label, i) => {
      const y = labelTop - i * labelStep
      d.line('PART_NUMBERS', label.centre, [labelX - 10, y + labelH / 2])
      d.text('PART_NUMBERS', [labelX, y], label.number, labelH)
    })
    d.text('TEXT', [lo[0], labelTop + TEXT_H], view.label, TEXT_H)

    const labelWidth = Math.max(0, ...labels.map((label) => label.number.length * labelH * 0.75))
    cursor = labelX + labelWidth + GAP
  }

  // Lay out and label each board outline.
  const sheet = documentBoards({ profiles, panels, fittings, connectors, throughRule: rule ?? 'rails' }).map(b => ({
    ...b, w: b.width, h: b.height, blank: boardBlank(b.width, b.height, b.fabrication),
    label: `${b.id} ${n(b.width)}x${n(b.height)}x${b.thickness} ${b.material}`,
  }))
  if (sheet.length > 0) {
    // Keep the cut sheet below the projection dimensions.
    const belowViews = -(DIM_OFF + TEXT_H * 2 + 40)
    let x = 0, y = belowViews - GAP, rowH = 0
    const maxRow = Math.max(cursor, 3000)
    d.text('TEXT', [0, y + TEXT_H], `BOARDS (${sheet.length})`, TEXT_H)
    y -= TEXT_H * 2
    const labelH = TEXT_H * 0.6
    for (const b of sheet) {
      const fabrication = b.fabrication ?? DEFAULT_FABRICATION
      const notes = b.fabrication ? `BLANK ${n(b.blank.width)}x${n(b.blank.height)}; GRAIN ${fabrication.grain}; BAND L/R/B/T ${fabrication.bands.map(n).join('/')}` : ''
      const slotWidth = Math.max(b.w, Math.max(b.label.length, notes.length) * labelH * 0.75)
      if (x > 0 && x + slotWidth > maxRow) { x = 0; y -= rowH + labelH + GAP / 2; rowH = 0 }
      d.rect('CUTSHEET', [x, y - b.h], [x + b.w, y])
      const [left, right, bottom, top] = fabrication.bands
      if (fabrication.bands.some(v => v > 0)) d.rect('BLANK', [x + left, y - b.h + bottom], [x + b.w - right, y - top])
      for (const h of b.holes) d.circle('BOARD_HOLES', [x + h.x, y - b.h + h.y], h.diameter / 2)
      if (fabrication.grain !== 'none') {
        const cx = x + b.w / 2, cy = y - b.h / 2
        const dx = fabrication.grain === 'x' ? b.w / 4 : 0, dy = fabrication.grain === 'y' ? b.h / 4 : 0
        d.line('GRAIN', [cx - dx, cy - dy], [cx + dx, cy + dy])
      }
      if (notes) d.text('TEXT', [x, y - b.h - labelH * 2 - 20], notes, labelH)
      // Place labels below the outline.
      d.text('TEXT', [x, y - b.h - labelH - 10], b.label, labelH)
      x += slotWidth + GAP / 2
      rowH = Math.max(rowH, b.h + (notes ? labelH + 10 : 0))
    }
  }

  return d.toString()
}
