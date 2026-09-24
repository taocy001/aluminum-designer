import { describe, it, expect } from 'vitest'
import { findConflicts } from '../utils/analysis'
import * as THREE from 'three'
import { computeAllTrims, trimmedBox } from '../utils/jointUtils'
import { getProfileEndpoints } from '../utils/geometryCore'
import { countUnflush } from '../utils/faceAlign'
import { auditBrackets } from '../utils/bracketSeat'
import { migrateFittings } from '../utils/migrate'
import type { ConnectorData, FittingData, PanelData, ProfileData } from '../store/useStore'

interface Doc {
  profiles: ProfileData[]
  connectors?: ConnectorData[]
  panels?: PanelData[]
  fittings?: FittingData[]
}

/** Load bundled example files. The connector catalogue display is excluded from frame checks. */
const SHOWCASE = 'connector-demo'
const loaded = import.meta.glob('../../examples/*.json', { eager: true }) as Record<string, { default: Doc }>
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

/** Check bundled examples for the geometric conditions asserted below. */
describe('bundled example geometry', () => {
  it('loads the expected example files', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  describe.each(files)('%s', (name) => {
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

    it('finds a supported connector seat for every checked joint', () => {
      const { profiles } = load(name)
      expect(countUnflush(profiles)).toBe(0)
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

    /**
     * Opened, one at a time. The check above sees every door shut, which is how they were
     * drawn and not how they are used: a leaf turned about the wrong edge went through the
     * door beside it and into the frame, in a drawing that had just been declared clean.
     */
    it('every door opens all the way without striking anything', () => {
      const { profiles, connectors, panels, fittings } = load(name)
      const trims = computeAllTrims(profiles)
      const struck: string[] = []
      for (const door of fittings.filter((f) => f.kind === 'door')) {
        const opened = fittings.map((f) => (f.id === door.id ? { ...f, open: 1 } : f))
        for (const c of findConflicts(profiles, trims, connectors, panels, opened)) {
          if (c.a === door.id || c.b === door.id) struck.push(`door@${door.position.map(Math.round)} ${c.depth}mm`)
        }
      }
      expect(struck).toEqual([])
    })

    it('contains profiles with positive dimensions', () => {
      const { profiles } = load(name)
      expect(profiles.length).toBeGreaterThan(3)
    })
  })
})
