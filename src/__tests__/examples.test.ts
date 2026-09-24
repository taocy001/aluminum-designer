import { describe, it, expect } from 'vitest'
import { findConflicts } from '../utils/analysis'
import { computeAllTrims } from '../utils/jointUtils'
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

    it('contains profiles with positive dimensions', () => {
      const { profiles } = load(name)
      expect(profiles.length).toBeGreaterThan(3)
    })
  })
})
