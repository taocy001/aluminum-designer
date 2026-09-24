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

  it('and an overlay board covers the rails it was given, stopping at the posts', () => {
    const box = cabinet(0, 600)
    const rails = [P(0, 440, 0, 0, 440, 600), P(600, 440, 0, 600, 440, 600)]
    load([...box, ...rails])
    useStore.getState().selectItems(rails.map((p) => p.id))
    const board = panelFromSelection('mdf', 18, 'overlay')!
    const sides = [board.width, board.height].sort((a, b) => a - b)
    // across: over both rails, 620; along them: the posts stand up through the rails' ends,
    // so the board is the 580 between them rather than a board through four posts
    expect(sides[0]).toBeCloseTo(580, 0)
    expect(sides[1]).toBeCloseTo(620, 0)
    const s = useStore.getState()
    expect(findConflicts(s.profiles, computeAllTrims(s.profiles), [], [board])).toEqual([])
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

/**
 * A board fitted over a frame lies on it. Centred on it, an 18 mm board is inside a 20 mm
 * post, which is not a place a board can be — six back panels in an eleven-cabinet drawing
 * were buried in the uprights they were meant to be screwed to.
 */
describe('an overlay board lies on the frame', () => {
  it('sits clear of the members it covers', () => {
    const box = cabinet(0, 600)
    load(box)
    const back = box.filter((p) => p.position[2] === 600 && p.length === 880)
    useStore.getState().selectItems(back.map((p) => p.id))
    const board = panelFromSelection('mdf', 18, 'overlay')!
    expect(board).not.toBeNull()
    const s = useStore.getState()
    expect(findConflicts(s.profiles, computeAllTrims(s.profiles), [], [board])).toEqual([])
    // and on the outside: further from the cabinet's middle than the posts are
    expect(board.position[2]).toBeGreaterThan(610)
  })
})

/**
 * A cabinet whose doors open into the room and whose drawers pull out towards the wall is
 * not a cabinet. Four uprights round an opening say nothing about which side is the front,
 * and counting metal either side is a guess — but a door already hung on the same carcase
 * is an answer, so it is used.
 */
describe('a drawer opens the way the cabinet already does', () => {
  it('follows a door already hung on the same carcase', () => {
    const box = cabinet(0, 600)
    load(box)
    const front = box.filter((p) => p.position[2] === 0 && p.length === 880)
    useStore.getState().selectItems(front.map((p) => p.id))
    expect(addFittingFromSelection({ kind: 'door', hinge: 'left' })).toBe(true)
    const door = useStore.getState().fittings[0]

    useStore.getState().selectItems(box.filter((p) => p.length === 880).map((p) => p.id))
    expect(addFittingFromSelection({ kind: 'drawer', frontHeight: 200, count: 1 })).toBe(true)
    const drawer = useStore.getState().fittings[1]

    const facing = (f: { quaternion: number[] }) =>
      new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(...(f.quaternion as [number, number, number, number])))
    expect(facing(drawer).dot(facing(door))).toBeGreaterThan(0.9)
  })
})

import { rotateSelected, selectionPivot } from '../utils/editOps'
import { fittingObb } from '../utils/fittingGeometry'

/**
 * Turning a selection turns it about its own middle. A drawer on its own had no middle as
 * far as this was concerned — the pivot was built from members and brackets only, and with
 * neither in the selection it fell back to the world origin, so turning a drawer in a
 * kitchen sent it several metres across the room.
 */
describe('turning a part turns it where it stands', () => {
  it('a drawer on its own turns about itself', () => {
    const box = cabinet(0, 600)
    load(box)
    useStore.getState().selectItems(box.filter((p) => p.length === 880).map((p) => p.id))
    expect(addFittingFromSelection({ kind: 'drawer', frontHeight: 200, count: 1 })).toBe(true)
    const before = fittingObb(useStore.getState().fittings[0]).center.clone()

    useStore.getState().selectItems([useStore.getState().fittings[0].id])
    expect(rotateSelected('y', 90)).toBe(true)
    const after = fittingObb(useStore.getState().fittings[0]).center
    expect(after.distanceTo(before)).toBeLessThan(1)
  })

  it('and a board on its own does too', () => {
    const box = cabinet(0, 600)
    load(box)
    const back = box.filter((p) => p.position[2] === 600 && p.length === 880)
    useStore.getState().selectItems(back.map((p) => p.id))
    const board = panelFromSelection('mdf', 18, 'overlay')!
    useStore.getState().addPanels([board], false)
    useStore.getState().selectItems([board.id])
    const at = new THREE.Vector3(...board.position)
    expect(selectionPivot([], [], 'center', [board], []).distanceTo(at)).toBeLessThan(1)
  })
})

/**
 * An L-shaped run is where "which side of the frame does this sit on" stops working. The
 * return leg drags the frame's middle round behind the long run, so every door on the long
 * run came out facing the wall. A cabinet is open at the front, and that is a local fact.
 */
describe('a door on an L-shaped run still faces the room', () => {
  it('faces away from the wall, not towards the middle of the L', () => {
    const D = 650, H = 880, W = 2400, inner = W - D
    const up: ProfileData[] = []
    // the long run: wall at z = 0, front at z = D, stopping at the inner corner
    for (const x of [0, 600, 1200, 1800, W]) up.push(P(x, 0, 0, x, H, 0))
    for (const x of [0, 600, 1200, inner]) up.push(P(x, 0, D, x, H, D))
    // the return: wall at x = W, front at x = inner
    for (const z of [1250, 1850]) for (const x of [inner, W]) up.push(P(x, 0, z, x, H, z))
    const rails: ProfileData[] = []
    for (const y of [20, H - 20]) {
      rails.push(P(0, y, 0, W, y, 0), P(0, y, D, inner, y, D))
      rails.push(P(inner, y, D, inner, y, 1850), P(W, y, D, W, y, 1850))
      for (const x of [0, 600, 1200, inner]) rails.push(P(x, y, 0, x, y, D))
    }
    const frame = [...up, ...rails]
    load(frame)

    // a bay on the long run, framed by its two front uprights
    const bay = frame.filter((p) => p.length === H && p.position[2] === D
      && (p.position[0] === 0 || p.position[0] === 600))
    expect(bay.length).toBe(2)
    useStore.getState().selectItems(bay.map((p) => p.id))
    expect(addFittingFromSelection({ kind: 'door', hinge: 'left' })).toBe(true)

    const door = useStore.getState().fittings[0]
    const facing = new THREE.Vector3(0, 0, 1)
      .applyQuaternion(new THREE.Quaternion(...door.quaternion))
    // the wall is at z = 0 and the room is at +z: it must open into the room
    expect(facing.z).toBeGreaterThan(0.9)
  })
})

/**
 * ...and it is as deep as the cabinet behind it, not as deep as the bounding box of the L it
 * belongs to. The return leg is inside that box while being nowhere behind the opening, and
 * a door on the long run came out nearly two metres deep, hinged out in the middle of the
 * room.
 */
describe('a door is as deep as what is behind it', () => {
  it('ignores a return leg that is not behind the opening', () => {
    const D = 650, H = 880, W = 2400, inner = W - D
    const frame: ProfileData[] = []
    for (const x of [0, 600, 1200, 1800, W]) frame.push(P(x, 0, 0, x, H, 0))
    for (const x of [0, 600, 1200, inner]) frame.push(P(x, 0, D, x, H, D))
    for (const z of [1250, 1850]) for (const x of [inner, W]) frame.push(P(x, 0, z, x, H, z))
    // bay by bay, because a rail cannot run through the post it crosses
    for (const y of [20, H - 20]) {
      for (const [a, b] of [[0, 600], [600, 1200], [1200, 1800], [1800, W]]) frame.push(P(a, y, 0, b, y, 0))
      for (const [a, b] of [[0, 600], [600, 1200], [1200, inner]]) frame.push(P(a, y, D, b, y, D))
      for (const [a, b] of [[D, 1250], [1250, 1850]]) {
        frame.push(P(inner, y, a, inner, y, b), P(W, y, a, W, y, b))
      }
      for (const x of [0, 600, 1200, inner]) frame.push(P(x, y, 0, x, y, D))
    }
    load(frame)
    const bay = frame.filter((p) => p.length === H && p.position[2] === D
      && (p.position[0] === 0 || p.position[0] === 600))
    useStore.getState().selectItems(bay.map((p) => p.id))
    expect(addFittingFromSelection({ kind: 'door', hinge: 'left' })).toBe(true)
    const door = useStore.getState().fittings[0]
    expect(door.depth).toBeLessThan(750)        // the run is 650 deep, not 1850
    const s = useStore.getState()
    const clashes = findConflicts(s.profiles, computeAllTrims(s.profiles), [], [], s.fittings)
    expect(clashes.filter((c) => c.a === door.id || c.b === door.id)).toEqual([])
  })
})

/**
 * An inside corner is genuinely ambiguous: the cabinet carries on in both directions, so
 * "which side has less in the way" has no answer there. What does have an answer is the two
 * doors already hanging on the same carcase — and that is evidence rather than a guess, so
 * nothing further down may overturn it. Without that the corner door faced the wall, and
 * took its depth from the return leg: 1220 mm, hinged out in the middle of the room.
 */
describe('doors on an L-shaped run follow one another', () => {
  const lShaped = (): ProfileData[] => {
    const D = 650, H = 880, W = 2400, inner = W - D
    const frame: ProfileData[] = []
    for (const x of [0, 600, 1200, 1800, W]) frame.push(P(x, 0, 0, x, H, 0))
    for (const x of [0, 600, 1200, inner]) frame.push(P(x, 0, D, x, H, D))
    for (const z of [1250, 1850]) for (const x of [inner, W]) frame.push(P(x, 0, z, x, H, z))
    for (const y of [20, H - 20]) {
      for (const [a, b] of [[0, 600], [600, 1200], [1200, 1800], [1800, W]]) frame.push(P(a, y, 0, b, y, 0))
      for (const [a, b] of [[0, 600], [600, 1200], [1200, inner]]) frame.push(P(a, y, D, b, y, D))
      for (const [a, b] of [[D, 1250], [1250, 1850]]) {
        frame.push(P(inner, y, a, inner, y, b), P(W, y, a, W, y, b))
      }
      for (const x of [0, 600, 1200, inner]) frame.push(P(x, y, 0, x, y, D))
    }
    return frame
  }

  it('they open into the room, and none is as deep as the return leg', () => {
    const frame = lShaped()
    load(frame)
    // not the corner bay: a leaf taken all the way to the inside corner post fouls the end
    // of the return leg's rail, which is why a real kitchen puts a pull-out there instead
    for (const [x1, x2] of [[0, 600], [600, 1200]]) {
      const bay = frame.filter((p) => p.length === 880 && p.position[2] === 650
        && (p.position[0] === x1 || p.position[0] === x2))
      expect(bay.length, `bay ${x1}–${x2}`).toBe(2)
      useStore.getState().selectItems(bay.map((p) => p.id))
      // half overlay: two full-overlay leaves cannot share a 20 mm stile, which the check
      // says plainly and which is a fact about the cabinet rather than about the tool
      expect(addFittingFromSelection({ kind: 'door', hinge: 'left', overlay: 'half' })).toBe(true)
    }
    const doors = useStore.getState().fittings
    expect(doors.length).toBe(2)
    for (const d of doors) {
      const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(...d.quaternion))
      expect(facing.z, 'opens into the room').toBeGreaterThan(0.9)
      expect(d.depth, 'as deep as the run, not the return leg').toBeLessThan(750)
    }
    const s = useStore.getState()
    const clashes = findConflicts(s.profiles, computeAllTrims(s.profiles), [], [], s.fittings)
      .filter((c) => s.fittings.some((f) => f.id === c.a || f.id === c.b))
    expect(clashes).toEqual([])
  })
})

