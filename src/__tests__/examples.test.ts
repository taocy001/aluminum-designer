import { unfastenedPanels } from '../utils/panelFastening'
import { describe, it, expect } from 'vitest'
import { findConflicts } from '../utils/analysis'
import * as THREE from 'three'
import { computeAllTrims, computeFrameBounds, trimmedBox } from '../utils/jointUtils'
import { getProfileEndpoints } from '../utils/geometryCore'
import { jointPartnersAt } from '../utils/connectorFit'
import { unflushPairs } from '../utils/faceAlign'
import { auditBrackets } from '../utils/bracketSeat'
import { migrateFittings } from '../utils/migrate'
import { parseProjectDocument } from '../utils/document'
import { panelMountFrame, panelMountSupports } from '../utils/panelMounts'
import { runnerFaults } from '../utils/runnerMount'
import { leafObb } from '../utils/fittingGeometry'
import { obbCorners } from '../utils/obb'
import type { ConnectorData, FittingData, PanelData, ProfileData } from '../store/useStore'

interface Doc {
  profiles: ProfileData[]
  connectors?: ConnectorData[]
  panels?: PanelData[]
  fittings?: FittingData[]
}

/** Load bundled example files. The connector catalogue display is excluded from frame checks. */
const SHOWCASE = 'connector-demo'
const loaded = import.meta.glob(['../../examples/*.json', '../../examples/flat/*.json'], { eager: true }) as Record<string, { default: Doc }>
const docs = new Map<string, Doc>()
for (const [path, mod] of Object.entries(loaded)) {
  const name = path.split('/').pop()!
  if (name.startsWith(SHOWCASE)) continue
  docs.set(name, mod.default)
}
const files = [...docs.keys()].sort()

function load(name: string): Required<Doc> {
  const doc = docs.get(name)!
  const profiles = doc.profiles ?? []
  return {
    profiles,
    connectors: doc.connectors ?? [],
    panels: doc.panels ?? [],
    // read the way the app reads them, so an older file is judged as it would be seen
    fittings: migrateFittings(profiles, doc.fittings ?? []),
  }
}

function doorsInFront(drawer: FittingData, fittings: FittingData[]): Set<string> {
  if (drawer.kind !== 'drawer' || drawer.overlay !== 'inset') return new Set()
  const front = leafObb(drawer, 0)!
  return new Set(fittings.filter((f) => {
    if (f.kind !== 'door') return false
    const leaf = leafObb(f, 0)!
    if (front.axes[2].dot(leaf.axes[2]) < 0.999 || front.center.clone().sub(leaf.center).dot(leaf.axes[2]) >= 0) return false
    const corners = obbCorners(front).map((p) => p.sub(leaf.center))
    return [0, 1].every((axis) => {
      const projected = corners.map((p) => p.dot(leaf.axes[axis]))
      const half = axis === 0 ? leaf.half.x : leaf.half.y
      return Math.min(...projected) < half - 1e-5 && Math.max(...projected) > -half + 1e-5
    })
  }).map((f) => f.id))
}

/** Each edge needs two valid mounts spread across at least half its length. */
function allEdgesFastened(panel: PanelData, profiles: ProfileData[], connectors: ConnectorData[]): boolean {
  const rotation = new THREE.Quaternion(...panel.quaternion).normalize().invert()
  const holes = connectors.filter(c => c.panelMount?.panelId === panel.id && panelMountSupports(c, profiles, [panel]))
    .map(c => panelMountFrame(c).boardHole.sub(new THREE.Vector3(...panel.position)).applyQuaternion(rotation))
  const half = [panel.width / 2, panel.height / 2]
  return [0, 1].every(axis => [-1, 1].every(sign => {
    const along = holes.filter(h => Math.abs(h.getComponent(axis) - sign * half[axis]) <= 25)
      .map(h => h.getComponent(1 - axis))
    return along.length >= 2 && Math.max(...along) - Math.min(...along) >= half[1 - axis] - .01
  }))
}

