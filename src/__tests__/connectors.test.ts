import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as THREE from 'three'
import { buildProfile } from '../utils/profileFactory'
import { fitConnector, membersAt } from '../utils/connectorFit'
import { buildBom, bomToCsv } from '../utils/bom'
import { computeAllTrims, setThroughRule } from '../utils/jointUtils'
import { seriesOf, connectorEntry, boltThread } from '../utils/connectorCatalog'
import type { ConnectorData, ProfileData, ProfileSpec } from '../store/useStore'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
function P(sx: number, sy: number, sz: number, ex: number, ey: number, ez: number, spec: ProfileSpec = '2020'): ProfileData {
  const p = buildProfile(V(sx, sy, sz), V(ex, ey, ez), spec)
  if (!p) throw new Error('bad profile')
  return p
}
const axis = (q: [number, number, number, number], local: [number, number, number]) =>
  new THREE.Vector3(...local).applyQuaternion(new THREE.Quaternion(...q))
    .toArray().map((v) => (Math.round(v * 100) / 100) || 0)

describe('connector series', () => {
  it('follows the profile it is placed on', () => {
    expect(seriesOf('2020')).toBe(20)
    expect(seriesOf('2040')).toBe(20)
    expect(seriesOf('3030')).toBe(30)
    expect(seriesOf('3040')).toBe(30)
    expect(seriesOf('4040')).toBe(40)
    expect(boltThread(20)).toBe('M5')
    expect(boltThread(30)).toBe('M6')
    expect(boltThread(40)).toBe('M8')
  })
})

describe('placement fitting', () => {
  it('finds the members meeting at a point', () => {
    const post = P(0, 0, 0, 0, 800, 0)
    const rail = P(0, 10, 0, 600, 10, 0)
    const contacts = membersAt(V(0, 10, 0), [post, rail])
    expect(contacts.map((c) => c.profile.id).sort()).toEqual([post.id, rail.id].sort())
  })

  it('lays an L-bracket into the corner of the two members it sits on', () => {
    const post = P(0, 0, 0, 0, 800, 0)          // upright, +Y
    const rail = P(0, 10, 0, 600, 10, 0)        // rail, +X
    const fit = fitConnector('bracket', V(0, 10, 0), [post, rail])
    // the bracket's arms are modelled along +X and +Y; they must now run back along the members
    const armA = axis(fit.quaternion, [1, 0, 0])
    const armB = axis(fit.quaternion, [0, 1, 0])
    const dirs = [armA, armB].map((v) => v.map(Math.round).join(','))
    expect(dirs).toContain('0,1,0')             // up the post
    expect(dirs).toContain('1,0,0')             // out along the rail
    expect(fit.series).toBe(20)
    expect(fit.refIds).toHaveLength(2)
  })

  it('points an end cap out along the member it caps', () => {
    const rail = P(0, 10, 0, 600, 10, 0)
    const fit = fitConnector('end-cap', V(600, 10, 0), [rail])
    expect(axis(fit.quaternion, [0, 0, 1])).toEqual([1, 0, 0])   // outward, past the end
    const other = fitConnector('end-cap', V(0, 10, 0), [rail])
    expect(axis(other.quaternion, [0, 0, 1])).toEqual([-1, 0, 0])
  })

  it('lays a face-mounted part flat on the side it was dropped on', () => {
    const rail = P(0, 10, 0, 600, 10, 0)
    const fit = fitConnector('hinge', V(300, 10, 10), [rail])   // dropped on the +Z face
    expect(axis(fit.quaternion, [0, 1, 0])).toEqual([0, 0, 1])  // plate normal points out of that face
  })

  it('takes the series from a 4040 member', () => {
    const post = P(0, 0, 0, 0, 800, 0, '4040')
    expect(fitConnector('bracket', V(0, 0, 0), [post]).series).toBe(40)
  })

  it('places as dropped when there is nothing to align to', () => {
    const fit = fitConnector('bracket', V(500, 0, 500), [])
    expect(fit.quaternion).toEqual([0, 0, 0, 1])
    expect(fit.refIds).toEqual([])
  })
})

beforeEach(() => setThroughRule('posts'))
afterAll(() => setThroughRule('rails'))

