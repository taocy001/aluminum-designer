import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { buildDxf } from '../utils/dxf'
import { buildProfile } from '../utils/profileFactory'
import { computeAllTrims, setThroughRule } from '../utils/jointUtils'
import { fittingParts } from '../utils/fittingGeometry'
import { fittingBoardNumber, partNumber } from '../utils/partNumbers'
import { buildStep } from '../utils/step'
import { equipment } from './fixtures/equipment'
import type { ConnectorData, FittingData, PanelData, ProfileData } from '../store/useStore'

setThroughRule('rails')
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const P = (sx: number, sy: number, sz: number, ex: number, ey: number, ez: number): ProfileData =>
  buildProfile(V(sx, sy, sz), V(ex, ey, ez), '2020')!

/** Read DXF entities as group-code/value pairs. */
function parse(dxf: string) {
  const lines = dxf.split('\n')
  const pairs: Array<[string, string]> = []
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([lines[i].trim(), lines[i + 1].trim()])

  const entities: Array<{ type: string; layer: string; pts: number[][]; text?: string }> = []
  let cur: { type: string; layer: string; pts: number[][]; text?: string } | null = null
  const xy: Record<string, number> = {}
  for (let i = 0; i < pairs.length; i++) {
    const [code, value] = pairs[i]
    if (code === '0') {
      if (cur) entities.push(cur)
      cur = ['LINE', 'TEXT'].includes(value) ? { type: value, layer: '0', pts: [] } : null
      continue
    }
    if (!cur) continue
    if (code === '8') cur.layer = value
    else if (code === '10' || code === '11') xy[code] = parseFloat(value)
    else if (code === '20') cur.pts.push([xy['10'], parseFloat(value)])
    else if (code === '21') cur.pts.push([xy['11'], parseFloat(value)])
    else if (code === '1') cur.text = value
  }
  if (cur) entities.push(cur)
  return entities
}

const empty = { profiles: [] as ProfileData[], panels: [] as PanelData[], fittings: [] as FittingData[] }

