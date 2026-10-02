import { beforeEach, describe, expect, it } from 'vitest'
import { fittingBoardNumber, partNumber, type NumberedPartKind } from '../utils/partNumbers'
import { buildBom, bomToCsv, type BomResult } from '../utils/bom'
import { nestProfiles, nestingCsv } from '../utils/nesting'
import { computeAllTrims } from '../utils/jointUtils'
import { fittingParts } from '../utils/fittingGeometry'
import { parseProjectDocument, serializeProjectDocument, type ProjectDocument } from '../utils/document'
import { decodeShare, encodeShareLink } from '../utils/shareLink'
import { duplicateSelected } from '../utils/editOps'
import { useStore, type FittingData } from '../store/useStore'

const kinds: NumberedPartKind[] = ['profile', 'connector', 'panel', 'fitting']
const makeDoc = (): ProjectDocument => ({
  throughRule: 'rails', equipment: [],
  profiles: ['p-A', 'p-a', 'p_002D', '超长'].map((id, i) => ({ id, spec: '2020', length: i === 3 ? 7000 : 1000.125,
    position: [i * 1000, 100, 0], quaternion: [0, 0, 0, 1], miterCuts: [], holes: [], fixedTrims: { start: 0, end: 0 } })),
  connectors: ['c-A', 'c-a'].map((id, i) => ({ id, type: 'bracket', series: i ? 40 : 20,
    position: [i * 1000, 100, 0], quaternion: [0, 0, 0, 1] })),
  panels: ['drawer-front', '板件/1'].map((id, i) => ({ id, width: 600, height: 300, thickness: 18, material: 'ply',
    position: [i * 1000, 600, 0], quaternion: [0, 0, 0, 1] })),
  fittings: [
    { id: 'door', kind: 'door', width: 600, height: 800, depth: 500, frame: 20, material: 'mdf', open: 0,
      position: [0, 500, 200], quaternion: [0, 0, 0, 1] },
    { id: 'drawer', kind: 'drawer', width: 600, height: 240, depth: 500, frame: 20, material: 'mdf', open: 0,
      drawer: { reinforcement: { count: 2, width: 50, height: 20 } }, position: [900, 500, 200], quaternion: [0, 0, 0, 1] },
  ],
})
const bomOf = (doc: ProjectDocument) => buildBom(doc.profiles, doc.connectors, computeAllTrims(doc.profiles, doc.throughRule), 'en', doc.panels, doc.fittings)
const numbersOf = (bom: BomResult) => [...bom.profiles, ...bom.connectors, ...bom.panels].flatMap((row) => row.partNumbers).sort()

beforeEach(() => useStore.setState({ profiles: [], connectors: [], panels: [], fittings: [], equipment: [], throughRule: 'rails', selectedIds: [], past: [], future: [] }))

