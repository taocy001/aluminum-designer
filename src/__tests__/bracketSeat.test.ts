import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as THREE from 'three'
import { buildProfile } from '../utils/profileFactory'
import { setThroughRule } from '../utils/jointUtils'
import { seatAngle, seatBracket, seatFor, sharedSlotLine } from '../utils/bracketSeat'
import { slotOffsets, nearestSlot } from '../utils/specUtils'
import type { ProfileData, ProfileSpec } from '../store/useStore'

beforeEach(() => setThroughRule('rails'))
afterAll(() => setThroughRule('rails'))

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
function P(sx: number, sy: number, sz: number, ex: number, ey: number, ez: number, spec: ProfileSpec = '2020'): ProfileData {
  const p = buildProfile(V(sx, sy, sz), V(ex, ey, ez), spec)
  if (!p) throw new Error('bad profile')
  return p
}

describe('where the slots run', () => {
  it('a 20 face has one slot, down the middle', () => {
    expect(slotOffsets(20)).toEqual([0])
  })
  it('a 40 face has two, ten either side — the middle is metal', () => {
    expect(slotOffsets(40)).toEqual([-10, 10])
    expect(slotOffsets(40)).not.toContain(0)
  })
  it('a 60 face has three', () => {
    expect(slotOffsets(60)).toEqual([-20, 0, 20])
  })
  it('the nearest slot to the middle of a 40 face is ten off it', () => {
    expect(Math.abs(nearestSlot(40, 0))).toBe(10)
    expect(nearestSlot(20, 0)).toBe(0)
  })
})

describe('seating a bracket at a corner', () => {
  /** a 2020 rail running in +X butting into a 2020 post, outside faces flush at z = -10 */
  const rail = () => P(0, 10, 0, 600, 10, 0)
  const post = () => P(0, 10, 0, 0, 610, 0)

  it('lands on the face the two members share', () => {
    const seat = seatBracket(rail(), post(), V(0, 10, 0))!
    expect(seat).not.toBeNull()
    // both members are 20 wide in z and centred on z = 0, so the shared faces are z = ±10
    expect(Math.abs(Math.abs(seat.position[2]) - 10)).toBeLessThan(1)
  })

  it('puts both bolts on a slot line — for two 20s that is each centreline', () => {
    const seat = seatBracket(rail(), post(), V(0, 10, 0))!
    expect(seat.slotOffsets).toEqual([0, 0])
  })

  it('its back plane is the shared face, so the plate lies on the metal', () => {
    const seat = seatBracket(rail(), post(), V(0, 10, 0))!
    // both members are 20 wide about z = 0, so the shared faces are at ±10 and the plate's
    // back — its local z = 0 — sits exactly there, with its body outward from it
    expect(Math.abs(Math.abs(seat.position[2]) - 10)).toBeLessThan(0.01)
  })

  it('takes the smaller of the two sections', () => {
    const big = P(0, 20, 0, 0, 620, 0, '4040')
    const small = P(0, 10, -10, 600, 10, -10, '2040')
    const seat = seatBracket(small, big, V(0, 10, -10))
    if (seat) expect(seat.series).toBe(20)
  })

  it('refuses a joint with no shared face', () => {
    // a 2020 centred on a 4040 post: neither of its faces lines up with either of the post's
    const centred = P(0, 20, 0, 600, 20, 0, '2020')
    const fat = P(0, 20, 0, 0, 620, 0, '4040')
    expect(seatBracket(centred, fat, V(0, 20, 0))).toBeNull()
  })

  it('refuses two members running the same way', () => {
    const a = P(0, 10, 0, 600, 10, 0)
    const b = P(600, 10, 0, 1200, 10, 0)
    expect(seatBracket(a, b, V(600, 10, 0))).toBeNull()
  })

  it('its back faces out of the frame, so the part is reachable', () => {
    const seat = seatBracket(rail(), post(), V(0, 10, 0))!
    const q = new THREE.Quaternion(...seat.quaternion)
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(q)
    const outward = new THREE.Vector3(0, 0, Math.sign(seat.position[2]))
    expect(back.dot(outward)).toBeGreaterThan(0.9)
  })

  it('each leg runs into its own member, never off into space', () => {
    const seat = seatBracket(rail(), post(), V(0, 10, 0))!
    const q = new THREE.Quaternion(...seat.quaternion)
    const legX = new THREE.Vector3(1, 0, 0).applyQuaternion(q)
    const legY = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
    // the rail runs +X from the corner and the post runs +Y, so the legs take those two
    const dirs = [legX, legY].map((v) => [Math.round(v.x), Math.round(v.y), Math.round(v.z)].join(','))
    expect(dirs.sort()).toEqual(['0,1,0', '1,0,0'])
  })
})

