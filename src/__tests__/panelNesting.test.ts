import { describe, expect, it } from 'vitest'
import { nestPanels, documentBoards, panelHolesCsv, panelLayoutCsv, type CutBoard, type SheetOptions } from '../utils/panelNesting'

const board = (id: string, width: number, height: number, extra: Partial<CutBoard> = {}): CutBoard =>
  ({ id, sourceId: id, width, height, thickness: 18, material: 'ply', holes: [], ...extra })
const stock: SheetOptions = { width: 2440, height: 1220, kerf: 3, margin: 10, rotate: false }

describe('panel sheet layout', () => {
  it('preserves every piece and keeps all cuts inside margins with saw gaps', () => {
    const pieces = Array.from({ length: 48 }, (_, i) => board(`B-${i}`, 100 + (i % 6) * 80, 180 + (i % 4) * 60))
    const result = nestPanels(pieces, stock)
    expect(result.oversized).toEqual([])
    expect(result.sheets.flatMap(s => s.placements.map(p => p.board.id)).sort()).toEqual(pieces.map(p => p.id).sort())
    for (const sheet of result.sheets) for (const a of sheet.placements) {
      expect(a.x).toBeGreaterThanOrEqual(stock.margin)
      expect(a.y).toBeGreaterThanOrEqual(stock.margin)
      expect(a.x + a.width).toBeLessThanOrEqual(stock.width - stock.margin)
      expect(a.y + a.height).toBeLessThanOrEqual(stock.height - stock.margin)
      for (const b of sheet.placements) if (a !== b) {
        expect(a.x + a.width + stock.kerf <= b.x || b.x + b.width + stock.kerf <= a.x
          || a.y + a.height + stock.kerf <= b.y || b.y + b.height + stock.kerf <= a.y).toBe(true)
      }
    }
    expect(result.utilization).toBeGreaterThan(0)
    expect(result.utilization).toBeLessThanOrEqual(1)
    expect(nestPanels([...pieces].reverse(), stock)).toEqual(result)
  })
  it('keeps grain orientation unless rotation is explicitly allowed', () => {
    const piece = board('B-tall', 1100, 2000)
    expect(nestPanels([piece], stock).oversized).toEqual([piece])
    const fit = nestPanels([piece], { ...stock, rotate: true })
    expect(fit.oversized).toEqual([])
    expect(fit.sheets[0].placements[0]).toMatchObject({ width: 2000, height: 1100, rotated: true })
  })
  it('separates material and thickness, reports impossible cuts in the exported plan', () => {
    const parts = [board('B-wood', 100, 100), board('B-thin', 100, 100, { thickness: 12 }),
      board('B-metal', 100, 100, { material: 'alu' }), board('B-too-wide', 3000, 100)]
    const result = nestPanels(parts, stock)
    expect(result.sheets).toHaveLength(3)
    expect(result.oversized.map(p => p.id)).toEqual(['B-too-wide'])
    expect(panelLayoutCsv(result, stock)).toContain('"exceeds-stock","","B-too-wide"')
  })
  it('does not consume a kerf beyond a full-sheet part', () => {
    const piece = board('B-full', 2420, 1200)
    expect(nestPanels([piece], stock).sheets[0].placements).toHaveLength(1)
    expect(nestPanels([piece, board('B-extra', 1, 1)], stock).sheets).toHaveLength(2)
    expect(() => nestPanels([], { ...stock, margin: 700 })).toThrow()
    expect(() => nestPanels([], { ...stock, kerf: -1 })).toThrow()
  })
  it('exports only explicit through holes without inventing machining details', () => {
    const b = board('B-hole', 100, 200, { holes: [{ x: 20, y: 40, diameter: 6.5 }] })
    expect(panelHolesCsv([b])).toContain('"B-hole","1","20","40","6.5","18"')
    const parts = documentBoards({ profiles: [], connectors: [], fittings: [], throughRule: 'rails', panels: [
      { id: 'a', position: [0, 0, 0], quaternion: [0, 0, 0, 1], width: 100, height: 200, thickness: 18, material: 'ply' },
    ] })
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ id: 'B-a', width: 100, height: 200, holes: [] })
    expect(panelHolesCsv(parts).split('\r\n')).toHaveLength(1)
  })
})
