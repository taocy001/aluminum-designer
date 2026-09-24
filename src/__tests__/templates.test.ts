import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as THREE from 'three'
import type { ProfileData } from '../store/useStore'
import { TEMPLATES, templateById } from '../utils/templates'
import { setThroughRule, computeAllTrims } from '../utils/jointUtils'
import { findConflicts } from '../utils/analysis'
import { countUnflush } from '../utils/faceAlign'

beforeEach(() => setThroughRule('rails'))
afterAll(() => setThroughRule('rails'))

const defaults = (id: string) => {
  const t = templateById(id)!
  const v: Record<string, number> = {}
  for (const p of t.params) v[p.key] = p.value
  return { t, v }
}

/**
 * A template is the first thing anybody sees, so it cannot ship a frame that cannot be built.
 * Every one is held to what the tool itself would complain about in a drawing.
 */
describe('every starter frame is buildable', () => {
  for (const tpl of TEMPLATES) {
    it(`${tpl.id}: nothing runs through anything else`, () => {
      const { t, v } = defaults(tpl.id)
      const built = t.build(v)
      expect(built.length).toBeGreaterThan(3)
      expect(findConflicts(built, computeAllTrims(built))).toEqual([])
    })

    it(`${tpl.id}: every joint can take a bracket`, () => {
      const { t, v } = defaults(tpl.id)
      expect(countUnflush(t.build(v))).toBe(0)
    })

    it(`${tpl.id}: it stands on the floor, not through it`, () => {
      const { t, v } = defaults(tpl.id)
      for (const p of t.build(v)) expect(p.position[1]).toBeGreaterThanOrEqual(-1)
    })

    it(`${tpl.id}: the numbers it offers all do something`, () => {
      const { t, v } = defaults(tpl.id)
      const base = t.build(v).length
      for (const prm of t.params) {
        const more = t.build({ ...v, [prm.key]: Math.min(prm.max, prm.value + prm.step * 4) })
        const same = JSON.stringify(t.build(v).map((p) => [p.spec, Math.round(p.length), p.position.map(Math.round)]))
        const changed = JSON.stringify(more.map((p) => [p.spec, Math.round(p.length), p.position.map(Math.round)]))
        expect(changed).not.toBe(same)
      }
      expect(base).toBeGreaterThan(0)
    })
  }

  it('a taller shelving unit has more members', () => {
    const { t, v } = defaults('shelving')
    expect(t.build({ ...v, shelves: 6 }).length).toBeGreaterThan(t.build({ ...v, shelves: 3 }).length)
  })

  it('a rack is as tall as the units asked for', () => {
    const { t, v } = defaults('rack')
    const tall = (u: number) => Math.max(...t.build({ ...v, u }).map((p) => p.position[1] + p.length))
    expect(tall(24) - tall(12)).toBeCloseTo(12 * 44.45, 0)
  })

  it('every member has a real length and a real place', () => {
    for (const tpl of TEMPLATES) {
      const { t, v } = defaults(tpl.id)
      for (const p of t.build(v)) {
        expect(p.length).toBeGreaterThan(9)
        expect(p.position.every((n) => isFinite(n))).toBe(true)
        expect(p.quaternion.every((n) => isFinite(n))).toBe(true)
      }
    }
  })
})

/**
 * How a carcase meets the floor and the ceiling.
 *
 * It used to be posts running the full height with both rings of rails let in between them.
 * That leaves the top missing a piece at each of the four corners, so a top board will not
 * sit flat without four notches cut out of it; it hangs the top rails off the posts by their
 * bolts instead of sending the load down the posts; and it hangs the bottom frame too, when
 * the simplest thing available is to stand it on the floor.
 */
describe('a carcase stands on the floor and wears its top', () => {
  const withBox = TEMPLATES.filter((t) => ['cabinet', 'rack'].includes(t.id))

  it.each(withBox.map((t) => [t.id, t] as const))('%s', (_id, t) => {
    const params = Object.fromEntries(t.params.map((p) => [p.key, p.value]))
    const frame = t.build(params)
    const dir = (p: ProfileData) => new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(...p.quaternion))
    const up = frame.filter((p) => Math.abs(dir(p).y) > 0.9)
    const flat = frame.filter((p) => Math.abs(dir(p).y) <= 0.9)
    expect(up.length).toBeGreaterThanOrEqual(4)

    // the posts start on the floor
    for (const p of up) expect(p.position[1]).toBeCloseTo(0, 1)
    const postTop = Math.max(...up.map((p) => p.position[1] + p.length))

    // the bottom rails stand on the floor beside them: their underside is the floor
    const low = flat.filter((p) => p.position[1] < postTop / 2)
    expect(low.length).toBeGreaterThanOrEqual(4)
    // its underside is the floor, whatever section it happens to be
    const across = (p: ProfileData) => {
      const a = Number(p.spec.slice(0, 2)), b = Number(p.spec.slice(2)) || a
      const ly = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(...p.quaternion))
      return Math.abs(ly.y) > 0.5 ? b : a
    }
    for (const p of low) expect(p.position[1] - across(p) / 2, 'bottom rail sits on the floor').toBeCloseTo(0, 0)

    // the top frame is above the posts, not inside them, and lying flat
    const top = flat.filter((p) => p.position[1] > postTop / 2)
    expect(top.length).toBeGreaterThanOrEqual(4)
    for (const p of top) {
      const ly = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(...p.quaternion))
      expect(Math.abs(ly.y), 'lying flat, not on edge').toBeLessThan(0.5)
      expect(p.position[1], 'over the top of the posts').toBeGreaterThanOrEqual(postTop)
    }

    // and it is still buildable
    expect(countUnflush(frame)).toBe(0)
  })
})