describe('the drawing as a file', () => {
  it('is a well-formed DXF even with nothing in it', () => {
    const dxf = buildDxf(empty)
    expect(dxf).toContain('SECTION')
    expect(dxf).toContain('ENTITIES')
    expect(dxf.trimEnd().endsWith('EOF')).toBe(true)
    expect(dxf).toContain('AC1009')
  })

  it('names its layers, so a reader can switch parts of it off', () => {
    const dxf = buildDxf({ ...empty, profiles: [P(0, 10, 0, 600, 10, 0)] })
    for (const layer of ['MEMBERS', 'DIMS', 'TEXT']) expect(dxf).toContain(`\n${layer}\n`)
  })

  it('draws three views, each labelled', () => {
    const e = parse(buildDxf({ ...empty, profiles: [P(0, 10, 0, 600, 10, 0)] }))
    const labels = e.filter((x) => x.type === 'TEXT').map((x) => x.text)
    expect(labels).toContain('FRONT (X-Y)')
    expect(labels).toContain('TOP (X-Z)')
    expect(labels).toContain('RIGHT (Z-Y)')
  })

  it('gives each member a rectangle in every view', () => {
    const e = parse(buildDxf({ ...empty, profiles: [P(0, 10, 0, 600, 10, 0)] }))
    expect(e.filter((x) => x.layer === 'MEMBERS').length).toBe(4 * 3)
  })

  it('the views do not sit on top of each other', () => {
    const e = parse(buildDxf({ ...empty, profiles: [P(0, 10, 0, 600, 10, 0)] }))
    const xs = e.filter((x) => x.type === 'TEXT' && x.text?.includes('(')).map((x) => x.pts[0][0])
    expect(xs).toHaveLength(3)
    expect(new Set(xs.map(Math.round)).size).toBe(3)
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0)
  })

  it('measures the frame rather than leaving it to be scaled off the paper', () => {
    const e = parse(buildDxf({ ...empty, profiles: [P(0, 10, 0, 600, 10, 0)] }))
    const dims = e.filter((x) => x.type === 'TEXT' && /^\d+$/.test(x.text ?? ''))
    // a 600 member 20 across: the front view is 600 wide and 20 tall
    expect(dims.map((x) => x.text)).toContain('600')
    expect(dims.map((x) => x.text)).toContain('20')
  })

  it('a board reaches the cut sheet with the size it will be cut to', () => {
    const board: PanelData = {
      id: 'b1', width: 560, height: 350, thickness: 18,
      position: [0, 400, 0], quaternion: [0, 0, 0, 1], material: 'mdf',
    }
    const e = parse(buildDxf({ ...empty, panels: [board] }))
    expect(e.some((x) => x.text === `${partNumber('panel', board.id)} 560x350x18 mdf`)).toBe(true)
    expect(e.filter((x) => x.layer === 'CUTSHEET').length).toBe(4)
  })

  it('projects board thickness only along its normal, preserving the real width and height', () => {
    const board: PanelData = { id: 'b', width: 600, height: 400, thickness: 18,
      position: [0, 0, 0], quaternion: [0, 0, 0, 1], material: 'mdf' }
    const e = parse(buildDxf({ ...empty, panels: [board] }))
    expect(e.filter((x) => x.layer === 'DIMS' && x.type === 'TEXT').map((x) => x.text)).toEqual(['600', '400', '600', '18', '18', '400'])
  })

  it('draws a rotated board as its silhouette rather than its world bounding rectangle', () => {
    const q = new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), Math.PI / 4)
    const board: PanelData = { id: 'b', width: 600, height: 400, thickness: 18,
      position: [0, 0, 0], quaternion: q.toArray(), material: 'mdf' }
    const front = parse(buildDxf({ ...empty, panels: [board] })).filter((e) => e.layer === 'BOARDS').slice(0, 4)
    expect(front.every((e) => Math.abs(e.pts[0][0] - e.pts[1][0]) > 1 && Math.abs(e.pts[0][1] - e.pts[1][1]) > 1)).toBe(true)
  })

  it('uses the actual overlay leaf in its closed position in elevations', () => {
    const door: FittingData = { id: 'door', kind: 'door', width: 600, height: 800, depth: 400,
      position: [0, 1000, 0], quaternion: [0, 0, 0, 1], material: 'mdf', frame: 20, overlay: 'full', open: 0 }
    const closed = parse(buildDxf({ ...empty, fittings: [door] }))
    expect(closed.filter((x) => x.layer === 'DIMS' && x.type === 'TEXT').map((x) => x.text)).toContain('630')
    expect(buildDxf({ ...empty, fittings: [door] })).toBe(buildDxf({ ...empty, fittings: [{ ...door, open: 1 }] }))
  })

  it('a drawer brings its own boards to the cut sheet', () => {
    const drawer: FittingData = {
      id: 'f1', kind: 'drawer', position: [300, 120, 300], quaternion: [0, 0, 0, 1],
      width: 580, height: 250, depth: 580, material: 'ply', open: 0,
    }
    const e = parse(buildDxf({ ...empty, fittings: [drawer] }))
    const labels = e.map((x) => x.text ?? '')
    expect(labels.some((s) => s.includes('F-f1.B-side-left'))).toBe(true)
    expect(labels.some((s) => s.includes('F-f1.B-front'))).toBe(true)
    expect(labels.some((s) => s.includes('F-f1.B-base'))).toBe(true)
  })

  it('the cut sheet is below the views, not through them', () => {
    const board: PanelData = {
      id: 'b1', width: 560, height: 350, thickness: 18,
      position: [0, 400, 0], quaternion: [0, 0, 0, 1], material: 'mdf',
    }
    const e = parse(buildDxf({ ...empty, profiles: [P(0, 10, 0, 600, 810, 0)], panels: [board] }))
    const viewY = Math.min(...e.filter((x) => x.layer === 'MEMBERS').flatMap((x) => x.pts.map((p) => p[1])))
    const sheetY = Math.max(...e.filter((x) => x.layer === 'CUTSHEET').flatMap((x) => x.pts.map((p) => p[1])))
    expect(sheetY).toBeLessThan(viewY)
  })

  it('every coordinate is a real number, whatever is in the drawing', () => {
    const dxf = buildDxf({
      profiles: [P(0, 10, 0, 600, 10, 0), P(0, 10, 0, 0, 610, 0)],
      panels: [{ id: 'b', width: 100, height: 100, thickness: 5, position: [0, 0, 0], quaternion: [0, 0, 0, 1], material: 'ply' }],
      fittings: [{ id: 'f', kind: 'door', position: [0, 300, 0], quaternion: [0, 0, 0, 1], width: 400, height: 600, depth: 500, material: 'mdf', open: 0, hinge: 'left', hingeType: 'cup', overlay: 'full' }],
    })
    expect(dxf).not.toMatch(/\bNaN\b/)
    expect(dxf).not.toMatch(/\bInfinity\b/)
  })

  it('uses the same unique part numbers in all views, cut sheets and STEP instances', () => {
    const profiles = [P(0, 0, 0, 400, 0, 0), P(0, 100, 0, 400, 100, 0)]
      .map((p, i) => ({ ...p, id: `rail-${i + 1}` }))
    const panel: PanelData = { id: '板_1', width: 200, height: 300, thickness: 18,
      position: [400, 400, 0], quaternion: [0, 0, 0, 1], material: 'ply' }
    const connector: ConnectorData = { id: 'joint-1', type: 'bracket', position: [100, 0, 0], quaternion: [0, 0, 0, 1] }
    const drawer: FittingData = { id: 'drawer-1', kind: 'drawer', width: 600, height: 240, depth: 500,
      position: [0, 500, 0], quaternion: [0, 0, 0, 1], material: 'ply', open: 1,
      drawer: { reinforcement: { count: 2, width: 40, height: 20 } } }
    const doc = { profiles, connectors: [connector], panels: [panel], fittings: [drawer] }
    const drawing = parse(buildDxf(doc))
    const step = buildStep(doc)
    const boardNumbers = [partNumber('panel', panel.id), ...fittingParts(drawer).boards.map((b) => fittingBoardNumber(drawer.id, b.key))]
    const numbers = [...profiles.map((p) => partNumber('profile', p.id)), partNumber('connector', connector.id), ...boardNumbers]
    expect(new Set(numbers).size).toBe(numbers.length)
    expect(drawing.filter((e) => e.layer === 'CONNECTORS' && e.type === 'LINE')).toHaveLength(12)
    for (const number of numbers) {
      const labels = drawing.filter((e) => e.layer === 'PART_NUMBERS' && e.text === number)
      expect(labels, number).toHaveLength(3)
      expect(step).toContain(`PRODUCT('${number}','${number}',`)
      expect(step).toContain(`NEXT_ASSEMBLY_USAGE_OCCURRENCE('${number}','${number}',`)
    }
    for (const number of boardNumbers) {
      expect(drawing.filter((e) => e.layer === 'TEXT' && e.text?.startsWith(`${number} `)), number).toHaveLength(1)
    }
    const reordered = parse(buildDxf({ ...doc, profiles: [...profiles].reverse(), fittings: [{ ...drawer, open: 0, width: 640 }] }))
    expect(reordered.filter((e) => e.layer === 'PART_NUMBERS' && e.type === 'TEXT').map((e) => e.text).sort())
      .toEqual(drawing.filter((e) => e.layer === 'PART_NUMBERS' && e.type === 'TEXT').map((e) => e.text).sort())
    const remaining = parse(buildDxf({ ...doc, profiles: [profiles[1]] }))
    expect(remaining.filter((e) => e.text === partNumber('profile', profiles[1].id))).toHaveLength(3)
    expect(remaining.some((e) => e.text === partNumber('profile', profiles[0].id))).toBe(false)
  })

  it('honours the explicit through rule, supplied trims and fixed cut dimensions', () => {
    const profiles = [P(0, 0, 0, 0, 400, 0), P(0, 400, 0, 600, 400, 0)]
    const rails = buildDxf({ ...empty, profiles, rule: 'rails' })
    const posts = buildDxf({ ...empty, profiles, rule: 'posts' })
    expect(rails).not.toBe(posts)
    expect(buildDxf({ ...empty, profiles, rule: 'posts', trims: computeAllTrims(profiles, 'rails') })).toBe(rails)
    const fixed = { ...P(0, 0, 0, 500, 0, 0), fixedTrims: { start: 10, end: 30 } }
    const dims = parse(buildDxf({ ...empty, profiles: [fixed] })).filter((e) => e.layer === 'DIMS' && e.type === 'TEXT')
    expect(dims.map((e) => e.text)).toEqual(['460', '20', '460', '20', '20', '20'])
  })

  it('excludes equipment geometry and labels from manufacturing drawings', () => {
    const ordinary = { ...empty, profiles: [P(0, 0, 0, 500, 0, 0)] }
    const doc = { ...ordinary, equipment: [equipment('excluded-device')] }
    const result = buildDxf(doc)
    expect(result).toBe(buildDxf(ordinary))
    expect(result).not.toContain('excluded-device')
  })
})
