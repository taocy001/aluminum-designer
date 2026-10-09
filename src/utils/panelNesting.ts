import { boardBlank, DEFAULT_FABRICATION, type BoardFabrication } from './boardFabrication'
import type { ProjectDocument } from './document'
import type { PanelMaterial } from '../store/useStore'
import { fittingParts } from './fittingGeometry'
import { fittingBoardNumber, partNumber } from './partNumbers'
import { panelDrillCenters } from './panelDrilling'

export interface CutBoard {
  id: string
  sourceId: string
  boardKey?: string
  fabrication?: BoardFabrication
  width: number
  height: number
  thickness: number
  material: PanelMaterial
  /** Coordinates from the lower-left corner of the board's local XY face. */
  holes: { x: number; y: number; diameter: number }[]
}
export interface SheetOptions { width: number; height: number; kerf: number; margin: number; rotate: boolean; grain?: 'x' | 'y' }
interface Rectangle { x: number; y: number; width: number; height: number }
/** Stock-sheet XY coordinates start at the upper-left, matching the preview. */
export interface PlacedBoard extends Rectangle { board: CutBoard; rotated: boolean }
export interface CutSheet { material: PanelMaterial; thickness: number; placements: PlacedBoard[] }
export interface PanelNest { sheets: CutSheet[]; oversized: CutBoard[]; utilization: number }

export function documentBoards(doc: ProjectDocument): CutBoard[] {
  return [
    ...doc.panels.map(p => ({ id: partNumber('panel', p.id), sourceId: p.id, width: p.width, height: p.height,
      thickness: p.thickness, material: p.material, fabrication: p.fabrication,
      holes: panelDrillCenters(p, doc.connectors).map(h => ({ x: h.x + p.width / 2, y: h.y + p.height / 2, diameter: h.diameter })) })),
    ...doc.fittings.flatMap(f => fittingParts(f).boards.map(b => ({ id: fittingBoardNumber(f.id, b.key), sourceId: f.id,
      width: b.width, height: b.height, thickness: b.thickness, material: f.material, boardKey: b.key, fabrication: f.fabrication?.[b.key], holes: [] }))),
  ]
}

/** Deterministic guillotine layout. Each sheet contains one material and thickness; rotation is opt-in. */
export function nestPanels(boards: CutBoard[], options: SheetOptions): PanelNest {
  const { width, height, kerf, margin, rotate } = options
  if (![width, height, kerf, margin].every(Number.isFinite) || width <= 0 || height <= 0 || kerf < 0
    || margin < 0 || margin * 2 >= Math.min(width, height)) throw new Error('Invalid sheet dimensions')
  if (boards.some(b => ![b.width, b.height, b.thickness].every(n => Number.isFinite(n) && n > 0))) throw new Error('Invalid board dimensions')
  const sheets: CutSheet[] = [], free: Rectangle[][] = [], oversized: CutBoard[] = []
  const usable = { x: margin, y: margin, width: width - margin * 2, height: height - margin * 2 }
  const ordered = [...boards].sort((a, b) => Math.max(b.width, b.height) - Math.max(a.width, a.height)
    || b.width * b.height - a.width * a.height || a.id.localeCompare(b.id))
  for (const board of ordered) {
    const blank = boardBlank(board.width, board.height, board.fabrication)
    const grain = board.fabrication?.grain ?? 'none'
    const stockGrain = options.grain ?? 'x'
    const orientations = [{ ...blank, rotated: false },
      ...(rotate ? [{ width: blank.height, height: blank.width, rotated: true }] : [])]
      .filter(o => grain === 'none' || (o.rotated ? grain !== stockGrain : grain === stockGrain))
    if (!orientations.some(o => o.width <= usable.width && o.height <= usable.height)) { oversized.push(board); continue }
    type Fit = { sheet: number; index: number; score: number; width: number; height: number; rotated: boolean }
    let fit: Fit | undefined
    for (let sheet = 0; sheet < sheets.length; sheet++) {
      if (sheets[sheet].material !== board.material || sheets[sheet].thickness !== board.thickness) continue
      free[sheet].forEach((r, index) => orientations.forEach(o => {
        if (o.width > r.width || o.height > r.height) return
        const score = r.width * r.height - o.width * o.height
        if (!fit || score < fit.score) fit = { sheet, index, score, ...o }
      }))
    }
    if (!fit) {
      const o = orientations.find(o => o.width <= usable.width && o.height <= usable.height)!
      fit = { sheet: sheets.length, index: 0, score: 0, ...o }
      sheets.push({ material: board.material, thickness: board.thickness, placements: [] })
      free.push([{ ...usable }])
    }
    const r = free[fit.sheet].splice(fit.index, 1)[0]
    const w = fit.width, h = fit.height
    sheets[fit.sheet].placements.push({ board, x: r.x, y: r.y, width: w, height: h, rotated: fit.rotated })
    const right = r.width - w - kerf, above = r.height - h - kerf
    // Cut across the shorter remainder first; rectangles stay disjoint and retain saw gaps.
    if (right > above) {
      if (right > 0) free[fit.sheet].push({ x: r.x + w + kerf, y: r.y, width: right, height: r.height })
      if (above > 0) free[fit.sheet].push({ x: r.x, y: r.y + h + kerf, width: w, height: above })
    } else {
      if (right > 0) free[fit.sheet].push({ x: r.x + w + kerf, y: r.y, width: right, height: h })
      if (above > 0) free[fit.sheet].push({ x: r.x, y: r.y + h + kerf, width: r.width, height: above })
    }
  }
  const used = sheets.flatMap(s => s.placements).reduce((sum, p) => sum + p.width * p.height, 0)
  return { sheets, oversized, utilization: sheets.length ? used / (sheets.length * width * height) : 0 }
}

