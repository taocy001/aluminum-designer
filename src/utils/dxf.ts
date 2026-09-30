import * as THREE from 'three'
import type { FittingData, PanelData, ProfileData } from '../store/useStore'
import { computeAllTrims } from './jointUtils'
import { fittingParts, fittingSolids } from './fittingGeometry'
import { panelOBB, trimmedOBB } from './analysis'
import { obbCorners } from './obb'

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
}

/**
 * Write the drawing.
 *
 * The three views are laid out left to right with their own origins, each with its overall
 * width and height dimensioned, and the boards follow underneath as a cut sheet.
 */
export function buildDxf({ profiles, panels, fittings }: DxfInput): string {
  const d = new Dxf()
  const trims = computeAllTrims(profiles)

  const members = profiles.map((p) => obbCorners(trimmedOBB(p, trims.get(p.id)!)))
  const boards = panels.map((b) => obbCorners(panelOBB(b)))
  const fittingBoards = fittings.flatMap((f) => fittingSolids(f).map(obbCorners))
  const whole = [...members, ...boards, ...fittingBoards].flat()
  if (!whole.length) whole.push(new THREE.Vector3())

  let cursor = 0
  for (const view of VIEWS) {
    const bounds = projectPoints(whole, view)
    const dx = cursor - bounds.min[0]
    const dy = -bounds.min[1]
    const at = (p: Pt): Pt => [p[0] + dx, p[1] + dy]

    for (const [layer, solids] of [['MEMBERS', members], ['BOARDS', boards], ['FITTINGS', fittingBoards]] as const) {
      for (const solid of solids) {
        const outline = silhouette(solid, view)
        for (let i = 0; i < outline.length; i++) d.line(layer, at(outline[i]), at(outline[(i + 1) % outline.length]))
      }
    }

    const lo = at(bounds.min), hi = at(bounds.max)
    if (profiles.length + panels.length + fittings.length > 0) {
      d.dim('DIMS', [lo[0], lo[1]], [hi[0], lo[1]], DIM_OFF)
      d.dim('DIMS', [hi[0], lo[1]], [hi[0], hi[1]], DIM_OFF, true)
    }
    d.text('TEXT', [lo[0], hi[1] + TEXT_H], view.label, TEXT_H)

    cursor += (bounds.max[0] - bounds.min[0]) + GAP + DIM_OFF * 2
  }

  // Lay out and label each board outline.
  const sheet: Array<{ w: number; h: number; label: string }> = [
    ...panels.map((b) => ({ w: b.width, h: b.height, label: `${n(b.width)}x${n(b.height)}x${b.thickness} ${b.material}` })),
    ...fittings.flatMap((f) => fittingParts(f).boards.map((b) => ({
      w: b.width, h: b.height, label: `${n(b.width)}x${n(b.height)}x${b.thickness} ${f.kind}/${b.role}`,
    }))),
  ]
  if (sheet.length > 0) {
    // Just below the views — including the dimension lines and their numbers, which hang
    // under them. Leaving a whole elevation's worth of white space between the two is how
    // a drawing ends up printed on two sheets for no reason.
    const belowViews = -(DIM_OFF + TEXT_H * 2 + 40)
    let x = 0, y = belowViews - GAP, rowH = 0
    const maxRow = Math.max(cursor, 3000)
    d.text('TEXT', [0, y + TEXT_H], `BOARDS (${sheet.length})`, TEXT_H)
    y -= TEXT_H * 2
    const labelH = TEXT_H * 0.6
    for (const b of sheet) {
      if (x > 0 && x + b.w > maxRow) { x = 0; y -= rowH + labelH + GAP / 2; rowH = 0 }
      d.rect('CUTSHEET', [x, y - b.h], [x + b.w, y])
      // Place labels below the outline.
      d.text('TEXT', [x, y - b.h - labelH - 10], b.label, labelH)
      x += b.w + GAP / 2
      rowH = Math.max(rowH, b.h)
    }
  }

  return d.toString()
}
