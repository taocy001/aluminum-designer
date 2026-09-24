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

/**
 * The example files, read the way the bundler reads anything else, so this needs no node
 * types and no guesswork about the working directory.
 *
 * `connector-demo` is left out on purpose and for a reason: it is fourteen parts laid out to
 * be looked at, one of each kind, not a thing anybody would build. Asking whether it can be
 * assembled is asking the wrong question of it. Everything else here is a drawing of a real
 * object and is judged as one.
 */
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

/**
 * Every example, judged by every check the tool has.
 *
 * This is the one that was missing. The interference check took the metal and the hardware
 * and stopped there — boards and fittings were never in it — so a drawing could be declared
 * clean with every back board inside a post and every door sunk into the frame. Three hundred
 * and ninety end-to-end tests did not catch it, because not one of them had asked whether a
 * board can pass through a member: the tests shared the implementation's blind spot.
 *
 * So the question is asked here of whole drawings rather than of contrived two-member
 * fixtures, on files that ship in the repository. A drawing anybody can open is a drawing
 * whose faults anybody can see, and these are the drawings the README points at.
 */
describe('the drawings that ship are buildable', () => {
  it('there are some, and they are being read', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  describe.each(files)('%s', (name) => {
    it('nothing passes through anything — members, brackets, boards and fittings alike', () => {
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

    it('every joint has something in the catalogue that bolts it', () => {
      const { profiles } = load(name)
      expect(countUnflush(profiles)).toBe(0)
    })

    it('every bracket is where it could actually be bolted', () => {
      const { profiles, connectors } = load(name)
      expect(auditBrackets(profiles, connectors).map((f) => `${f.id} ${f.reason} ${f.off}mm`)).toEqual([])
    })

    it('and it is a drawing, not an empty file', () => {
      const { profiles } = load(name)
      expect(profiles.length).toBeGreaterThan(3)
    })
  })
})