/**
 * The two legs of an L face different ways, and a door already hung on one of them says
 * nothing about the other. What a selection has already settled decides how much of that
 * evidence counts: two uprights framing a door are coplanar, and the normal of that plane is
 * the one direction the door can face, so only a door facing the same axis can confirm or
 * reverse it. Without that, doors on the return leg were told to face along the long run —
 * where their two uprights are twenty millimetres apart — and the opening came out too small
 * to hang anything in at all.
 */
describe('the two legs of an L face different ways', () => {
  it('a door on the return leg faces along the return leg', () => {
    const D = 650, H = 880, W = 2400, inner = W - D, L = 1850
    const frame: ProfileData[] = []
    for (const x of [0, 600, 1200, 1800, W]) frame.push(P(x, 0, 0, x, H, 0))
    for (const x of [0, 600, 1200, inner]) frame.push(P(x, 0, D, x, H, D))
    for (const z of [1250, L]) for (const x of [inner, W]) frame.push(P(x, 0, z, x, H, z))
    for (const y of [20, H - 20]) {
      for (const [a, b] of [[0, 600], [600, 1200], [1200, 1800], [1800, W]]) frame.push(P(a, y, 0, b, y, 0))
      for (const [a, b] of [[0, 600], [600, 1200], [1200, inner]]) frame.push(P(a, y, D, b, y, D))
      for (const [a, b] of [[D, 1250], [1250, L]]) {
        frame.push(P(inner, y, a, inner, y, b), P(W, y, a, W, y, b))
      }
      for (const x of [0, 600, 1200, inner]) frame.push(P(x, y, 0, x, y, D))
    }
    load(frame)

    // first a door on the long run, so there is a precedent to be misled by
    const along = frame.filter((p) => p.length === H && p.position[2] === D
      && (p.position[0] === 0 || p.position[0] === 600))
    useStore.getState().selectItems(along.map((p) => p.id))
    expect(addFittingFromSelection({ kind: 'door', hinge: 'left', overlay: 'half' })).toBe(true)

    // then one on the return leg, whose uprights are lined up along Z
    const back = frame.filter((p) => p.length === H && p.position[0] === inner
      && (p.position[2] === D || p.position[2] === 1250))
    expect(back.length).toBe(2)
    useStore.getState().selectItems(back.map((p) => p.id))
    expect(addFittingFromSelection({ kind: 'door', hinge: 'left', overlay: 'half' })).toBe(true)

    const [first, second] = useStore.getState().fittings
    const dir = (f: { quaternion: number[] }) =>
      new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(...(f.quaternion as [number, number, number, number])))
    expect(dir(first).z).toBeGreaterThan(0.9)        // the long run faces the room
    expect(Math.abs(dir(second).x)).toBeGreaterThan(0.9)   // the return leg faces across it
    expect(second.width).toBeGreaterThan(500)        // and it is an opening, not a 20 mm sliver
  })
})