/** Check bundled examples for the geometric conditions asserted below. */
describe('bundled example geometry', () => {
  it('loads the expected example files', () => {
    expect(files).toHaveLength(18)
  })

  it.each([
    ['desk-with-pedestal.json', [1500, 720, 600]],
    ['wardrobe-2-door.json', [1800, 2200, 600]],
    ['03-tall-unit.json', [1610, 2300, 690]],
    ['06-wardrobe.json', [2040, 2400, 640]],
    ['10-wardrobe-small.json', [1240, 2200, 640]],
  ] as const)('keeps %s dimensions with six compatible B6 posts', (name, dimensions) => {
    const { profiles, connectors } = load(name)
    expect(profiles.filter((p) => p.spec === '4040-B6')).toHaveLength(6)
    expect(profiles.some((p) => p.spec === '4040')).toBe(false)
    const size = computeFrameBounds(profiles, computeAllTrims(profiles))!.getSize(new THREE.Vector3())
    expect(size.toArray().map((v) => Math.round(v * 1000) / 1000)).toEqual(dimensions)
    for (const foot of connectors.filter((c) => c.type === 'foot')) {
      expect(foot).toMatchObject({ series: 20, profileSpec: '4040-B6' })
    }
  })

  it('equips the 3030 tool cart with four wheels while retaining its shelves and top height', () => {
    const { profiles, connectors, panels } = load('rolling-cart.json')
    expect(profiles.every((p) => p.spec === '3030')).toBe(true)
    const wheels = connectors.filter((c) => c.type === 'caster-mount')
    expect(wheels).toHaveLength(4)
    expect(wheels.every((c) => c.series === 30 && c.profileSpec === '3030' && c.position[1] === 99.7)).toBe(true)
    expect(panels.map((p) => [p.width, p.height, p.thickness, p.position[1]])).toEqual([
      [460, 760, 18, 295], [460, 760, 18, 595],
    ])
    const bounds = computeFrameBounds(profiles, computeAllTrims(profiles))!
    expect(bounds.max.y).toBeCloseTo(900)
    expect(bounds.max.x - bounds.min.x).toBeCloseTo(820)
    expect(bounds.max.z - bounds.min.z).toBeCloseTo(520)
  })

  it('fastens every edge of the five inset bookcase shelves', () => {
    const { profiles, connectors, panels } = load('bookcase-tall.json')
    expect(profiles).toHaveLength(32)
    expect(profiles.filter(p => p.spec === '2020')).toHaveLength(10)
    expect(panels.map(p => p.position[1])).toEqual([355, 700, 1050, 1400, 1700])
    expect(connectors.filter(c => c.panelMount)).toHaveLength(40)
    for (const panel of panels) {
      expect(allEdgesFastened(panel, profiles, connectors)).toBe(true)
      const mounts = connectors.filter(c => c.panelMount?.panelId === panel.id)
      expect(allEdgesFastened(panel, profiles, mounts.slice(0, 1))).toBe(false)
      expect(allEdgesFastened(panel, profiles, mounts.slice(0, -1))).toBe(false)
    }
  })

  describe.each(files)('%s', (name) => {
    it('fastens every shelf edge and distributes exterior board fasteners', () => {
      expect(unfastenedPanels(load(name))).toEqual([])
    })
    it('loads as a complete validated project', () => {
      const source = docs.get(name)!
      expect(parseProjectDocument(source).profiles).toHaveLength(source.profiles.length)
    })
    it('has no interference reported between modelled parts', () => {
      const { profiles, connectors, panels, fittings } = load(name)
      const clashes = findConflicts(profiles, computeAllTrims(profiles), connectors, panels, fittings)
      const named = clashes.map((c) => {
        const who = (id: string) => {
          const p = profiles.find((q) => q.id === id)
          if (p) return `${p.spec}@${p.position.map(Math.round)}`
          const c = connectors.find((q) => q.id === id)
          if (c) return c.type
          const b = panels.find((q) => q.id === id)
          if (b) return `board ${Math.round(b.width)}×${Math.round(b.height)}`
          const f = fittings.find((q) => q.id === id)
          return f ? `${f.kind}@${f.position.map(Math.round)}` : id
        }
        return `${who(c.a)} × ${who(c.b)} ${c.depth}mm`
      })
      expect(named).toEqual([])
    })

    it('has no misaligned profile joints', () => {
      const { profiles } = load(name)
      expect(unflushPairs(profiles)).toEqual([])
    })

    it('passes connector seating checks', () => {
      const { profiles, connectors, panels } = load(name)
      expect(auditBrackets(profiles, connectors, undefined, undefined, panels).map((f) => `${f.id} ${f.reason} ${f.off}mm`)).toEqual([])
    })

    it('fastens every profile into one assembly and connects each local joint', () => {
      const { profiles, connectors, panels } = load(name)
      const supports = new Map<string, string[]>()
      expect(auditBrackets(profiles, connectors, computeAllTrims(profiles), supports, panels)).toEqual([])
      const reachable = (from: string, at?: THREE.Vector3) => {
        const links = new Map(profiles.map((p) => [p.id, new Set<string>()]))
        for (const c of connectors) {
          // The supported hardware reaches less than 80 mm from these joint centres.
          // A remote brace must not conceal an unfastened end at this node.
          if (at && new THREE.Vector3(...c.position).distanceTo(at) >= 80) continue
          for (const a of supports.get(c.id) ?? []) for (const b of supports.get(c.id) ?? []) links.get(a)!.add(b)
        }
        const seen = new Set([from])
        for (const id of seen) for (const next of links.get(id) ?? []) seen.add(next)
        return seen
      }
      expect([...reachable(profiles[0].id)].sort()).toEqual(profiles.map((p) => p.id).sort())
      const checked = new Set<string>()
      for (const p of profiles) for (const tip of Object.values(getProfileEndpoints(p))) {
        for (const { a, b, at } of jointPartnersAt(tip, p, profiles)) {
          const key = [a.id, b.id].sort().join('|')
          if (checked.has(key)) continue
          checked.add(key)
          expect(reachable(a.id, at).has(b.id), `${key} at ${at.toArray()}`).toBe(true)
        }
      }
    })

    /** A trimmed joint end must be occupied by a neighbouring member. */
    it('fills the space removed by corner trims', () => {
      const { profiles } = load(name)
      const trims = computeAllTrims(profiles)
      const solid = new Map(profiles.map((p) => [p.id, trimmedBox(p, trims.get(p.id)!)]))
      const empty: string[] = []
      for (const p of profiles) {
        const t = trims.get(p.id)!
        const { start, end } = getProfileEndpoints(p)
        const dir = end.clone().sub(start).normalize()
        for (const [tip, cut, sign] of [[start, t.start.trim, 1], [end, t.end.trim, -1]] as const) {
          if (cut <= 0.5) continue
          // halfway into the length that was cut away
          const probe = (tip as THREE.Vector3).clone().addScaledVector(dir, (sign as number) * (cut as number) / 2)
          if (![...solid].some(([id, box]) => id !== p.id && box.containsPoint(probe))) {
            empty.push(`${p.spec}@${(tip as THREE.Vector3).toArray().map(Math.round)}`)
          }
        }
      }
      expect(empty).toEqual([])
    })

    it('opens each door independently without collisions', () => {
      const { profiles, connectors, panels, fittings } = load(name)
      const trims = computeAllTrims(profiles)
      for (const door of fittings.filter((f) => f.kind === 'door')) {
        for (const open of [0.25, 0.5, 0.75, 1]) {
          const opened = fittings.map((f) => ({ ...f, open: f.id === door.id ? open : 0 }))
          expect(findConflicts(profiles, trims, connectors, panels, opened), `${door.id} at ${open}`).toEqual([])
        }
      }
    })

    it('opens each drawer without collisions after opening any doors in front of it', () => {
      const { profiles, connectors, panels, fittings } = load(name)
      const trims = computeAllTrims(profiles)
      for (const drawer of fittings.filter((f) => f.kind === 'drawer')) {
        const doors = doorsInFront(drawer, fittings)
        for (const open of [0.1, 0.25, 0.5, 0.75, 1]) {
          const opened = fittings.map((f) => ({ ...f, open: doors.has(f.id) ? 1 : f.id === drawer.id ? open : 0 }))
          expect(findConflicts(profiles, trims, connectors, panels, opened), `${drawer.id} at ${open}`).toEqual([])
        }
      }
    })

    it('has no fitting collisions with all doors and drawers fully open', () => {
      const { profiles, connectors, panels, fittings } = load(name)
      const everything = fittings.map((g) => ({ ...g, open: 1 }))
      expect(findConflicts(profiles, computeAllTrims(profiles), connectors, panels, everything)).toEqual([])
    })

    /** Shelves use full bearing faces or distributed, validated plate fasteners. */
    it('identifies support geometry along each shelf edge', () => {
      const { profiles, panels, connectors } = load(name)
      const trims = computeAllTrims(profiles)
      const metal = profiles.map((p) => trimmedBox(p, trims.get(p.id)!))
      const loose: string[] = []
      for (const b of panels) {
        const q = new THREE.Quaternion(...b.quaternion).normalize()
        const box = new THREE.Box3()
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
          box.expandByPoint(new THREE.Vector3(sx * b.width / 2, sy * b.height / 2, sz * b.thickness / 2).applyQuaternion(q).add(new THREE.Vector3(...b.position)))
        }
        const size = box.getSize(new THREE.Vector3())
        if (size.y > 40) continue                       // standing: a back or a side
        const carried = (axis: 'x' | 'z', at: number) => {
          const other = axis === 'x' ? 'z' : 'x'
          return metal.some((m) => {
            const run = Math.min(m.max[axis], box.max[axis]) - Math.max(m.min[axis], box.min[axis])
            const bearing = Math.min(m.max[other], box.max[other]) - Math.max(m.min[other], box.min[other])
            // A whole 2020 face lies beneath the board. A zero-area edge touch or a rail
            // separated vertically cannot satisfy this check, even if the UI has a tolerance.
            const centre = (m.min[other] + m.max[other]) / 2
            return run >= size[axis] * 0.7 && bearing >= 19.99
              && Math.abs(m.max.y - box.min.y) <= 0.01 && Math.abs(centre - at) <= 30
          })
        }
        const edges = [carried('z', box.min.x), carried('z', box.max.x), carried('x', box.min.z), carried('x', box.max.z)]
        if (edges.includes(false) && !allEdgesFastened(b, profiles, connectors)) loose.push(`board@${b.position.map(Math.round)} ${edges.map((e) => (e ? '■' : '□')).join('')}`)
      }
      expect(loose).toEqual([])
    })

    it('identifies mounting geometry for both drawer runners', () => {
      const { profiles, panels, fittings } = load(name)
      expect(runnerFaults(profiles, computeAllTrims(profiles), fittings, panels)).toEqual([])
    })

    it('contains profiles with positive dimensions', () => {
      const { profiles } = load(name)
      expect(profiles.length).toBeGreaterThan(3)
    })
  })
})
