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
import type { FittingData } from '../store/useStore'

const examples = import.meta.glob(['../../examples/*.json', '../../examples/flat/*.json'], { eager: true }) as Record<string, { default: unknown }>
const cases = [
  { name: '01-kitchen-base', prefix: 'kitchen-drawer-', width: 930, count: 2, centres: [1905], bounds: [3400, 880, 670] },
  { name: '05-media-unit', prefix: 'media-split-drawer-', width: 580, count: 6, centres: [900, 1500], bounds: [2420, 500, 420] },
  { name: 'wardrobe-2-door', prefix: 'wardrobe-drawer-', width: 840, count: 2, centres: [1340], bounds: [1800, 2200, 600] },
]
const load = (name: string) => {
  const source = Object.entries(examples).find(([path]) => path.endsWith(`/${name}.json`))!
  const doc = parseProjectDocument(source[1].default)
  setThroughRule(doc.throughRule)
  return doc
}

afterEach(() => setThroughRule('rails'))

describe.each(cases)('$name drawer bays', ({ name, prefix, width, count, centres, bounds }) => {
  it('has the specified drawer widths, counts and columns within its outer envelope', () => {
    const doc = load(name)
    const drawers = doc.fittings.filter((f) => f.kind === 'drawer')
    expect(drawers).toHaveLength(count)
    expect(drawers.map((f) => f.width)).toEqual(Array(count).fill(width))
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

  it('fastens both ends of every drawer support to a touching frame member', () => {
    const doc = load(name)
    const trims = computeAllTrims(doc.profiles)
    expect(auditBrackets(doc.profiles, doc.connectors, trims, undefined, doc.panels)).toEqual([])
    const supports = doc.profiles.filter((p) => p.id.startsWith(prefix))
    expect(supports.length).toBeGreaterThan(2)
    for (const p of supports) {
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
        const connected = partners.some((q) => doc.connectors.some((c) => c.type === 'inside-corner'
          && auditBrackets([p, q], [c], trims).length === 0))
        expect(connected, `${p.id} at ${tip.toArray()}`).toBe(true)
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

it('keeps the kitchen drawer supports below the cooktop reserve', () => {
  const doc = load('01-kitchen-base')
  const trims = computeAllTrims(doc.profiles)
  const reserve = new THREE.Box3(new THREE.Vector3(1440.1, 700.1, 10.1), new THREE.Vector3(2369.9, 839.9, 639.9))
  expect(doc.profiles.filter((p) => trimmedBox(p, trims.get(p.id)!).intersectsBox(reserve)).map((p) => p.id)).toEqual([])
})

function drawerDoorHits(fittings: FittingData[]): string[] {
  const struck: string[] = []
  for (const drawer of fittings.filter((f) => f.kind === 'drawer')) {
    for (const door of fittings.filter((f) => f.kind === 'door')) {
      const leaf = leafObb(door, door.open)!
      if (fittingSolids(drawer).some((board) => obbPenetration(board, leaf, 1e-5) > 0)) {
        struck.push(`${drawer.id} / ${door.id}`)
      }
    }
  }
  return struck
}

it('clears all wardrobe leaves when both right-bay doors open before the drawers', () => {
  const doc = load('wardrobe-2-door')
  const trims = computeAllTrims(doc.profiles)
  const doors = doc.fittings.filter((f) => f.kind === 'door')
  const drawers = doc.fittings.filter((f) => f.kind === 'drawer')
  expect(doors).toHaveLength(4)
  expect(drawers).toHaveLength(2)
  const rightDoors = doors.filter((f) => f.position[0] > 900)
  expect(rightDoors).toHaveLength(2)
  const doorGroups = [rightDoors.map((f) => f.id), doors.map((f) => f.id)]
  for (const openedDoors of doorGroups) {
    const drawerGroups = [...drawers.map((f) => [f.id]), drawers.map((f) => f.id)]
    for (const openedDrawers of drawerGroups) for (const open of [0, 0.01, 0.1, 0.25, 0.5, 0.75, 1]) {
      const fittings = doc.fittings.map((f) => ({ ...f, open: f.kind === 'door'
        ? Number(openedDoors.includes(f.id)) : openedDrawers.includes(f.id) ? open : 0 }))
      const scenario = `${openedDoors.join(',')} / ${openedDrawers.join(',')} at ${open}`
      expect(findConflicts(doc.profiles, trims, doc.connectors, doc.panels, fittings), scenario).toEqual([])
      // Direct board comparison also checks the shut neighbouring doors.
      expect(drawerDoorHits(fittings), scenario).toEqual([])
    }
  }
})

it('blocks both wide wardrobe drawers if either right-bay door stays shut', () => {
  const doc = load('wardrobe-2-door')
  const trims = computeAllTrims(doc.profiles)
  const rightDoors = doc.fittings.filter((f) => f.kind === 'door' && f.position[0] > 900)
  const drawers = doc.fittings.filter((f) => f.kind === 'drawer')
  expect(rightDoors).toHaveLength(2)
  expect(drawers).toHaveLength(2)
  for (const openedDoor of rightDoors) {
    const shutDoor = rightDoors.find((f) => f.id !== openedDoor.id)!
    for (const drawer of drawers) for (const open of [0.1, 0.25, 0.5, 0.75, 1]) {
      const fittings = doc.fittings.map((f) => ({ ...f, open: f.id === openedDoor.id ? 1 : f.id === drawer.id ? open : 0 }))
      const scenario = `${openedDoor.id} open / ${drawer.id} at ${open}`
      expect(drawerDoorHits(fittings), scenario).toEqual([`${drawer.id} / ${shutDoor.id}`])
      expect(findConflicts(doc.profiles, trims, doc.connectors, doc.panels, fittings)
        .some((c) => (c.a === drawer.id && c.b === shutDoor.id) || (c.a === shutDoor.id && c.b === drawer.id)), scenario).toBe(true)
    }
  }
})
