/** Directions and edges refer to the board's local XY face, before placement. */
export interface BoardFabrication {
  grain: 'none' | 'x' | 'y'
  /** Finished band thickness: left, right, bottom, top, in mm. */
  bands: [number, number, number, number]
}
export const DEFAULT_FABRICATION: BoardFabrication = { grain: 'none', bands: [0, 0, 0, 0] }

export function validBoardFabrication(value: unknown): value is BoardFabrication {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as BoardFabrication
  return Object.keys(v).every(k => k === 'grain' || k === 'bands')
    && ['none', 'x', 'y'].includes(v.grain) && Array.isArray(v.bands) && v.bands.length === 4
    && v.bands.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 10)
}

export function boardBlank(width: number, height: number, fabrication = DEFAULT_FABRICATION) {
  if (!validBoardFabrication(fabrication)) throw new Error('Invalid board fabrication')
  const [left, right, bottom, top] = fabrication.bands
  const w = width - left - right, h = height - bottom - top
  if (![w, h].every(Number.isFinite) || w <= 0 || h <= 0) throw new Error('Edge bands exceed board dimensions')
  return { width: w, height: h }
}

export function validFabricatedBoard(board: { width: number; height: number; fabrication?: BoardFabrication }): boolean {
  try { boardBlank(board.width, board.height, board.fabrication); return true } catch { return false }
}
