import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { buildDxf } from '../utils/dxf'
import { buildProfile } from '../utils/profileFactory'
import { setThroughRule } from '../utils/jointUtils'
import type { FittingData, PanelData, ProfileData } from '../store/useStore'

setThroughRule('rails')
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const P = (sx: number, sy: number, sz: number, ex: number, ey: number, ez: number): ProfileData =>
  buildProfile(V(sx, sy, sz), V(ex, ey, ez), '2020')!

/**
 * Read the entities back out, so the test checks the file rather than the code that wrote it.
 *
 * DXF is pairs: a group code on one line, its value on the next. Walking it a line at a time
 * reads every value as a code, and since a z coordinate of 0 looks exactly like the code that
 * starts a new entity, the whole file parses as nothing. Two at a time.
 */
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
    expect(dxf).toContain('AC1009')      // R12: the form every reader opens
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
    expect(e.some((x) => x.text?.startsWith('560x350x18'))).toBe(true)
    expect(e.filter((x) => x.layer === 'CUTSHEET').length).toBe(4)
  })

  it('a drawer brings its own boards to the cut sheet', () => {
    const drawer: FittingData = {
      id: 'f1', kind: 'drawer', position: [300, 120, 300], quaternion: [0, 0, 0, 1],
      width: 580, height: 250, depth: 580, material: 'ply', open: 0,
    }
    const e = parse(buildDxf({ ...empty, fittings: [drawer] }))
    const labels = e.map((x) => x.text ?? '')
    expect(labels.some((s) => s.includes('drawer/side'))).toBe(true)
    expect(labels.some((s) => s.includes('drawer/front'))).toBe(true)
    expect(labels.some((s) => s.includes('drawer/base'))).toBe(true)
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
})