describe('bill of materials', () => {
  const frame = () => {
    const post = P(0, 0, 0, 0, 800, 0)
    const rail = P(0, 10, 0, 600, 10, 0)
    return [post, rail]
  }
  const connector = (type: string, series: 20 | 30 | 40 = 20): ConnectorData =>
    ({ id: `c-${type}-${series}`, type, series, position: [0, 10, 0], quaternion: [0, 0, 0, 1] })

  it('groups profiles by spec and cut length', () => {
    const all = [...frame(), P(0, 10, 300, 600, 10, 300)]
    const bom = buildBom(all, [], computeAllTrims(all), 'en')
    const lengths = bom.profiles.map((r) => `${r.spec}:${r.length}x${r.qty}`)
    expect(lengths).toContain('2020:590x1')   // the rail that butts into the post
    expect(lengths).toContain('2020:600x1')   // the one standing clear of it
    expect(bom.totalCutLength).toBeGreaterThan(0)
  })

  it('derives bolts and T-nuts from the connectors actually placed', () => {
    const all = frame()
    const bom = buildBom(all, [connector('bracket'), connector('bracket'), connector('t-bracket')], computeAllTrims(all), 'en')
    const bolts = bom.fasteners.find((r) => r.key === 'bolt-20')!
    const nuts = bom.fasteners.find((r) => r.key === 'nut-20')!
    expect(bolts.qty).toBe(connectorEntry('bracket')!.fasteners.bolts * 2 + connectorEntry('t-bracket')!.fasteners.bolts)
    expect(nuts.qty).toBe(bolts.qty)
    expect(bolts.label).toContain('M5')
  })

  it('keeps series apart and uses the matching thread', () => {
    const all = frame()
    const bom = buildBom(all, [connector('bracket', 20), connector('bracket', 40)], computeAllTrims(all), 'en')
    expect(bom.fasteners.map((r) => r.key).sort()).toEqual(['bolt-20', 'bolt-40', 'nut-20', 'nut-40'])
    expect(bom.fasteners.find((r) => r.key === 'bolt-40')!.label).toContain('M8')
  })

  it('counts only real corner brackets against the bracket suggestion', () => {
    const all = frame()
    const trims = computeAllTrims(all)
    const withGusset = buildBom(all, [connector('gusset')], trims, 'en')
    expect(withGusset.suggested.find((r) => r.key === 'suggest-bracket')!.qty).toBe(1)
    const withBracket = buildBom(all, [connector('bracket')], trims, 'en')
    expect(withBracket.suggested.find((r) => r.key === 'suggest-bracket')).toBeUndefined()
  })

  it('suggests caps per series', () => {
    const post = P(0, 0, 0, 0, 800, 0, '4040')
    const trims = computeAllTrims([post])
    const bom = buildBom([post], [], trims, 'en')
    const cap = bom.suggested.find((r) => r.key === 'suggest-cap-40')!
    expect(cap.qty).toBe(2)
    expect(cap.label).toContain('40')
  })

  it('suggests the brackets and caps the frame implies, minus what is already placed', () => {
    const all = frame()
    const trims = computeAllTrims(all)
    const bare = buildBom(all, [], trims, 'en')
    expect(bare.buttEnds).toBe(1)                     // the rail butts into the post
    expect(bare.freeEnds).toBe(2)             // the post's top and the rail's far end
    expect(bare.suggested.find((r) => r.key === 'suggest-bracket')!.qty).toBe(1)
    expect(bare.suggested.find((r) => r.key === 'suggest-cap-20')!.qty).toBe(2)

    const withParts = buildBom(all, [connector('bracket'), connector('end-cap')], trims, 'en')
    expect(withParts.suggested.find((r) => r.key === 'suggest-bracket')).toBeUndefined()
    expect(withParts.suggested.find((r) => r.key === 'suggest-cap-20')!.qty).toBe(1)
  })

  it('exports a CSV with fixed English headers and every section', () => {
    const all = frame()
    const bom = buildBom(all, [connector('bracket')], computeAllTrims(all), 'zh')
    const csv = bomToCsv(bom, '620x20x810')
    expect(csv.split('\n')[0]).toBe('Category,Item,Spec,Cut length (mm),Quantity')
    expect(csv).toMatch(/^Profile,2020,2020,\d+,\d+$/m)
    expect(csv).toContain('Connector,"L型角码"')
    expect(csv).toMatch(/Fastener,"螺栓 M5×10"/)
    expect(csv).toContain('Summary,Overall WxDxH,620x20x810')
  })
})

