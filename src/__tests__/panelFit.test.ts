import { describe, it, expect, beforeEach } from 'vitest'
import * as THREE from 'three'
import { useStore, type PanelData, type ProfileData, type ProfileSpec } from '../store/useStore'
import { buildProfile } from '../utils/profileFactory'
import { panelFromSelection } from '../utils/panelOps'
import { shelfEdges } from '../utils/shelfSupport'
import { findConflicts } from '../utils/analysis'
import { computeAllTrims } from '../utils/jointUtils'
import { attachPanels } from '../utils/attachPanels'
import { unfastenedPanels } from '../utils/panelFastening'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const P = (sx: number, sy: number, sz: number, ex: number, ey: number, ez: number, spec: ProfileSpec = '2020'): ProfileData =>
  buildProfile(V(sx, sy, sz), V(ex, ey, ez), spec)!
const load = (profiles: ProfileData[]) =>
  useStore.getState().loadDocument({ profiles, connectors: [], panels: [], fittings: [] } as never)
beforeEach(() => load([]))

/** the world box a board fills, worked out from its corners here rather than borrowed */
function slab(b: PanelData): THREE.Box3 {
  const q = new THREE.Quaternion(...b.quaternion).normalize()
  const out = new THREE.Box3()
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    out.expandByPoint(new THREE.Vector3(sx * b.width / 2, sy * b.height / 2, sz * b.thickness / 2).applyQuaternion(q).add(new THREE.Vector3(...b.position)))
  }
  return out
}

/**
 * A 600 × 600 cabinet in 2020, posts standing on the floor at the four corners (centre
 * lines on x = 0/600, z = 0/600, so each post is 20 mm either side of them), a ring of rails
 * at the bottom (y 10..30) and at the top, and one extra post up the middle of the front.
 */
function cabinet() {
  const posts = [0, 600].flatMap((x) => [0, 600].map((z) => P(x, 0, z, x, 880, z)))
  const ring = (y: number) => [P(0, y, 0, 600, y, 0), P(0, y, 600, 600, y, 600), P(0, y, 0, 0, y, 600), P(600, y, 0, 600, y, 600)]
  const bottom = ring(20), top = ring(860)
  const mid = P(300, 20, 0, 300, 860, 0)
  return { posts, bottom, top, mid, all: [...posts, ...bottom, ...top, mid] }
}

describe('horizontal board placement', () => {
  it('overlay: on top of the rails, clear of every post, not under the floor', () => {
    const c = cabinet()
    load(c.all)
    useStore.getState().selectItems(c.bottom.map((p) => p.id))
    const board = panelFromSelection('mdf', 18, 'overlay')!
    const b = slab(board)
    expect(b.min.y).toBeCloseTo(30, 1)           // the rails' top face is y = 30
    expect(b.max.y - b.min.y).toBeCloseTo(18, 1)
    const s = useStore.getState()
    expect(findConflicts(s.profiles, computeAllTrims(s.profiles), [], [board])).toEqual([])
  })

  it('inset: flush with the rail tops and bounded by the full opening', () => {
    const c = cabinet()
    load(c.all)
    useStore.getState().selectItems(c.bottom.map((p) => p.id))
    const board = panelFromSelection('mdf', 18, 'inset')!
    const b = slab(board)
    expect(b.max.y).toBeCloseTo(30, 1)
    expect(b.min.y).toBeCloseTo(12, 1)
    // the corner posts' inner faces are at 10 and 590 both ways
    expect(b.min.x).toBeCloseTo(10, 1)
    expect(b.max.x).toBeCloseTo(590, 1)
    expect(b.min.z).toBeCloseTo(10, 1)
    expect(b.max.z).toBeCloseTo(590, 1)
  })

  it.each([6, 12, 18, 20])('fastens a flush %i mm inset shelf without intersections', (thickness) => {
    const c = cabinet()
    load(c.all)
    useStore.getState().selectItems(c.bottom.map(p => p.id))
    const board = panelFromSelection('mdf', thickness, 'inset')!
    expect(slab(board).max.y).toBeCloseTo(30)
    const doc = { profiles: c.all, panels: [board], connectors: [], fittings: [] }
    let i = 0
    const installed = attachPanels(doc, [board.id], () => `mount-${i++}`)
    expect(installed.made).toHaveLength(8)
    const complete = { ...doc, connectors: installed.made }
    expect(unfastenedPanels(complete)).toEqual([])
    expect(findConflicts(c.all, computeAllTrims(c.all), installed.made, [board])).toEqual([])
  })

  it('a board clipped to the inner opening needs additional bearing below it', () => {
    for (const fit of ['overlay', 'inset'] as const) {
      const c = cabinet()
      load(c.all)
      useStore.getState().selectItems(c.bottom.map((p) => p.id))
      const board = panelFromSelection('mdf', 18, fit)!
      const edges = shelfEdges([board], useStore.getState().profiles)
      const b = slab(board)
      // The 20 mm rail ends at x/z=10; touching that edge has zero bearing area.
      expect(b.min.x).toBeCloseTo(10)
      expect(b.min.z).toBeCloseTo(10)
      expect(edges.filter((e) => e.carried).length).toBe(0)
    }
  })
})