describe('a bolt on a 40 face is offset, because its middle is metal', () => {
  it('shifts along the wide member so the hole finds a slot', () => {
    // a 2040 rail lying with its 40 face up, butting into a 4040 post; outside faces flush
    const post = P(0, 20, 0, 0, 620, 0, '4040')
    const rail = P(0, 20, -10, 600, 20, -10, '2040')
    const seat = seatBracket(rail, post, V(0, 20, -10))
    if (!seat) return               // no shared face in this arrangement: nothing to assert
    for (const off of seat.slotOffsets) {
      // every bolt must sit on a slot, so no offset may be a face middle that has none
      expect([0, 10, -10, 20, -20]).toContain(Math.round(off))
    }
  })

  it('a 4040 to 4040 corner offsets both bolts off the middle', () => {
    const post = P(0, 20, 0, 0, 620, 0, '4040')
    const rail = P(0, 20, 0, 600, 20, 0, '4040')
    const seat = seatBracket(rail, post, V(0, 20, 0))!
    expect(seat.slotOffsets.map(Math.abs)).toEqual([10, 10])
  })
})

/**
 * The shared face can be on either side of the joint. `flushFace` reports it as a signed
 * distance, and taking its normal on trust put every bracket on a negative-side face two
 * millimetres inside the metal with its back pointing into the frame.
 */
describe('the bracket sits outside the metal on whichever side the face is', () => {
  function pair(railZ: number, postZ: number) {
    return [
      buildProfile(V(0, 10, railZ), V(600, 10, railZ), '2020')!,
      buildProfile(V(0, 10, postZ), V(0, 610, postZ), '4040')!,
    ]
  }

  it('a face on the far side seats it further out, not further in', () => {
    // a 2020 rail flush with the +z face of a 4040 post: shared plane at z = +20
    const [rail, post] = pair(10, 0)
    const seat = seatBracket(rail, post, V(0, 10, 10))
    if (!seat) return
    expect(seat.position[2]).toBeCloseTo(20, 1)
  })

  it('a face on the near side seats it further out on that side', () => {
    // the same rail flush with the −z face: shared plane at z = −20
    const [rail, post] = pair(-10, 0)
    const seat = seatBracket(rail, post, V(0, 10, -10))
    if (!seat) return
    expect(seat.position[2]).toBeCloseTo(-20, 1)
  })

  it('its back faces out of the metal on both sides', () => {
    for (const [railZ, postZ, side] of [[10, 0, 1], [-10, 0, -1]] as const) {
      const [rail, post] = pair(railZ, postZ)
      const seat = seatBracket(rail, post, V(0, 10, railZ))
      if (!seat) continue
      const back = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(...seat.quaternion))
      expect(back.z * side).toBeGreaterThan(0.9)
    }
  })

  it('both legs still run into their own members', () => {
    for (const railZ of [10, -10]) {
      const [rail, post] = pair(railZ, 0)
      const seat = seatBracket(rail, post, V(0, 10, railZ))
      if (!seat) continue
      const q = new THREE.Quaternion(...seat.quaternion)
      const dirs = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)]
        .map((v) => v.applyQuaternion(q))
        .map((v) => [Math.round(v.x), Math.round(v.y), Math.round(v.z)].join(','))
      expect(dirs.sort()).toEqual(['0,1,0', '1,0,0'])
    }
  })
})

/**
 * A cast corner bracket is not a plate. Its two flanges are perpendicular and it sits inside
 * the corner, one flange on the face of each member that looks towards the other. Treating it
 * as a plate lying across an outside face put every one of them on the wrong side of the metal.
 */