describe('degenerate placements still produce a usable orientation', () => {
  const finite = (q: [number, number, number, number]) => q.every((v) => Number.isFinite(v))
  const len = (q: [number, number, number, number]) => Math.hypot(...q)

  it('a face part dropped exactly on a vertical centerline', () => {
    const post = P(0, 0, 0, 0, 800, 0)
    const fit = fitConnector('hinge', V(0, 400, 0), [post])
    expect(finite(fit.quaternion)).toBe(true)
    expect(len(fit.quaternion)).toBeCloseTo(1, 5)
    expect(axis(fit.quaternion, [0, 1, 0]).some((v) => Math.abs(v) > 0.5)).toBe(true)
  })

  it('a face part dropped on a horizontal centerline', () => {
    const rail = P(0, 10, 0, 600, 10, 0)
    const fit = fitConnector('t-nut', V(300, 10, 0), [rail])
    expect(len(fit.quaternion)).toBeCloseTo(1, 5)
    // the plate normal must be across the member, never along it
    const normal = axis(fit.quaternion, [0, 1, 0])
    expect(Math.abs(normal[0])).toBeLessThan(0.01)
  })

  it('a face part dropped just past the end', () => {
    const rail = P(0, 10, 0, 600, 10, 0)
    const fit = fitConnector('hinge', V(605, 10, 0), [rail])
    expect(len(fit.quaternion)).toBeCloseTo(1, 5)
    expect(Math.abs(axis(fit.quaternion, [0, 1, 0])[0])).toBeLessThan(0.01)
  })

  it('a corner part on two collinear members falls back to an upright second arm', () => {
    const a = P(0, 10, 0, 300, 10, 0)
    const b = P(300, 10, 0, 600, 10, 0)
    const fit = fitConnector('bracket', V(300, 10, 0), [a, b])
    expect(len(fit.quaternion)).toBeCloseTo(1, 5)
    const arms = [axis(fit.quaternion, [1, 0, 0]), axis(fit.quaternion, [0, 1, 0])]
    expect(arms.every((v) => Number.isFinite(v[0]))).toBe(true)
  })

  it('the BOM survives missing trims', () => {
    const all = [P(0, 0, 0, 0, 800, 0)]
    const bom = buildBom(all, [], new Map(), 'en')
    expect(bom.profiles[0].length).toBe(800)
    expect(bom.totalCutLength).toBe(800)
    expect(bom.buttEnds).toBe(0)
  })
})

describe('parts land the way they are built, not the way a convention assumes', () => {
  const rail = () => P(0, 10, 0, 600, 10, 0)
  const post = () => P(0, 0, 0, 0, 800, 0)

  it('a levelling foot stands under a post instead of lying on its side', () => {
    // the foot is modelled along Y: pad at the bottom, stem and plate going up
    const fit = fitConnector('foot', V(0, 0, 0), [post()])
    const stem = axis(fit.quaternion, [0, 1, 0])
    expect(stem).toEqual([0, 1, 0])          // still upright, pointing back into the post
  })

  it('a caster mount keeps its wheel below the post', () => {
    const fit = fitConnector('caster-mount', V(0, 0, 0), [post()])
    expect(axis(fit.quaternion, [0, 1, 0])).toEqual([0, 1, 0])
  })

  it('a flat plate bridges along the rail, not across it', () => {
    // the plate is 60 long in X and 18 wide in Z
    const fit = fitConnector('flat-plate', V(600, 10, 0), [rail()])
    expect(axis(fit.quaternion, [1, 0, 0])).toEqual([1, 0, 0])
  })

  it('a joining plate runs along the member on its own Z', () => {
    const fit = fitConnector('joining-plate', V(600, 10, 0), [rail()])
    expect(axis(fit.quaternion, [0, 0, 1])).toEqual([1, 0, 0])
  })

  it('a hinge lies flat on the face it was dropped on', () => {
    // the leaves are offset along X, so X is the mounting normal
    const fit = fitConnector('hinge', V(300, 10, 10), [rail()], new THREE.Vector3(0, 0, 1))
    expect(axis(fit.quaternion, [1, 0, 0])).toEqual([0, 0, 1])   // normal out of the +Z face
    expect(axis(fit.quaternion, [0, 0, 1])).toEqual([1, 0, 0])   // pin along the rail
  })

  it('a cross plate lies flat with its 4 mm thickness across the face', () => {
    const fit = fitConnector('cross-bracket', V(300, 10, -10), [rail()], new THREE.Vector3(0, 0, -1))
    expect(axis(fit.quaternion, [0, 0, 1])).toEqual([0, 0, -1])
  })

  it('a face part follows the side it was dropped on, not a fixed default', () => {
    const top = fitConnector('t-nut', V(300, 20, 0), [rail()], new THREE.Vector3(0, 1, 0))
    const under = fitConnector('t-nut', V(300, 0, 0), [rail()], new THREE.Vector3(0, -1, 0))
    expect(axis(top.quaternion, [0, 1, 0])).toEqual([0, 1, 0])
    expect(axis(under.quaternion, [0, 1, 0])).toEqual([0, -1, 0])
  })

  it('a T-bracket puts its crossbar on the through member', () => {
    const through = P(0, 10, 0, 600, 10, 0)           // continuous rail
    const branch = P(300, 10, 0, 300, 400, 0)         // branch ending on it
    const fit = fitConnector('t-bracket', V(300, 10, 0), [through, branch])
    // crossbar is the 40 mm arm along local X, stem the 20 mm arm along local Y
    expect(axis(fit.quaternion, [1, 0, 0]).map(Math.abs)).toEqual([1, 0, 0])
    expect(axis(fit.quaternion, [0, 1, 0])).toEqual([0, 1, 0])
  })
})