describe('a board fitted to the top ring', () => {
  it('overlay: lies on the rails and covers the metal it was fitted to, measured on the cut members', () => {
    const c = cabinet()
    load(c.all)
    useStore.getState().selectItems(c.top.map((p) => p.id))
    const board = panelFromSelection('mdf', 18, 'overlay')!
    const b = slab(board)
    const s = useStore.getState()
    expect(findConflicts(s.profiles, computeAllTrims(s.profiles), [], [board])).toEqual([])
    // the posts run to 880, above the top ring, so the board sits on the rails between them
    expect(b.min.y).toBeCloseTo(870, 1)
  })
})

describe('what carries a shelf', () => {
  const board = (y: number): PanelData => ({
    id: 'b', width: 600, height: 600, thickness: 18, position: [300, y, 300], quaternion: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], material: 'mdf',
  })
  const rails = [P(0, 440, 0, 600, 440, 0), P(0, 440, 600, 600, 440, 600), P(0, 440, 0, 0, 440, 600), P(600, 440, 0, 600, 440, 600)]
  it('a board resting on the rails is carried on four sides', () => {
    expect(shelfEdges([board(450 + 9)], rails).filter((e) => e.carried).length).toBe(4)
  })
  it('a board hung at the rails\' mid-height, beside them, is carried on none', () => {
    expect(shelfEdges([board(440)], rails).filter((e) => e.carried).length).toBe(0)
  })
  it('a board under the rails is carried on none', () => {
    expect(shelfEdges([board(430 - 9)], rails).filter((e) => e.carried).length).toBe(0)
  })
  it('rails separated from all board edges by a 10 mm gap carry none', () => {
    const far = [P(-20, 440, 0, -20, 440, 600), P(620, 440, 0, 620, 440, 600),
      P(0, 440, -20, 600, 440, -20), P(0, 440, 620, 600, 440, 620)]
    expect(shelfEdges([board(459)], far).filter((e) => e.carried)).toEqual([])
  })

  it('a rising rail touching the underside only at its tip carries no whole edge', () => {
    const sloped = [P(0, 200, 0, 600, 438, 0)]
    expect(shelfEdges([board(459)], sloped).filter((e) => e.carried)).toEqual([])
  })

  it('a 1 mm vertical gap is not resting contact', () => {
    expect(shelfEdges([board(460)], rails).filter((e) => e.carried)).toEqual([])
  })

  it('checks a rotated board along its real sides, not the sides of its world AABB', () => {
    const q = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), Math.PI / 4)
      .multiply(new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), -Math.PI / 2))
    const b = { ...board(19), position: [0, 19, 0] as [number, number, number], quaternion: q.toArray() as PanelData['quaternion'] }
    const bounds = slab(b), lo = bounds.min.x, hi = bounds.max.x, near = lo + 5
    const far = [P(near, 0, lo, near, 0, hi), P(-near, 0, lo, -near, 0, hi),
      P(lo, 0, near, hi, 0, near), P(lo, 0, -near, hi, 0, -near)]
    const edges = shelfEdges([b], far)
    expect(edges.filter((e) => e.carried)).toEqual([])
    expect(edges.every((e) => Math.abs(e.a.distanceTo(e.b) - 600) < 0.01)).toBe(true)

    const point = (x: number, y: number) => V(x, y, 0).applyQuaternion(q)
    const bearing = [[-290, -300, -290, 300], [290, -300, 290, 300],
      [-300, -290, 300, -290], [-300, 290, 300, 290]].map(([x0, y0, x1, y1]) => buildProfile(point(x0, y0), point(x1, y1), '2020')!)
    expect(shelfEdges([b], bearing).filter((e) => e.carried)).toHaveLength(4)
  })
})
