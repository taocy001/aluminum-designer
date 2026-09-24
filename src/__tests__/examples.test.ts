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

    /**
     * A member cut back at a joint gives its end up to whatever it meets there. If nothing
     * takes that space the corner is an empty block — which is what happens when both
     * members give way to each other, and what the interference check, looking only for
     * overlaps, can never see.
     */
    it('no corner is left empty: what one member gives up, another fills', () => {
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
    it('every door and drawer opens all the way without striking anything, one at a time and all at once', () => {
      const { profiles, connectors, panels, fittings } = load(name)
      const trims = computeAllTrims(profiles)
      const shut = new Set(findConflicts(profiles, trims, connectors, panels, fittings).map((c) => `${c.a}|${c.b}`))
      const struck: string[] = []
      for (const f of fittings) {
        const opened = fittings.map((g) => (g.id === f.id ? { ...g, open: 1 } : g))
        for (const c of findConflicts(profiles, trims, connectors, panels, opened)) {
          if (c.a === f.id || c.b === f.id) struck.push(`${f.kind}@${f.position.map(Math.round)} ${c.depth}mm`)
        }
      }
      const everything = fittings.map((g) => ({ ...g, open: 1 }))
      for (const c of findConflicts(profiles, trims, connectors, panels, everything)) {
        if (!shut.has(`${c.a}|${c.b}`)) struck.push(`all open: ${c.a} × ${c.b} ${c.depth}mm`)
      }
      expect(struck).toEqual([])
    })

    /**
     * A shelf hung between two rails is held along two edges; the other two sag under a row
     * of books and the board can tip off. Every horizontal board is carried on all four.
     */
    it('every shelf is carried on all four sides', () => {
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
            return run >= size[axis] * 0.7 && m.max.y >= box.min.y - 2 && m.min.y <= box.max.y + 2
              && m.min[other] - 25 <= at && at <= m.max[other] + 25
          })
        }
        const edges = [carried('z', box.min.x), carried('z', box.max.x), carried('x', box.min.z), carried('x', box.max.z)]
        if (edges.includes(false)) loose.push(`board@${b.position.map(Math.round)} ${edges.map((e) => (e ? '■' : '□')).join('')}`)
      }
      expect(loose).toEqual([])
    })

    it('and it is a drawing, not an empty file', () => {
      const { profiles } = load(name)
      expect(profiles.length).toBeGreaterThan(3)
    })
  })
})
