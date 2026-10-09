import { beforeEach, describe, expect, it } from 'vitest'
import { boardBlank, validBoardFabrication, type BoardFabrication } from '../utils/boardFabrication'
import { documentBoards, holeFitsBlank, nestPanels, panelHolesCsv, panelLayoutCsv, type CutBoard } from '../utils/panelNesting'
import { buildDxf } from '../utils/dxf'
import { decodeShare, encodeShareLink } from '../utils/shareLink'
import { validateProjectDocument } from '../utils/document'
import { mirrorBoardFabrication, mirrorFittingFabrication } from '../utils/mirrorFabrication'
import { useStore, type PanelData, type FittingData } from '../store/useStore'

const fabrication: BoardFabrication = { grain: 'y', bands: [1, 2, 3, 4] }
const panel: PanelData = { id: 'board', width: 400, height: 200, thickness: 18, material: 'ply',
  position: [0, 100, 0], quaternion: [0, 0, 0, 1], fabrication }
const door: FittingData = { id: 'door', kind: 'door', width: 400, height: 600, depth: 400,
  material: 'ply', position: [1000, 400, 0], quaternion: [0, 0, 0, 1], open: 0, hinge: 'left',
  fabrication: { panel: fabrication } }
const doc = { profiles: [], panels: [panel], fittings: [door], connectors: [], equipment: [], throughRule: 'rails' as const }
const stock = { width: 500, height: 300, kerf: 3, margin: 0, rotate: true, grain: 'x' as const }
const board: CutBoard = { id: 'B-board', sourceId: 'board', width: 400, height: 200, thickness: 18, material: 'ply', fabrication, holes: [{ x: 20, y: 30, diameter: 6 }] }

beforeEach(() => useStore.getState().loadDocument({ ...doc, fittings: [] }))

describe('board fabrication throughout the document', () => {
  it('keeps finished dimensions, derives blanks and rejects unusable edge settings', () => {
    expect(boardBlank(400, 200, fabrication)).toEqual({ width: 397, height: 193 })
    for (const value of [{ grain: 'z', bands: [0, 0, 0, 0] }, { ...fabrication, bands: [-1, 0, 0, 0] },
      { ...fabrication, bands: [11, 0, 0, 0] }, { ...fabrication, bands: [NaN, 0, 0, 0] }, { ...fabrication, extra: true }]) {
      expect(validBoardFabrication(value)).toBe(false)
      expect(() => validateProjectDocument({ ...doc, panels: [{ ...panel, fabrication: value }] })).toThrow()
    }
    expect(() => boardBlank(20, 200, { ...fabrication, bands: [10, 10, 0, 0] })).toThrow()
    expect(() => boardBlank(NaN, 200)).toThrow()
  })

  it('survives JSON and compressed sharing for standalone and fitting boards', async () => {
    const saved = validateProjectDocument(JSON.parse(JSON.stringify(doc)))
    const link = await encodeShareLink(saved, 'https://example.com/')
    const restored = await decodeShare(link.split('#d=')[1])
    expect(restored.panels[0].fabrication).toEqual(fabrication)
    expect(restored.fittings[0].fabrication).toEqual(door.fabrication)
    expect(documentBoards(restored).map(b => b.fabrication)).toEqual([fabrication, fabrication])
  })

  it('undoes fabrication with geometry and rejects editing locked boards', () => {
    const next: BoardFabrication = { grain: 'x', bands: [2, 2, 2, 2] }
    expect(useStore.getState().commitPanelEdit('board', { fabrication: next }).status).toBe('applied')
    expect(useStore.getState().panels[0].fabrication).toEqual(next)
    useStore.getState().undo()
    expect(useStore.getState().panels[0].fabrication).toEqual(fabrication)
    useStore.getState().redo()
    expect(useStore.getState().panels[0].fabrication).toEqual(next)
    useStore.getState().loadDocument({ ...doc, fittings: [], panels: [{ ...panel, locked: true }] })
    expect(useStore.getState().commitPanelEdit('board', { fabrication: next }).status).not.toBe('applied')
    expect(useStore.getState().panels[0].fabrication).toEqual(fabrication)
  })

  it('does not rotate across the grain to make an otherwise fitting piece fit', () => {
    expect(nestPanels([board], stock).oversized).toEqual([board])
    const fit = nestPanels([board], { ...stock, height: 500 })
    expect(fit.sheets[0].placements[0]).toMatchObject({ rotated: true, width: 193, height: 397 })
    expect(nestPanels([board], { ...stock, rotate: false }).oversized).toEqual([board])
    expect(nestPanels([board], { ...stock, grain: 'y' }).sheets[0].placements[0].rotated).toBe(false)
    const square = { ...board, width: 200, fabrication: { grain: 'y' as const, bands: [0, 0, 0, 0] as [number, number, number, number] } }
    expect(nestPanels([square], stock).sheets[0].placements[0].rotated).toBe(true)
  })

  it('exports finished and blank coordinates and drawing layers consistently', () => {
    expect(panelHolesCsv([board])).toContain('"20","30","6","18","19","27"')
    expect(holeFitsBlank(board, board.holes[0])).toBe(true)
    const edge = { ...board, holes: [{ x: 3, y: 30, diameter: 6 }] }
    expect(holeFitsBlank(edge, edge.holes[0])).toBe(false)
    expect(panelHolesCsv([edge])).toContain('crosses-blank-edge')
    const layout = panelLayoutCsv(nestPanels([board], { ...stock, grain: 'y' }), { ...stock, grain: 'y' })
    expect(layout).toContain('"397","193","0"')
    expect(layout).toContain('"400","200","y","1","2","3","4"')
    const drawing = buildDxf(doc)
    expect(drawing).toContain('BLANK')
    expect(drawing).toContain('GRAIN')
    expect(drawing).toContain('BAND L/R/B/T 1/2/3/4')
    expect(drawing).toContain('BLANK 397x193')
  })

  it('mirrors grain and edge allocation with door and drawer boards', () => {
    expect(mirrorBoardFabrication(fabrication)?.bands).toEqual([2, 1, 3, 4])
    expect(mirrorFittingFabrication(door, { ...door, hinge: 'right' })?.panel).toEqual({ ...fabrication, bands: [2, 1, 3, 4] })
    const drawer: FittingData = { ...door, kind: 'drawer', fabrication: { 'side-left': fabrication, base: fabrication, front: fabrication } }
    const mirrored = mirrorFittingFabrication(drawer, drawer)!
    expect(mirrored['side-left']).toBeUndefined()
    expect(mirrored['side-right']).toEqual(fabrication)
    expect(mirrored.base.bands).toEqual([2, 1, 3, 4])
    expect(mirrored.front.bands).toEqual([2, 1, 3, 4])
  })
})
