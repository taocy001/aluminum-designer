import { describe, it, expect, beforeEach, afterAll } from 'vitest'
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
