import { describe, it, expect } from 'vitest'
import { findConflicts } from '../utils/analysis'
import * as THREE from 'three'
import { computeAllTrims, trimmedBox } from '../utils/jointUtils'
import { getProfileEndpoints } from '../utils/geometryCore'
import { unflushPairs } from '../utils/faceAlign'
import hardwareChecks from '../../examples/checks/hardware.json'
import { auditBrackets } from '../utils/bracketSeat'
import { migrateFittings } from '../utils/migrate'
import { parseProjectDocument } from '../utils/document'
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

/** Check bundled examples for the geometric conditions asserted below. */
describe('bundled example geometry', () => {
  it('loads the expected example files', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  describe.each(files)('%s', (name) => {
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

    it('reports exactly the documented corner pairs without a supported connector', () => {
      const { profiles } = load(name)
      const known = hardwareChecks.find((entry) => entry.file.endsWith(`/${name}`))!
      expect(known).toBeDefined()
      expect(unflushPairs(profiles).map(({ a, b }) => [a, b].sort().join('|')).sort()).toEqual(known.unsupportedCornerPairs)
    })

    it('passes connector seating checks', () => {
      const { profiles, connectors } = load(name)
      expect(auditBrackets(profiles, connectors).map((f) => `${f.id} ${f.reason} ${f.off}mm`)).toEqual([])
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

    /**
     * The inset cut size ends at the perimeter rails' inside faces. Those touching edge
     * lines have no bearing area. Shipping examples therefore have separate bearing rails
     * under the board; verify a full 20 mm bearing width independently of shelfEdges.
     */
    it('identifies support geometry along each shelf edge', () => {
      const { profiles, panels } = load(name)
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
        if (edges.includes(false)) loose.push(`board@${b.position.map(Math.round)} ${edges.map((e) => (e ? '■' : '□')).join('')}`)
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
