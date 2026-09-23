import { describe, it, expect, beforeEach } from 'vitest'
import * as THREE from 'three'
import { useStore, type ProfileData, type ProfileSpec } from '../store/useStore'
import { buildProfile } from '../utils/profileFactory'
import { addFittingFromSelection } from '../utils/fittingOps'
import { connectedTo } from '../utils/editOps'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const P = (sx: number, sy: number, sz: number, ex: number, ey: number, ez: number, spec: ProfileSpec = '2020'): ProfileData =>
  buildProfile(V(sx, sy, sz), V(ex, ey, ez), spec)!

/** a plain box cabinet at the given depth line, 600 wide and 880 tall */
function cabinet(z0: number, d: number, x0 = 0): ProfileData[] {
  const out: ProfileData[] = []
  for (const x of [x0, x0 + 600]) for (const z of [z0, z0 + d]) out.push(P(x, 0, z, x, 880, z))
  for (const y of [20, 860]) {
    out.push(P(x0, y, z0, x0 + 600, y, z0))
    out.push(P(x0, y, z0 + d, x0 + 600, y, z0 + d))
    for (const x of [x0, x0 + 600]) out.push(P(x, y, z0, x, y, z0 + d))
  }
  return out
}

const load = (profiles: ProfileData[]) =>
  useStore.getState().loadDocument({ profiles, connectors: [], panels: [], fittings: [] } as never)

beforeEach(() => load([]))

/**
 * "Which cabinet is this door on?" was answered with a box query that reached without limit
 * into the depth, on the grounds that depth is the one thing an opening does not describe.
 * In a room with cabinets standing behind one another it found all of them, and a kitchen
 * door came out eleven metres deep.
 */
describe('a door belongs to one cabinet', () => {
  it('takes its depth from its own cabinet, not from the one behind it', () => {
    const front = cabinet(0, 600)
    const behind = cabinet(5200, 400)
    load([...front, ...behind])
    const posts = front.filter((p) => p.position[2] === 0 && p.length === 880)
    useStore.getState().selectItems(posts.map((p) => p.id))
    expect(addFittingFromSelection({ kind: 'door', hinge: 'left' })).toBe(true)
    const door = useStore.getState().fittings[0]
    expect(door.depth).toBeGreaterThan(300)
    expect(door.depth).toBeLessThan(700)
    expect(door.position[2]).toBeLessThan(700)
  })

  it('and a lone cabinet is unaffected', () => {
    const only = cabinet(0, 600)
    load(only)
    const posts = only.filter((p) => p.position[2] === 0 && p.length === 880)
    useStore.getState().selectItems(posts.map((p) => p.id))
    expect(addFittingFromSelection({ kind: 'door', hinge: 'left' })).toBe(true)
    expect(useStore.getState().fittings[0].depth).toBeLessThan(700)
  })
})

describe('what counts as one piece of furniture', () => {
  it('is what is bolted together, not what is nearby', () => {
    const a = cabinet(0, 600)
    const b = cabinet(5200, 400)
    const all = [...a, ...b]
    const group = connectedTo([a[0].id], all)
    expect(group.size).toBe(a.length)
    for (const p of b) expect(group.has(p.id)).toBe(false)
  })
})

import { panelFromSelection } from '../utils/panelOps'

/**
 * Picking the two side rails of a shelf says how wide it is and nothing about how deep: the
 * rails run the full depth, so measuring between them there gives back their own length. The
 * board came out 600 deep in a cabinet with 580 between its front and back posts — every
 * shelf in an eight-cabinet drawing too big by exactly one post, and not one of them would
 * have gone in.
 */
describe('an inset board fits the opening, not the two rails that were picked', () => {
  it('is bounded by the cabinet in the direction the rails run', () => {
    const box = cabinet(0, 600)
    const rails = [P(0, 440, 0, 0, 440, 600), P(600, 440, 0, 600, 440, 600)]
    load([...box, ...rails])
    useStore.getState().selectItems(rails.map((p) => p.id))
    const board = panelFromSelection('mdf', 18, 'inset')!
    expect(board).not.toBeNull()
    const sides = [board.width, board.height].sort((a, b) => a - b)
    expect(sides[0]).toBeCloseTo(580, 0)      // between the rails
    expect(sides[1]).toBeCloseTo(580, 0)      // between the front and back posts
  })

  it('and an overlay board still covers the frame it was given', () => {
    const box = cabinet(0, 600)
    const rails = [P(0, 440, 0, 0, 440, 600), P(600, 440, 0, 600, 440, 600)]
    load([...box, ...rails])
    useStore.getState().selectItems(rails.map((p) => p.id))
    const board = panelFromSelection('mdf', 18, 'overlay')!
    const sides = [board.width, board.height].sort((a, b) => a - b)
    expect(sides[0]).toBeCloseTo(600, 0)
    expect(sides[1]).toBeCloseTo(620, 0)
  })
})

