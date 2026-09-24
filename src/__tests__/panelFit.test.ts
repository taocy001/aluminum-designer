import { describe, it, expect, beforeEach } from 'vitest'
import * as THREE from 'three'
import { useStore, type PanelData, type ProfileData, type ProfileSpec } from '../store/useStore'
import { buildProfile } from '../utils/profileFactory'
import { panelFromSelection } from '../utils/panelOps'
import { shelfEdges } from '../utils/shelfSupport'
import { findConflicts } from '../utils/analysis'
import { computeAllTrims } from '../utils/jointUtils'

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

describe('a board fitted to four floor rails lies on them', () => {
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

  it('inset: between the corner posts, on top of the rails, not cut in half by the middle post', () => {
    const c = cabinet()
    load(c.all)
    useStore.getState().selectItems(c.bottom.map((p) => p.id))
    const board = panelFromSelection('mdf', 18, 'inset')!
    const b = slab(board)
    expect(b.min.y).toBeCloseTo(30, 1)
    // the corner posts' inner faces are at 10 and 590 both ways
    expect(b.min.x).toBeCloseTo(10, 1)
    expect(b.max.x).toBeCloseTo(590, 1)
    expect(b.min.z).toBeCloseTo(10, 1)
    expect(b.max.z).toBeCloseTo(590, 1)
  })

  it('and whichever way it was fitted, all four edges are carried', () => {
    for (const fit of ['overlay', 'inset'] as const) {
      const c = cabinet()
      load(c.all)
      useStore.getState().selectItems(c.bottom.map((p) => p.id))
      const board = panelFromSelection('mdf', 18, fit)!
      const edges = shelfEdges([board], useStore.getState().profiles)
      expect(edges.filter((e) => e.carried).length).toBe(4)
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
    id: 'b', width: 580, height: 580, thickness: 18, position: [300, y, 300], quaternion: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], material: 'mdf',
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
})
