import { describe, expect, it } from 'vitest'
import { parseProjectDocument } from '../utils/document'
import { computeAllTrims, setThroughRule, trimmedBox } from '../utils/jointUtils'
import { getProfileDir, getProfileEndpoints } from '../utils/geometryCore'
import { jointPartnersAt } from '../utils/connectorFit'
import { auditBrackets } from '../utils/bracketSeat'

const files = import.meta.glob(['../../examples/*.json', '../../examples/flat/*.json'], { eager: true }) as Record<string, { default: unknown }>
// These rails terminate against ground-standing posts. Feet and floor clearance require that construction.
const postBases = new Set(['03-tall-unit.json', '04-shoe-cupboard.json', '06-wardrobe.json',
  '10-wardrobe-small.json', '11-sideboard.json', '12-vanity.json'])

describe('example bottom frame connections', () => {
  it.each(Object.entries(files).filter(([file]) => !file.includes('connector-demo')))
  ('%s joins each bottom rail pair directly or through its shared standing post', (file, { default: raw }) => {
    const doc = parseProjectDocument(raw)
    setThroughRule(doc.throughRule)
    const trims = computeAllTrims(doc.profiles)
    const supports = new Map<string, string[]>()
    expect(auditBrackets(doc.profiles, doc.connectors, trims, supports, doc.panels)).toEqual([])
    const bottom = doc.profiles.filter(p => Math.abs(getProfileDir(p).y) < 0.001 && p.position[1] < 45)
    const links = [...supports.entries()].map(([id, hosts]) => ({ hosts, part: doc.connectors.find(c => c.id === id)! }))
    for (const p of bottom) for (const tip of Object.values(getProfileEndpoints(p))) {
      for (const { a, b, at } of jointPartnersAt(tip, p, doc.profiles)) {
        if (!bottom.includes(a) || !bottom.includes(b)) continue
        const local = links.filter(l => Math.hypot(...l.part.position.map((v, i) => v - at.getComponent(i))) < 80)
        const connects = (x: string, y: string) => local.some(l => l.hosts.includes(x) && l.hosts.includes(y))
        if (postBases.has(file.split('/').pop()!)) {
          const standing = doc.profiles.filter(p => Math.abs(getProfileDir(p).y) > 0.99 && p.position[1] === 0)
          expect(connects(a.id, b.id) || standing.some(p => connects(a.id, p.id) && connects(b.id, p.id)),
            `${a.id} / ${b.id}: both rails must be fastened at this joint`).toBe(true)
        } else {
          expect(connects(a.id, b.id), `${a.id} / ${b.id}: missing direct bottom-rail connector`).toBe(true)
        }
      }
    }
    if (bottom.length) {
      const boxes = doc.profiles.map(p => trimmedBox(p, trims.get(p.id)!))
      expect(Math.min(...boxes.map(b => b.min.y)), 'the frame must stand on the floor').toBeCloseTo(0, 3)
    }
  })
})