const csv = (rows: (string | number)[][]) => rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n')
const fabricationColumns = (b: CutBoard) => [b.width, b.height, b.fabrication?.grain ?? 'none', ...(b.fabrication?.bands ?? DEFAULT_FABRICATION.bands)]
export function panelLayoutCsv(result: PanelNest, options: SheetOptions): string {
  return csv([
    ['status', 'sheet', 'part', 'material', 'thickness_mm', 'x_mm', 'y_mm', 'cut_width_mm', 'cut_height_mm', 'rotated_90', 'stock_width_mm', 'stock_height_mm', 'kerf_mm', 'margin_mm', 'stock_grain', 'finished_width_mm', 'finished_height_mm', 'local_grain', 'band_left_mm', 'band_right_mm', 'band_bottom_mm', 'band_top_mm'],
    ...result.sheets.flatMap((s, i) => s.placements.map(p => ['placed', i + 1, p.board.id, s.material, s.thickness,
      p.x, p.y, p.width, p.height, p.rotated ? 1 : 0, options.width, options.height, options.kerf, options.margin, options.grain ?? 'x', ...fabricationColumns(p.board)])),
    ...result.oversized.map(b => ['size-or-grain-mismatch', '', b.id, b.material, b.thickness, '', '', boardBlank(b.width, b.height, b.fabrication).width, boardBlank(b.width, b.height, b.fabrication).height, '', options.width, options.height, options.kerf, options.margin, options.grain ?? 'x', ...fabricationColumns(b)]),
  ])
}
/** The whole bore must remain inside the blank after edge bands are deducted. */
export function holeFitsBlank(b: CutBoard, h: CutBoard['holes'][number]): boolean {
  const blank = boardBlank(b.width, b.height, b.fabrication)
  const x = h.x - (b.fabrication?.bands[0] ?? 0), y = h.y - (b.fabrication?.bands[2] ?? 0)
  const radius = h.diameter / 2
  return x >= radius && y >= radius && x + radius <= blank.width && y + radius <= blank.height
}
export function panelHolesCsv(boards: CutBoard[]): string {
  return csv([
    ['part', 'hole', 'local_x_mm_from_left', 'local_y_mm_from_bottom', 'through_diameter_mm', 'board_thickness_mm', 'blank_x_mm_from_left', 'blank_y_mm_from_bottom', 'blank_hole_status'],
    ...boards.flatMap(b => b.holes.map((h, i) => [b.id, i + 1, h.x, h.y, h.diameter, b.thickness, h.x - (b.fabrication?.bands[0] ?? 0), h.y - (b.fabrication?.bands[2] ?? 0), holeFitsBlank(b, h) ? 'inside-blank' : 'crosses-blank-edge'])),
  ])
}
