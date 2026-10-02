import type { BomRow } from './bom'

/**
 * Allocate cuts by specification using first-fit decreasing, accounting for saw kerf
 * and remaining bar length. The result is deterministic but is not guaranteed optimal.
 */

/** the length a bar comes in (mm) */
export const STOCK_LENGTH = 6000
/** what the blade turns into dust on each cut (mm) */
export const KERF = 3

export interface Bar {
  spec: string
  /** the pieces cut from this bar, in the order they come off it */
  cuts: number[]
  /** Identity at the same index as each cut; empty for anonymous input rows. */
  partNumbers: string[]
  /** what is left after the last cut (mm) */
  remainder: number
}

export interface NestResult {
  bars: Bar[]
  /** Pieces that cannot be supplied by the chosen stock; never counted as usable bars. */
  unsatisfied: Array<{ spec: string; length: number; qty: number; reason: 'exceeds-stock'; partNumbers: string[] }>
  /** per spec: bars needed, metal used, metal left over */
  bySpec: Array<{ spec: string; bars: number; usedMm: number; offcutMm: number; longestOffcut: number }>
  totalBars: number
  /** how much of the metal bought ends up in the frame */
  yield: number
}

/**
 * Nest the profile rows of a cut list onto stock.
 *
 * `stockLength` can be raised for six-metre bars or lowered for whatever is in the rack.
 * A piece longer than the stock is reported separately, so a purchasing summary cannot
 * mistake an impossible cut for an executable bar.
 */
export function nestProfiles(rows: BomRow[], stockLength = STOCK_LENGTH, kerf = KERF): NestResult {
  const bySpecPieces = new Map<string, Array<{ length: number; partNumber: string }>>()
  for (const r of rows) {
    if (r.kind !== 'profile' || !r.length) continue
    const list = bySpecPieces.get(r.spec) ?? []
    for (let i = 0; i < r.qty; i++) list.push({ length: r.length, partNumber: r.partNumbers?.[i] ?? '' })
    bySpecPieces.set(r.spec, list)
  }

  const bars: Bar[] = []
  const bySpec: NestResult['bySpec'] = []
  const unsatisfied: NestResult['unsatisfied'] = []
  const unavailable = new Map<string, NestResult['unsatisfied'][number]>()

  for (const [spec, pieces] of [...bySpecPieces.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    pieces.sort((a, b) => b.length - a.length || (a.partNumber < b.partNumber ? -1 : a.partNumber > b.partNumber ? 1 : 0))
    const open: Bar[] = []
    for (const { length: piece, partNumber } of pieces) {
      if (piece > stockLength) {
        const key = `${spec}:${piece}`
        const item = unavailable.get(key) ?? { spec, length: piece, qty: 0, reason: 'exceeds-stock' as const, partNumbers: [] }
        item.qty++
        item.partNumbers.push(partNumber)
        unavailable.set(key, item)
        continue
      }
      // Taking the complete remaining length needs no cut. Every separation from a usable
      // tail consumes a kerf, including the first cut on a new bar. When less than a kerf
      // remains, the blade exits the factory end and there is no reusable tail.
      const take = (remaining: number) => Math.abs(remaining - piece) < 1e-6
        ? 0 : Math.max(0, remaining - piece - kerf)
      const fits = open.find((b) => b.remainder + 1e-6 >= piece)
      if (fits) {
        fits.remainder = take(fits.remainder)
        fits.cuts.push(piece)
        fits.partNumbers.push(partNumber)
      } else {
        const bar: Bar = { spec, cuts: [piece], partNumbers: [partNumber], remainder: take(stockLength) }
        open.push(bar)
        bars.push(bar)
      }
    }
    const mine = bars.filter((b) => b.spec === spec)
    const usedMm = mine.reduce((n, b) => n + b.cuts.reduce((m, c) => m + c, 0), 0)
    if (mine.length) bySpec.push({
      spec, bars: mine.length, usedMm,
      offcutMm: mine.reduce((n, b) => n + Math.max(0, b.remainder), 0),
      longestOffcut: mine.reduce((n, b) => Math.max(n, b.remainder), 0),
    })
  }

  const bought = bars.length * stockLength
  const used = bySpec.reduce((n, s) => n + s.usedMm, 0)
  unsatisfied.push(...unavailable.values())
  return { bars, unsatisfied, bySpec, totalBars: bars.length, yield: bought > 0 ? used / bought : 0 }
}

/** The cutting list as CSV: one line per bar, so it can be taken to the saw */
export function nestingCsv(result: NestResult, stockLength = STOCK_LENGTH): string {
  const lines = ['Spec,Bar,Cuts (mm),Pieces,Offcut (mm),Part numbers']
  const dimension = (value: number) => Math.round(value * 1000) / 1000
  const n = new Map<string, number>()
  for (const b of result.bars) {
    const i = (n.get(b.spec) ?? 0) + 1
    n.set(b.spec, i)
    lines.push(`${b.spec},${i},"${b.cuts.join(' + ')}",${b.cuts.length},${dimension(b.remainder)},"${b.partNumbers.join(' + ')}"`)
  }
  lines.push('')
  for (const item of result.unsatisfied) {
    lines.push(`Unsatisfied,${item.spec},${item.length} mm exceeds ${stockLength} mm,${item.qty},,"${item.partNumbers.join('; ')}"`)
  }
  for (const s of result.bySpec) {
    lines.push(`Summary,${s.spec},${s.bars} × ${stockLength}mm,,${dimension(s.offcutMm)},`)
  }
  lines.push(`Summary,Total bars,${result.totalBars},,,`)
  lines.push(`Summary,Yield,${(result.yield * 100).toFixed(1)}%,,,`)
  return lines.join('\n')
}
