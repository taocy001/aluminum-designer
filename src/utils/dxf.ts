import * as THREE from 'three'
import type { FittingData, PanelData, ProfileData } from '../store/useStore'
import { computeAllTrims, trimmedBox } from './jointUtils'
import { fittingParts } from './fittingGeometry'
import { panelCorners } from './panelOps'

/**
 * The drawing, as a file somebody else can open.
 *
 * A screenshot is not a drawing: you cannot measure it, and the person cutting the board
 * cannot put it on a machine. This writes DXF, which every CAD package and every laser and
 * router shop reads, and it writes the two things that are actually handed over:
 *
 *  - **Three elevations** — front, top and right — of the frame as it is built, side by side
 *    with their overall sizes. That is the sheet you print and take to the bench.
 *  - **A cut sheet of every board**, laid flat and labelled, so a router shop has outlines
 *    rather than a table of numbers to re-draw.
 *
 * It is R12 ASCII, the oldest and most widely readable form: LINE and TEXT and nothing else.
 * A newer version would buy splines and true dimension entities, and cost the guarantee that
 * the file opens.
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

  /** A dimension drawn as lines and a number: every reader understands it, and it measures */
  dim(layer: string, a: Pt, b: Pt, off: number, vertical = false): void {
    const label = String(Math.round(Math.hypot(b[0] - a[0], b[1] - a[1])))
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
function projectBox(box: THREE.Box3, view: typeof VIEWS[number]): { min: Pt; max: Pt } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const sx of [box.min.x, box.max.x]) for (const sy of [box.min.y, box.max.y]) for (const sz of [box.min.z, box.max.z]) {
    const v = new THREE.Vector3(sx, sy, sz)
    const px = view.x(v), py = view.y(v)
    x0 = Math.min(x0, px); x1 = Math.max(x1, px)
    y0 = Math.min(y0, py); y1 = Math.max(y1, py)
  }
  return { min: [x0, y0], max: [x1, y1] }
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

  // every part's box, once; each view is a different projection of the same boxes
  const memberBoxes = profiles.map((p) => trimmedBox(p, trims.get(p.id)!))
  const boardBoxes = panels.map((b) => {
    const box = new THREE.Box3()
    for (const c of panelCorners(b)) box.expandByPoint(c)
    // a board has thickness the corners do not carry, and an elevation shows it
    box.expandByScalar(b.thickness / 2)
    return box
  })
  const fittingBoxes = fittings.map((f) => {
    const box = new THREE.Box3()
    const q = new THREE.Quaternion(...f.quaternion).normalize()
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      box.expandByPoint(new THREE.Vector3(sx * f.width / 2, sy * f.height / 2, sz * f.depth / 2)
        .applyQuaternion(q).add(new THREE.Vector3(...f.position)))
    }
    return box
  })

  const whole = new THREE.Box3()
  for (const b of [...memberBoxes, ...boardBoxes, ...fittingBoxes]) whole.union(b)
  if (whole.isEmpty()) whole.set(new THREE.Vector3(), new THREE.Vector3())

  let cursor = 0
  for (const view of VIEWS) {
    const bounds = projectBox(whole, view)
    const dx = cursor - bounds.min[0]
    const dy = -bounds.min[1]
    const at = (p: Pt): Pt => [p[0] + dx, p[1] + dy]

    for (const box of memberBoxes) {
      const r = projectBox(box, view)
      d.rect('MEMBERS', at(r.min), at(r.max))
    }
    for (const box of boardBoxes) {
      const r = projectBox(box, view)
      d.rect('BOARDS', at(r.min), at(r.max))
    }
    for (const box of fittingBoxes) {
      const r = projectBox(box, view)
      d.rect('FITTINGS', at(r.min), at(r.max))
    }

    const lo = at(bounds.min), hi = at(bounds.max)
    if (profiles.length + panels.length + fittings.length > 0) {
      d.dim('DIMS', [lo[0], lo[1]], [hi[0], lo[1]], DIM_OFF)
      d.dim('DIMS', [hi[0], lo[1]], [hi[0], hi[1]], DIM_OFF, true)
    }
    d.text('TEXT', [lo[0], hi[1] + TEXT_H], view.label, TEXT_H)

    cursor += (bounds.max[0] - bounds.min[0]) + GAP + DIM_OFF * 2
  }

  // The cut sheet: every board laid flat and labelled, so a shop has outlines to work from
  // rather than a table of numbers to re-draw.
  const sheet: Array<{ w: number; h: number; label: string }> = [
    ...panels.map((b) => ({ w: b.width, h: b.height, label: `${Math.round(b.width)}x${Math.round(b.height)}x${b.thickness} ${b.material}` })),
    ...fittings.flatMap((f) => fittingParts(f).boards.map((b) => ({
      w: b.width, h: b.height, label: `${Math.round(b.width)}x${Math.round(b.height)}x${b.thickness} ${f.kind}/${b.role}`,
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
      // under the outline, never across it: a label inside a short board runs off its edge
      d.text('TEXT', [x, y - b.h - labelH - 10], b.label, labelH)
      x += b.w + GAP / 2
      rowH = Math.max(rowH, b.h)
    }
  }

  return d.toString()
}
