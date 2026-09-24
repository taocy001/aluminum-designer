import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { buildProfile } from '../utils/profileFactory'
import { migrateFittings } from '../utils/migrate'
import { findConflicts } from '../utils/analysis'
import { computeAllTrims } from '../utils/jointUtils'
import type { FittingData, ProfileData, ProfileSpec } from '../store/useStore'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const P = (sx: number, sy: number, sz: number, ex: number, ey: number, ez: number, spec: ProfileSpec = '2020'): ProfileData =>
  buildProfile(V(sx, sy, sz), V(ex, ey, ez), spec)!

/** a bay whose front uprights are 2020 centred on z = 0 */
const bay = (): ProfileData[] => [
  P(0, 0, 0, 0, 800, 0), P(600, 0, 0, 600, 800, 0),
  P(0, 0, 400, 0, 800, 400), P(600, 0, 400, 600, 800, 400),
  P(0, 20, 0, 600, 20, 0), P(0, 780, 0, 600, 780, 0),
]

/** a door as the old code wrote it: front plane on the uprights' centreline */
const oldDoor = (): FittingData => ({
  id: 'd1', kind: 'door', width: 580, height: 760, depth: 420,
  position: [300, 400, 210], quaternion: [0, 1, 0, 0],
  material: 'mdf', open: 0, overlay: 'full', hinge: 'left',
} as FittingData)

/**
 * A door's leaf lies on the uprights and its box goes behind them, so those are two planes
 * with a frame's thickness between them. Until that thickness was recorded the front plane
 * was put on the centreline, and every leaf sat half a section inside the post it hung on.
 * Files saved then still say so.
 */
describe('bringing an older document up to date', () => {
  it('moves a fitting that has no frame recorded onto the frame it covers', () => {
    const [before] = [oldDoor()]
    const [after] = migrateFittings(bay(), [oldDoor()])
    expect(after.frame).toBeGreaterThan(0)
    expect(after.position).not.toEqual(before.position)
  })

  it('and the leaf then clears the post instead of being inside it', () => {
    const frame = bay()
    const trims = computeAllTrims(frame)
    const wrong = findConflicts(frame, trims, [], [], [oldDoor()])
    expect(wrong.length).toBeGreaterThan(0)
    const right = findConflicts(frame, trims, [], [], migrateFittings(frame, [oldDoor()]))
    expect(right).toEqual([])
  })

  it('a document already carrying the thickness is left exactly alone', () => {
    const current = [{ ...oldDoor(), frame: 20 }]
    expect(migrateFittings(bay(), current)).toBe(current)
  })

  it('an empty document is not a special case', () => {
    expect(migrateFittings([], [])).toEqual([])
  })
})
