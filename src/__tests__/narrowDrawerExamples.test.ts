import { afterEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { parseProjectDocument } from '../utils/document'
import { computeAllTrims, computeFrameBounds, getProfileDir, setThroughRule, trimmedBox } from '../utils/jointUtils'
import { auditBrackets } from '../utils/bracketSeat'
import { findConflicts } from '../utils/analysis'
import { runnerFaults } from '../utils/runnerMount'
import { specDims } from '../utils/specUtils'
import { fittingSolids, leafObb } from '../utils/fittingGeometry'
import { obbPenetration } from '../utils/obb'

const examples = import.meta.glob(['../../examples/*.json', '../../examples/flat/*.json'], { eager: true }) as Record<string, { default: unknown }>
const cases = [
  { name: '01-kitchen-base', prefix: 'kitchen', width: 455, count: 4, centres: [1667.5, 2142.5], bounds: [3400, 880, 670] },
  { name: '05-media-unit', prefix: 'media', width: 580, count: 6, centres: [900, 1500], bounds: [2420, 500, 420] },
  { name: 'wardrobe-2-door', prefix: 'wardrobe', width: 400, count: 4, centres: [1120, 1560], bounds: [1800, 2200, 600] },
]
const load = (name: string) => {
  const source = Object.entries(examples).find(([path]) => path.endsWith(`/${name}.json`))!
  const doc = parseProjectDocument(source[1].default)
  setThroughRule(doc.throughRule)
  return doc
}

afterEach(() => setThroughRule('rails'))

describe.each(cases)('$name narrow drawer bays', ({ name, prefix, width, count, centres, bounds }) => {
  it('keeps its outer envelope and divides the wide stack into two narrower stacks', () => {
    const doc = load(name)
    const drawers = doc.fittings.filter((f) => f.kind === 'drawer')
    expect(drawers).toHaveLength(count)
    expect(drawers.every((f) => f.width === width && f.width <= 600)).toBe(true)
    expect([...new Set(drawers.map((f) => f.position[0]))].sort((a, b) => a - b)).toEqual(centres)
    const size = computeFrameBounds(doc.profiles, computeAllTrims(doc.profiles))!.getSize(new THREE.Vector3())
    size.toArray().forEach((v, i) => expect(v).toBeCloseTo(bounds[i], 6))
  })

  it('provides a continuous real mounting rail on both sides of every drawer', () => {
    const doc = load(name)
    const trims = computeAllTrims(doc.profiles)
    expect(runnerFaults(doc.profiles, trims, doc.fittings, doc.panels)).toEqual([])
    // A pair of corner posts alone passes runnerFaults. These examples deliberately also
    // provide continuous, cut-list-visible rails at each drawer's installation height.
    const rails = doc.profiles.filter((p) => Math.abs(getProfileDir(p).z) > 0.999)
      .map((p) => trimmedBox(p, trims.get(p.id)!))
    for (const f of doc.fittings.filter((f) => f.kind === 'drawer')) {
      const [x, y, z] = f.position
      for (const side of [-1, 1]) {
        const edge = x + side * f.width / 2
        expect(rails.some((b) => Math.abs((side < 0 ? b.max.x : b.min.x) - edge) < 1e-6
          && b.min.y <= y - 5 && b.max.y >= y + 5
          && b.min.z <= z - f.depth / 2 + 1e-6 && b.max.z >= z + f.depth / 2 - 1e-6), `${f.id} side ${side}`).toBe(true)
      }
    }
  })

  it('bolts both ends of every added support to actual metal after trimming', () => {
    const doc = load(name)
    const trims = computeAllTrims(doc.profiles)
    expect(auditBrackets(doc.profiles, doc.connectors, trims)).toEqual([])
    const added = doc.profiles.filter((p) => p.id.startsWith(`${prefix}-split-drawer-`))
    expect(added.length).toBeGreaterThan(2)
    for (const p of added) {
      const tr = trims.get(p.id)!
      expect(tr.cutLength).toBeGreaterThan(0)
      const dir = getProfileDir(p)
      const body = trimmedBox(p, tr).expandByScalar(1e-5)
      const { hw, hh } = specDims(p.spec)
      for (const offset of [tr.start.trim, p.length - tr.end.trim]) {
        const tip = new THREE.Vector3(...p.position).addScaledVector(dir, offset)
        // A header rests on a post's end; its centreline is above that contact face.
        // Require actual body contact near the end, rather than centreline containment.
        const partners = doc.profiles.filter((q) => {
          if (q.id === p.id || Math.abs(dir.dot(getProfileDir(q))) >= 0.01) return false
          const other = trimmedBox(q, trims.get(q.id)!)
          return body.intersectsBox(other) && other.distanceToPoint(tip) <= Math.hypot(hw, hh) + 1e-5
        })
        expect(partners.length, `${p.id} at ${tip.toArray()}`).toBeGreaterThan(0)
        expect(partners.some((q) => doc.connectors.some((c) => c.type === 'inside-corner'
          && auditBrackets([p, q], [c], trims).length === 0)), `${p.id} at ${tip.toArray()}`).toBe(true)
      }
    }
  })

  it('clears the frame and adjacent fronts throughout sampled drawer travel', () => {
    const doc = load(name)
    const trims = computeAllTrims(doc.profiles)
    expect(findConflicts(doc.profiles, trims, doc.connectors, doc.panels, doc.fittings)).toEqual([])
    for (const open of [0.25, 0.5, 0.75, 1]) {
      for (const drawer of doc.fittings.filter((f) => f.kind === 'drawer')) {
        // Open any enclosing wardrobe doors before using its internal drawers.
        const fittings = doc.fittings.map((f) => ({ ...f, open: f.kind === 'door' ? 1 : f.id === drawer.id ? open : 0 }))
        expect(findConflicts(doc.profiles, trims, doc.connectors, doc.panels, fittings), `${drawer.id} at ${open}`).toEqual([])
      }
      const together = doc.fittings.map((f) => ({ ...f, open: f.kind === 'door' ? 1 : open }))
      expect(findConflicts(doc.profiles, trims, doc.connectors, doc.panels, together)).toEqual([])
    }
  })
})

it('keeps the new kitchen drawer supports below the cooktop reserve', () => {
  const doc = load('01-kitchen-base')
  const trims = computeAllTrims(doc.profiles)
  const reserve = new THREE.Box3(new THREE.Vector3(1440.1, 700.1, 10.1), new THREE.Vector3(2369.9, 839.9, 639.9))
  expect(doc.profiles.filter((p) => trimmedBox(p, trims.get(p.id)!).intersectsBox(reserve)).map((p) => p.id)).toEqual([])
})

it('opens the wardrobe outer leaf before its corresponding inner drawers, without a closed-door collision exception', () => {
  const doc = load('wardrobe-2-door')
  const trims = computeAllTrims(doc.profiles)
  const doors = doc.fittings.filter((f) => f.kind === 'door')
  const drawers = doc.fittings.filter((f) => f.kind === 'drawer')
  expect(doors).toHaveLength(4)
  expect(drawers).toHaveLength(4)
  const enclosing = new Map(drawers.map((drawer) => {
    const covers = doors.filter((door) => {
      const leaf = leafObb(door, 0)!
      const offset = new THREE.Vector3(...drawer.position).sub(leaf.center)
      return offset.dot(leaf.axes[2]) < 0 && Math.abs(offset.dot(leaf.axes[0])) < leaf.half.x
        && Math.abs(offset.dot(leaf.axes[1])) < leaf.half.y
    })
    expect(covers, drawer.id).toHaveLength(1)
    return [drawer.id, covers[0].id]
  }))
  const relevant = [...new Set(enclosing.values())]
  expect(relevant).toHaveLength(2)
  const doorGroups = [...relevant.map((id) => [id]), relevant, doors.map((f) => f.id)]
  for (const openedDoors of doorGroups) {
    const accessible = drawers.filter((f) => openedDoors.includes(enclosing.get(f.id)!))
    const drawerGroups = [...accessible.map((f) => [f.id]), accessible.map((f) => f.id)]
    for (const openedDrawers of drawerGroups) for (const open of [0.25, 0.5, 0.75, 1]) {
      const fittings = doc.fittings.map((f) => ({ ...f, open: f.kind === 'door'
        ? Number(openedDoors.includes(f.id)) : openedDrawers.includes(f.id) ? open : 0 }))
      const scenario = `${openedDoors.join(',')} / ${openedDrawers.join(',')} at ${open}`
      expect(findConflicts(doc.profiles, trims, doc.connectors, doc.panels, fittings), scenario).toEqual([])
      // This direct solid comparison cannot invoke findConflicts' behindShutDoor exception.
      // Include unopened neighbouring leaves as well as the opened enclosing leaves.
      const struck: string[] = []
      for (const drawer of fittings.filter((f) => f.kind === 'drawer')) {
        for (const door of fittings.filter((f) => f.kind === 'door')) {
          const leaf = leafObb(door, door.open)!
          if (fittingSolids(drawer).some((board) => obbPenetration(board, leaf, 1) > 0)) {
            struck.push(`${drawer.id} / ${door.id}`)
          }
        }
      }
      expect(struck, scenario).toEqual([])
    }
  }
})