describe('stable identity labels', () => {
  it('uses a separate prefix for each model kind', () => {
    expect(kinds.map((kind) => partNumber(kind, 'source'))).toEqual(['P-source', 'C-source', 'B-source', 'F-source'])
    expect(partNumber('profile', 'A_é')).toBe('P-A_005F_00E9')
    expect(fittingBoardNumber('drawer', 'side-left')).toBe('F-drawer.B-side-left')
  })

  it('distinguishes case, escaped spellings, Unicode forms and lone surrogate IDs', () => {
    const ids = ['A', 'a', 'A-', 'A_', 'A.', 'A_002E', 'A.B-front', 'é', 'é', '💡', '\ud800', '\ufffd', 'a,b', 'a\nb', 'a"b']
    const labels = ids.flatMap((id) => kinds.map((kind) => partNumber(kind, id)))
    expect(new Set(labels).size).toBe(ids.length * kinds.length)
    expect(labels.every((label) => /^[A-Za-z0-9_-]+$/.test(label))).toBe(true)
    expect(partNumber('profile', '\ud800')).toBe('P-_D800')
  })

  it('keeps fitting board boundaries distinct from encoded source and board keys', () => {
    const labels = [partNumber('fitting', 'x.B-front'), fittingBoardNumber('x', 'front'),
      fittingBoardNumber('x.B-y', 'z'), fittingBoardNumber('x', 'y.B-z'), partNumber('panel', 'x-front')]
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('preserves every label through file and latest share-link round trips', async () => {
    const doc = makeDoc(), expected = numbersOf(bomOf(doc))
    expect(numbersOf(bomOf(parseProjectDocument(serializeProjectDocument(doc))))).toEqual(expected)
    const url = await encodeShareLink(doc, 'https://example.com/')
    expect(numbersOf(bomOf(await decodeShare(new URL(url).hash.slice(3))))).toEqual(expected)
  })

  it('keeps identity on resize and undo while a copy receives a new number', () => {
    const doc = makeDoc()
    useStore.getState().loadDocument(doc)
    useStore.setState({ past: [], future: [], selectedIds: [doc.profiles[0].id] })
    const original = partNumber('profile', doc.profiles[0].id)
    expect(useStore.getState().commitProfileEdit(doc.profiles[0].id, { length: 1200 }).status).toBe('applied')
    expect(partNumber('profile', useStore.getState().profiles[0].id)).toBe(original)
    useStore.getState().undo()
    expect(partNumber('profile', useStore.getState().profiles[0].id)).toBe(original)
    expect(duplicateSelected()).toBe(true)
    expect(partNumber('profile', useStore.getState().profiles.at(-1)!.id)).not.toBe(original)
    useStore.getState().undo()
    expect(numbersOf(bomOf(useStore.getState()))).toEqual(numbersOf(bomOf(doc)))
  })
})

describe('numbered material and cutting lists', () => {
  it('retains every grouped entity and every stable fitting board key', () => {
    const doc = makeDoc(), bom = bomOf(doc)
    const expected = [
      ...doc.profiles.map((p) => partNumber('profile', p.id)), ...doc.connectors.map((c) => partNumber('connector', c.id)),
      ...doc.panels.map((p) => partNumber('panel', p.id)),
      ...doc.fittings.flatMap((f) => fittingParts(f).boards.map((b) => fittingBoardNumber(f.id, b.key))),
    ].sort()
    expect(numbersOf(bom)).toEqual(expected)
    for (const row of [...bom.profiles, ...bom.panels]) expect(row.partNumbers).toHaveLength(row.qty)
    for (const row of [...bom.fasteners, ...bom.suggested]) expect(row.partNumbers).toEqual([])
    expect(bom.connectors.find((row) => row.key.startsWith('runner-'))!.partNumbers).toEqual([])
    expect(bom.connectors.find((row) => row.key.startsWith('hinge-'))!.partNumbers).toEqual([])
  })

  it('keeps board numbers when hardware settings or fitting dimensions change', () => {
    const f = makeDoc().fittings[1], next: FittingData = { ...f, width: 700, depth: 600,
      drawer: { ...f.drawer, runnerLength: 450, runnerTravel: 300 } }
    expect(buildBom([], [], new Map(), 'en', [], [next]).panels.flatMap((row) => row.partNumbers).sort())
      .toEqual(buildBom([], [], new Map(), 'en', [], [f]).panels.flatMap((row) => row.partNumbers).sort())
  })

  it('produces identical CSV and bar allocation when document arrays are reordered', () => {
    const doc = makeDoc(), bom = bomOf(doc)
    const reverse = bomOf({ ...doc, profiles: [...doc.profiles].reverse(), connectors: [...doc.connectors].reverse(),
      panels: [...doc.panels].reverse(), fittings: [...doc.fittings].reverse() })
    expect(bomToCsv(reverse, '')).toBe(bomToCsv(bom, ''))
    expect(nestProfiles(reverse.profiles)).toEqual(nestProfiles(bom.profiles))
  })

  it('tracks each numbered cut exactly once, including pieces longer than stock', () => {
    const doc = makeDoc()
    doc.profiles[1].fixedTrims = { start: 12.5, end: 3.125 }
    const bom = bomOf(doc), plan = nestProfiles(bom.profiles), trims = computeAllTrims(doc.profiles, doc.throughRule)
    const lengths = new Map(doc.profiles.map((p) => [partNumber('profile', p.id), trims.get(p.id)!.cutLength]))
    const seen: string[] = []
    for (const bar of plan.bars) {
      expect(bar.partNumbers).toHaveLength(bar.cuts.length)
      bar.cuts.forEach((length, i) => { expect(lengths.get(bar.partNumbers[i])).toBe(length); seen.push(bar.partNumbers[i]) })
    }
    for (const row of plan.unsatisfied) {
      expect(row.partNumbers).toHaveLength(row.qty)
      row.partNumbers.forEach((number) => { expect(lengths.get(number)).toBe(row.length); seen.push(number) })
    }
    expect(seen.sort()).toEqual([...lengths.keys()].sort())
    expect(nestingCsv(plan)).toContain(plan.unsatisfied[0].partNumbers[0])
    expect(nestProfiles([...bom.profiles].reverse().map((row) => ({ ...row, partNumbers: [...row.partNumbers].reverse() })))).toEqual(plan)
  })

  it('exports one additional identity column while inferred hardware stays blank', () => {
    const bom = bomOf(makeDoc()), csv = bomToCsv(bom, '1200x600x800')
    expect(csv.split('\n')[0]).toBe('Category,Item,Spec,Cut length (mm),Quantity,Part numbers')
    expect(csv).toContain('"P-p-A; P-p-a; P-p_005F002D"')
    expect(csv.split('\n').find((line) => line.startsWith('Fastener,'))).toMatch(/,""$/)
    expect(nestingCsv(nestProfiles(bom.profiles)).split('\n')[0]).toBe('Spec,Bar,Cuts (mm),Pieces,Offcut (mm),Part numbers')
  })
})