import { findConflicts } from '../utils/analysis'
import { computeAllTrims } from '../utils/jointUtils'

/**
 * The interference check took the metal and the hardware and stopped there. Boards and
 * fittings were never looked at, so a drawing with every one of its doors sunk into the posts
 * and every back board buried in the frame reported nothing wrong at all — and said so with
 * the same confidence as a drawing that really was clean.
 */
describe('a board inside a post is as unbuildable as two members through each other', () => {
  const frame = () => cabinet(0, 600)

  it('finds a board buried in the frame', () => {
    const ps = frame()
    const buried = {
      id: 'b1', width: 600, height: 800, thickness: 18,
      position: [300, 400, 0], quaternion: [0, 0, 0, 1], material: 'mdf',
    } as never
    expect(findConflicts(ps, computeAllTrims(ps), [], [buried]).length).toBeGreaterThan(0)
  })

  it('and leaves a board resting against the frame alone', () => {
    const ps = frame()
    const clear = {
      id: 'b2', width: 560, height: 800, thickness: 18,
      position: [300, 400, -20], quaternion: [0, 0, 0, 1], material: 'mdf',
    } as never
    expect(findConflicts(ps, computeAllTrims(ps), [], [clear])).toEqual([])
  })

  it('finds a door sunk into the post it hangs on', () => {
    const ps = frame()
    const sunk = {
      id: 'd1', kind: 'door', width: 580, height: 840, depth: 600,
      position: [300, 440, 300], quaternion: [0, 0, 0, 1], open: 0, overlay: 'full', hinge: 'left',
    } as never
    expect(findConflicts(ps, computeAllTrims(ps), [], [], [sunk]).length).toBeGreaterThan(0)
  })
})

/**
 * A door's leaf and a drawer's front both sit at +depth/2 in the fitting's own frame, so
 * that plane has to land on the outside face of the uprights the opening is framed by.
 * Landing it on their centreline sank all twenty doors of a drawing half a section into the
 * posts they hang on, and nothing said a word, because nothing was looking.
 */
describe('a door hangs on the front of the post, not inside it', () => {
  const load2 = (profiles: ProfileData[]) =>
    useStore.getState().loadDocument({ profiles, connectors: [], panels: [], fittings: [] } as never)

  it('leaves the post it hangs on alone', () => {
    const box = cabinet(0, 600)
    load2(box)
    const front = box.filter((p) => p.position[2] === 0 && p.length === 880)
    useStore.getState().selectItems(front.map((p) => p.id))
    expect(addFittingFromSelection({ kind: 'door', hinge: 'left' })).toBe(true)
    const s = useStore.getState()
    expect(findConflicts(s.profiles, computeAllTrims(s.profiles), [], [], s.fittings)).toEqual([])
  })

  it('and a drawer faces the way its own cabinet does, whatever else is in the drawing', () => {
    // a second cabinet far along Z: the drawing is now deeper than it is wide, and asking the
    // drawing which way is depth turns the drawer ninety degrees
    const mine = cabinet(0, 600)
    const far = cabinet(9000, 600)
    load2([...mine, ...far])
    useStore.getState().selectItems(mine.filter((p) => p.length === 880).map((p) => p.id))
    expect(addFittingFromSelection({ kind: 'drawer', frontHeight: 200, count: 1 })).toBe(true)
    const d = useStore.getState().fittings[0]
    expect(d.width).toBeGreaterThan(d.depth)      // 600 wide bay, 600 deep box, front is the bay
    const s = useStore.getState()
    expect(findConflicts(s.profiles, computeAllTrims(s.profiles), [], [], s.fittings)).toEqual([])
  })
})