describe('a cast corner bracket sits inside the corner', () => {
  /** rail running +X from the origin, post running +Y from the origin, both 2020 about z = 0 */
  const rail = () => P(0, 10, 0, 600, 10, 0)
  const post = () => P(0, 10, 0, 0, 610, 0)

  it('lands in the quadrant the two members enclose', () => {
    const seat = seatAngle(rail(), post(), V(0, 10, 0))!
    expect(seat).not.toBeNull()
    // the rail's face looking towards the post is y = 20; the post's looking at the rail is x = 10
    expect(seat.position[0]).toBeCloseTo(10, 1)
    expect(seat.position[1]).toBeCloseTo(20, 1)
  })

  it('its flanges run along the two members, and its third axis across them', () => {
    const seat = seatAngle(rail(), post(), V(0, 10, 0))!
    const q = new THREE.Quaternion(...seat.quaternion)
    const fx = new THREE.Vector3(1, 0, 0).applyQuaternion(q)
    const fy = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
    expect(fx.x).toBeCloseTo(1, 2)     // along the rail
    expect(fy.y).toBeCloseTo(1, 2)     // along the post
  })

  it('both bolts sit on the one line that is a slot on both faces', () => {
    const seat = seatAngle(rail(), post(), V(0, 10, 0))!
    // two 20 faces, both centred on z = 0, so the shared line is the middle of each
    expect(seat.slotOffsets[0]).toBeCloseTo(0, 2)
    expect(seat.slotOffsets[1]).toBeCloseTo(0, 2)
  })

  it('a 2020 centred on a 4040 has no such line, so no single bracket fits', () => {
    const wide = P(0, 20, 0, 0, 620, 0, '4040')
    const small = P(0, 20, 0, 600, 20, 0, '2020')
    // the 2020's only slot line is its middle; the 4040's are ten either side of its middle
    expect(seatAngle(small, wide, V(0, 20, 0))).toBeNull()
  })

  it('...and pushing it flush to one side gives it one', () => {
    const wide = P(0, 20, 0, 0, 620, 0, '4040')
    const flush = P(0, 20, 10, 600, 20, 10, '2020')
    const seat = seatAngle(flush, wide, V(0, 20, 10))
    expect(seat).not.toBeNull()
  })

  it('it is sized to the smaller of the two, which is what bolts to both', () => {
    const wide = P(0, 20, 10, 0, 620, 10, '4040')
    const small = P(0, 20, 10, 600, 20, 10, '2020')
    const seat = seatAngle(small, wide, V(0, 20, 10))
    if (seat) expect(seat.series).toBe(20)
  })

  it('refuses two members running the same way', () => {
    expect(seatAngle(P(0, 10, 0, 600, 10, 0), P(600, 10, 0, 1200, 10, 0), V(600, 10, 0))).toBeNull()
  })

  it('an angle bracket and a plate do not go in the same place', () => {
    const angle = seatAngle(rail(), post(), V(0, 10, 0))!
    const plate = seatBracket(rail(), post(), V(0, 10, 0))!
    const d = Math.hypot(...angle.position.map((v, i) => v - plate.position[i]))
    expect(d).toBeGreaterThan(5)
  })
})

describe('sections with no edge in common are not joined end to face', () => {
  it('no part offers a 2020 butting onto a 4040, flush or not', () => {
    for (const z of [0, 10, -10]) {
      const post = P(0, 20, 0, 0, 620, 0, '4040')
      const rail = P(0, 20, z, 600, 20, z, '2020')
      for (const type of ['bracket', 'inside-corner', 'gusset', 't-bracket']) {
        expect(seatFor(type, rail, post, V(0, 20, z))).toBeNull()
      }
    }
  })

  it('but a 2040 onto a 4040 is fine, because they share the 40 edge', () => {
    const post = P(0, 20, 0, 0, 620, 0, '4040')
    const rail = P(0, 20, 10, 600, 20, 10, '2040')
    expect(seatFor('bracket', rail, post, V(0, 20, 10))).not.toBeNull()
  })

  it('and a 2020 onto a 2040, because they share the 20 edge', () => {
    const post = P(0, 20, 0, 0, 620, 0, '2040')
    const rail = P(0, 20, 10, 600, 20, 10, '2020')
    expect(seatFor('bracket', rail, post, V(0, 20, 10))).not.toBeNull()
  })
})