import { connectorSeatAt } from '../utils/bracketSeat'
import { findConflicts } from '../utils/analysis'

/**
 * A levelling foot has one place it can go on a post, and that is under the end. Dropped
 * where the pointer was, sixty-eight of them ended up inside the posts they were meant to
 * hold up, and every one was reported as metal through metal — which is what it was.
 */
describe('a part that stands under a post stands under it', () => {
  const post = buildProfile(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 800, 0), '2020')!

  it('is seated below the foot of the post, not inside it', () => {
    const seat = connectorSeatAt('foot', new THREE.Vector3(0, 0, 0), [post])
    expect(seat.seated).toBe(true)
    expect(seat.position[1]).toBeLessThan(0)
    const clash = findConflicts([post], computeAllTrims([post]), [{
      id: 'f', type: 'foot', series: seat.series, position: seat.position, quaternion: seat.quaternion,
    } as never])
    expect(clash).toEqual([])
  })

  it('goes to the nearer end when it is dropped a little off', () => {
    const near = connectorSeatAt('foot', new THREE.Vector3(6, 14, 4), [post])
    expect(near.position[1]).toBeLessThan(0)
    const top = connectorSeatAt('foot', new THREE.Vector3(0, 790, 0), [post])
    expect(top.position[1]).toBeGreaterThan(800)
  })

  it('a plate that bridges two members is still left where it was put', () => {
    const rail = buildProfile(new THREE.Vector3(0, 800, 0), new THREE.Vector3(600, 800, 0), '2020')!
    const at = new THREE.Vector3(0, 800, 0)
    const seat = connectorSeatAt('joining-plate', at, [post, rail])
    expect(seat.position[1]).toBeCloseTo(800, 1)
  })
})

/**
 * Several members meet at the foot of a cabinet and only one of them is standing on it.
 * Taking the nearest end put a quarter of the feet on the end of a bottom rail, inside the
 * metal — the foot goes under whichever member's end faces the floor.
 */
describe('a foot picks the member that is standing on it', () => {
  it('goes under the post, not on the end of the rail beside it', () => {
    const post = buildProfile(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 800, 0), '2020')!
    const rail = buildProfile(new THREE.Vector3(0, 20, 0), new THREE.Vector3(600, 20, 0), '2020')!
    const cross = buildProfile(new THREE.Vector3(0, 20, 0), new THREE.Vector3(0, 20, 400), '2020')!
    const seat = connectorSeatAt('foot', new THREE.Vector3(0, 0, 0), [post, rail, cross])
    expect(seat.position[1]).toBeLessThan(0)
    expect(findConflicts([post, rail, cross], computeAllTrims([post, rail, cross]), [{
      id: 'f', type: 'foot', series: seat.series, position: seat.position, quaternion: seat.quaternion,
    } as never]).filter((c) => c.a === 'f' || c.b === 'f')).toEqual([])
  })

  it('a heavier post takes a bigger foot, seated further down', () => {
    const post = buildProfile(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 800, 0), '4040')!
    const seat = connectorSeatAt('foot', new THREE.Vector3(0, 0, 0), [post])
    expect(seat.series).toBe(40)
    expect(seat.position[1]).toBeLessThan(-15)
  })
})
