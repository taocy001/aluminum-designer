import type { BomRow } from './bom'

/**
 * How many lengths of stock to buy, and what to cut from each.
 *
 * A cut list says you need forty-two pieces. It does not say how many six-metre lengths to
 * order, and that is the number you actually have to put on a purchase order — so everyone
 * works it out on paper, badly, and buys one too few.
 *
 * Two things the arithmetic has to respect or the answer is a lie:
 *
 *  - **The saw takes a bite.** Every cut turns some of the bar into dust. Three metres of
 *    stock does not yield two 1500s; it yields a 1500, a 1496 and a pile of swarf.
 *  - **The offcut is not waste yet.** What is left on a bar can still be cut from, which is
 *    the whole reason to nest rather than divide.
 *
 * The packing is first-fit-decreasing: longest piece first, into the first bar it fits.
 * For one-dimensional stock that is within a few per cent of optimal and it is stable —
 * asking for the same drawing twice gives the same cutting list, which matters more here
 * than the last percent, because somebody is going to write these numbers on the metal.
 */

/** the length a bar comes in (mm) */
export const STOCK_LENGTH = 6000
/** what the blade turns into dust on each cut (mm) */
export const KERF = 3

export interface Bar {
  spec: string
  /** the pieces cut from this bar, in the order they come off it */
  cuts: number[]
  /** what is left after the last cut (mm) */
  remainder: number
}

export interface NestResult {
  bars: Bar[]
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
 * A piece longer than the stock cannot be cut from it; it gets a bar of its own and is
 * reported with a negative remainder, which is the honest way to say "this does not fit".
 */
export function nestProfiles(rows: BomRow[], stockLength = STOCK_LENGTH, kerf = KERF): NestResult {
  const bySpecPieces = new Map<string, number[]>()
  for (const r of rows) {
    if (r.kind !== 'profile' || !r.length) continue
    const list = bySpecPieces.get(r.spec) ?? []
    for (let i = 0; i < r.qty; i++) list.push(r.length)
    bySpecPieces.set(r.spec, list)
  }

  const bars: Bar[] = []
  const bySpec: NestResult['bySpec'] = []

  for (const [spec, pieces] of [...bySpecPieces.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    pieces.sort((a, b) => b - a)          // longest first: the hardest pieces get the choice
    const open: Bar[] = []
    for (const piece of pieces) {
      if (piece > stockLength) {
        // longer than anything you can buy: say so rather than quietly splitting it
        bars.push({ spec, cuts: [piece], remainder: stockLength - piece })
        continue
      }
      // the first cut on a bar takes no kerf off the far end that matters; every later one does
      const fits = open.find((b) => b.remainder - (b.cuts.length ? kerf : 0) >= piece)
      if (fits) {
        fits.remainder -= piece + (fits.cuts.length ? kerf : 0)
        fits.cuts.push(piece)
      } else {
        const bar: Bar = { spec, cuts: [piece], remainder: stockLength - piece }
        open.push(bar)
        bars.push(bar)
      }
    }
    const mine = bars.filter((b) => b.spec === spec)
    const usedMm = mine.reduce((n, b) => n + b.cuts.reduce((m, c) => m + c, 0), 0)
    bySpec.push({
      spec, bars: mine.length, usedMm,
      offcutMm: mine.reduce((n, b) => n + Math.max(0, b.remainder), 0),
      longestOffcut: mine.reduce((n, b) => Math.max(n, b.remainder), 0),
    })
  }

  const bought = bars.length * stockLength
  const used = bySpec.reduce((n, s) => n + s.usedMm, 0)
  return { bars, bySpec, totalBars: bars.length, yield: bought > 0 ? used / bought : 0 }
}

/** The cutting list as CSV: one line per bar, so it can be taken to the saw */
export function nestingCsv(result: NestResult, stockLength = STOCK_LENGTH): string {
  const lines = ['Spec,Bar,Cuts (mm),Pieces,Offcut (mm)']
  const n = new Map<string, number>()
  for (const b of result.bars) {
    const i = (n.get(b.spec) ?? 0) + 1
    n.set(b.spec, i)
    lines.push(`${b.spec},${i},"${b.cuts.join(' + ')}",${b.cuts.length},${Math.round(b.remainder)}`)
  }
  lines.push('')
  for (const s of result.bySpec) {
    lines.push(`Summary,${s.spec},${s.bars} × ${stockLength}mm,,${Math.round(s.offcutMm)}`)
  }
  lines.push(`Summary,Total bars,${result.totalBars},,`)
  lines.push(`Summary,Yield,${(result.yield * 100).toFixed(1)}%,,`)
  return lines.join('\n')
}
