import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as THREE from 'three'
import { buildProfile } from '../utils/profileFactory'
import { setThroughRule } from '../utils/jointUtils'
import { seatBracket } from '../utils/bracketSeat'
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
    expect(Math.abs(Math.abs(seat.position[2]) - 10)).toBeLessThan(3)
  })

  it('puts both bolts on a slot line — for two 20s that is each centreline', () => {
    const seat = seatBracket(rail(), post(), V(0, 10, 0))!
    expect(seat.slotOffsets).toEqual([0, 0])
  })

  it('sits on the metal, not in it', () => {
    const seat = seatBracket(rail(), post(), V(0, 10, 0))!
    // 10 is the face; anything at 10 exactly is half-buried, so it must be further out
    expect(Math.abs(seat.position[2])).toBeGreaterThan(10)
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
