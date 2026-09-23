import { describe, it, expect } from 'vitest'
import { nestProfiles, nestingCsv, STOCK_LENGTH, KERF } from '../utils/nesting'
import type { BomRow } from '../utils/bom'

const row = (spec: string, length: number, qty: number): BomRow =>
  ({ kind: 'profile', key: `${spec}-${length}`, label: spec, spec, length, qty })

describe('how many bars to buy', () => {
  it('says none for an empty cut list', () => {
    expect(nestProfiles([]).totalBars).toBe(0)
  })

  it('puts four 1500s on one six-metre bar only if the saw took nothing', () => {
    // it does take something: 4 × 1500 plus three cuts is 6009, which does not fit
    const r = nestProfiles([row('2020', 1500, 4)])
    expect(r.totalBars).toBe(2)
  })

  it('fits four 1490s on one bar, because the kerf leaves room', () => {
    const r = nestProfiles([row('2020', 1490, 4)])
    expect(r.totalBars).toBe(1)
    expect(r.bars[0].cuts).toEqual([1490, 1490, 1490, 1490])
    // 6000 − 4×1490 − 3×3 = 31
    expect(Math.round(r.bars[0].remainder)).toBe(6000 - 1490 * 4 - KERF * 3)
  })

  it('counts the blade on every cut after the first', () => {
    // three 2000s do NOT come off a six-metre bar: 6000 of metal plus two kerfs is 6006
    expect(nestProfiles([row('2020', 2000, 3)]).totalBars).toBe(2)
    // ten millimetres shorter and they do, with the kerfs accounted for
    const r = nestProfiles([row('2020', 1990, 3)])
    expect(r.totalBars).toBe(1)
    expect(Math.round(r.bars[0].remainder)).toBe(6000 - 1990 * 3 - KERF * 2)
  })

  it('keeps each section on its own bars — you cannot cut a 2040 from a 2020', () => {
    const r = nestProfiles([row('2020', 1000, 3), row('4040', 1000, 3)])
    expect(r.totalBars).toBe(2)
    expect(new Set(r.bars.map((b) => b.spec))).toEqual(new Set(['2020', '4040']))
    for (const b of r.bars) expect(b.cuts).toEqual([1000, 1000, 1000])
  })

  it('takes the longest pieces first, so the awkward ones get the choice', () => {
    const r = nestProfiles([row('2020', 3500, 1), row('2020', 2400, 1), row('2020', 100, 1)])
    expect(r.bars[0].cuts[0]).toBe(3500)
  })

  it('gives the same answer twice, because somebody writes these on the metal', () => {
    const rows = [row('2020', 850, 10), row('2020', 660, 14), row('2040', 3640, 3)]
    expect(nestProfiles(rows)).toEqual(nestProfiles(rows))
  })

  it('says so rather than quietly splitting a piece longer than the stock', () => {
    const r = nestProfiles([row('2040', 7000, 1)])
    expect(r.totalBars).toBe(1)
    expect(r.bars[0].remainder).toBeLessThan(0)
  })

  it('reports what is left, and the longest single offcut worth keeping', () => {
    const r = nestProfiles([row('2020', 2000, 2)])
    const s = r.bySpec[0]
    expect(s.bars).toBe(1)
    expect(s.usedMm).toBe(4000)
    expect(Math.round(s.longestOffcut)).toBe(6000 - 4000 - KERF)
  })

  it('yield is the metal that ends up in the frame', () => {
    const r = nestProfiles([row('2020', 2990, 2)])
    expect(r.totalBars).toBe(1)
    expect(r.yield).toBeCloseTo(5980 / 6000, 3)
    const half = nestProfiles([row('2020', 3000, 1)])
    expect(half.yield).toBeCloseTo(0.5, 2)
  })

  it('a shorter stock length changes the answer', () => {
    // 3 m holds two 1000s and not three (3000 + one kerf is 3003), 6 m holds five
    expect(nestProfiles([row('2020', 1000, 6)], 3000).totalBars).toBe(3)
    expect(nestProfiles([row('2020', 1000, 6)], 6000).totalBars).toBe(2)
  })

  it('never loses a piece', () => {
    const rows = [row('2020', 850, 10), row('2020', 660, 14), row('2020', 330, 20), row('2040', 3640, 3), row('4040', 850, 4)]
    const want = rows.reduce((n, r) => n + r.qty, 0)
    const got = nestProfiles(rows).bars.reduce((n, b) => n + b.cuts.length, 0)
    expect(got).toBe(want)
  })

  it('never overfills a bar', () => {
    const rows = [row('2020', 850, 10), row('2020', 660, 14), row('2020', 330, 20), row('2040', 3640, 3)]
    for (const b of nestProfiles(rows).bars) {
      const need = b.cuts.reduce((n, c) => n + c, 0) + KERF * (b.cuts.length - 1)
      expect(need).toBeLessThanOrEqual(STOCK_LENGTH)
    }
  })
})

describe('the cutting list', () => {
  it('has a line per bar that a saw operator can read', () => {
    const csv = nestingCsv(nestProfiles([row('2020', 1990, 3)]))
    expect(csv.split('\n')[0]).toBe('Spec,Bar,Cuts (mm),Pieces,Offcut (mm)')
    expect(csv).toContain('2020,1,"1990 + 1990 + 1990",3,')
    expect(csv).toContain('Summary,Total bars,1,,')
  })
})
