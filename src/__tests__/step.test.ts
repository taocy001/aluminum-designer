import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { buildProfile } from '../utils/profileFactory'
import { buildStep } from '../utils/step'
import { computeAllTrims } from '../utils/jointUtils'
import { getProfileDir } from '../utils/geometryCore'
import { fittingParts, fittingSolids } from '../utils/fittingGeometry'
import { obbCorners } from '../utils/obb'
import { fittingBoardNumber, partNumber } from '../utils/partNumbers'
import { equipment } from './fixtures/equipment'
import { CONNECTOR_CATALOG } from '../utils/connectorCatalog'
import type { ConnectorData, FittingData, ProfileData, ProfileSpec } from '../store/useStore'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const P = (sx: number, sy: number, sz: number, ex: number, ey: number, ez: number, spec: ProfileSpec = '2020'): ProfileData =>
  buildProfile(V(sx, sy, sz), V(ex, ey, ez), spec)!

/** every #id the file refers to, and every #id it defines */
function ids(step: string) {
  const defined = new Set<number>()
  const used = new Set<number>()
  for (const line of step.split('\n')) {
    const def = line.match(/^#(\d+) = /)
    if (def) defined.add(Number(def[1]))
    const body = def ? line.slice(def[0].length) : line
    for (const m of body.matchAll(/#(\d+)/g)) used.add(Number(m[1]))
  }
  return { defined, used }
}

/** the file as a graph: every entity's body, by id */
function entities(step: string): Map<number, string> {
  const out = new Map<number, string>()
  for (const m of step.matchAll(/^#(\d+) = (.*);$/gm)) out.set(Number(m[1]), m[2])
  return out
}

/** every entity reachable from `root` */
function reach(all: Map<number, string>, root: number): Set<number> {
  const seen = new Set<number>([root])
  const todo = [root]
  while (todo.length) {
    for (const m of all.get(todo.pop()!)!.matchAll(/#(\d+)/g)) {
      const id = Number(m[1])
      if (!seen.has(id)) { seen.add(id); todo.push(id) }
    }
  }
  return seen
}

/** every solid in the file with the corners it reaches */
function solidsOf(step: string) {
  const all = entities(step)
  return [...all].filter(([, b]) => /^(MANIFOLD_SOLID_BREP|FACETED_BREP)\(/.test(b)).map(([id, body]) => {
    const ids = reach(all, id)
    const points: THREE.Vector3[] = []
    const uses = new Map<string, string[]>()
    for (const i of ids) {
      const b = all.get(i)!
      const pt = b.match(/^CARTESIAN_POINT\('',\(([-\d.eE]+),([-\d.eE]+),([-\d.eE]+)\)\)/)
      if (pt) points.push(new THREE.Vector3(+pt[1], +pt[2], +pt[3]))
      const oe = b.match(/^ORIENTED_EDGE\('',\*,\*,#(\d+),\.(T|F)\.\)/)
      if (b.startsWith('POLY_LOOP(')) {
        const loop = [...b.matchAll(/#(\d+)/g)].map(match => Number(match[1]))
        for (let j = 0; j < loop.length; j++) {
          const a = loop[j], next = loop[(j + 1) % loop.length]
          const edge = a < next ? `${a}/${next}` : `${next}/${a}`
          uses.set(edge, [...(uses.get(edge) ?? []), a < next ? 'T' : 'F'])
        }
      }
      if (oe) uses.set(oe[1], [...(uses.get(oe[1]) ?? []), oe[2]])
    }
    return { name: body.match(/'([^']*)'/)![1], points, uses }
  })
}

/** Validate exported AP214 solid topology and part dimensions. */
describe('STEP export', () => {
  it('preserves Unicode names and escapes literal delimiters', () => {
    const out = buildStep({ profiles: [], name: "柜 'A' \\ 装配" })
    expect(out).toContain("\\X2\\67DC\\X0\\ ''A'' \\\\ \\X2\\88C5914D\\X0\\")
    expect(out).not.toMatch(/[^\x00-\x7f]/)
  })
  const frame = () => [
    P(0, 0, 0, 0, 800, 0),
    P(600, 0, 0, 600, 800, 0),
    P(0, 20, 0, 600, 20, 0),
    P(0, 780, 0, 600, 780, 0),
  ]

  it('is a well-formed ISO 10303-21 file', () => {
    const out = buildStep({ profiles: frame() })
    expect(out.startsWith('ISO-10303-21;\nHEADER;')).toBe(true)
    expect(out.trimEnd().endsWith('END-ISO-10303-21;')).toBe(true)
    expect(out).toContain("FILE_SCHEMA(('AUTOMOTIVE_DESIGN")
    expect(out.split('DATA;').length).toBe(2)
    expect((out.match(/ENDSEC;/g) ?? []).length).toBe(2)
  })

  it('refers to nothing it does not define', () => {
    const { defined, used } = ids(buildStep({ profiles: frame() }))
    for (const u of used) expect(defined.has(u), `#${u} is referenced but never defined`).toBe(true)
    expect(defined.size).toBeGreaterThan(20)
  })

  it('leaves no placeholder behind', () => {
    const out = buildStep({ profiles: frame() })
    expect(out).not.toContain('#UNC')
    expect(out).not.toContain('#MM')
    expect(out).not.toContain('#RAD')
  })

  it('one closed solid per member, and each member its own part in the assembly', () => {
    const mixed = [...frame(), P(0, 0, 400, 0, 800, 400, '4040'), P(600, 0, 400, 600, 800, 400, '4040')]
    const out = buildStep({ profiles: mixed })
    // Reject IFC entities unsupported by the AP214 export schema.
    expect(out).not.toContain('EXTRUDED_AREA_SOLID')
    expect(out).not.toContain('ARBITRARY_CLOSED_PROFILE_DEF')
    expect(solidsOf(out).length).toBe(mixed.length)
    expect((out.match(/= NEXT_ASSEMBLY_USAGE_OCCURRENCE\(/g) ?? []).length).toBe(mixed.length)
    // one product per part, plus the assembly they are all used in
    expect((out.match(/= PRODUCT\(/g) ?? []).length).toBe(mixed.length + 1)
    const number = partNumber('profile', mixed[4].id)
    expect(out).toContain(`PRODUCT('${number}','${number}','4040 L800'`)
  })

  it('every shell is closed: each edge used by two faces, once each way round', () => {
    const board = {
      id: 'b1', width: 560, height: 760, thickness: 18,
      position: [300, 400, -20], quaternion: [0, 0, 0, 1], material: 'mdf',
    } as never
    const bracket = { id: 'c1', type: 'bracket', position: [20, 20, 0], quaternion: [0, 0, 0, 1] } as never
    const out = buildStep({ profiles: [...frame(), P(0, 0, 400, 0, 800, 400, '4040')], panels: [board], connectors: [bracket] })
    const solids = solidsOf(out)
    expect(solids.length).toBe(7)
    for (const sol of solids) {
      expect(sol.uses.size, sol.name).toBeGreaterThan(0)
      for (const [edge, senses] of sol.uses) expect(senses.sort(), `${sol.name} edge #${edge}`).toEqual(['F', 'T'])
    }
  })

  it('writes the cut length, not the centreline length', () => {
    const out = buildStep({ profiles: frame() })
    // the rails butt into the posts, so they are cut shorter than the 600 they were drawn
    const lengths = solidsOf(out).map((sol) => {
      const box = new THREE.Box3().setFromPoints(sol.points)
      return Math.round(box.max.x - box.min.x)
    })
    expect(lengths).toContain(580)
    expect(lengths).not.toContain(600)
    expect(out).toContain("'2020 L580'")
  })

  it('a board comes out as a slab of its own thickness', () => {
    const board = {
      id: 'b1', width: 560, height: 760, thickness: 18,
      position: [300, 400, -20], quaternion: [0, 0, 0, 1], material: 'mdf',
    } as never
    const out = buildStep({ profiles: frame(), panels: [board] })
    const solids = solidsOf(out)
    expect(solids.length).toBe(5)
    const slab = solids.find((sol) => sol.name === partNumber('panel', 'b1'))!
    const box = new THREE.Box3().setFromPoints(slab.points)
    expect(box.min.toArray().map(Math.round)).toEqual([20, 20, -29])
    expect(box.max.toArray().map(Math.round)).toEqual([580, 780, -11])
  })

  it('exports the manufacturer envelopes and the inner casting as one closed body', () => {
    const at: [number, number, number] = [100, 200, 300]
    const exportOne = (type: string, series: 20 | 40 = 20) => {
      const connector: ConnectorData = { id: 'corner', type, series, position: at, quaternion: [0, 0, 0, 1] }
      const output = buildStep({ profiles: [], connectors: [connector] })
      expect((output.match(/= NEXT_ASSEMBLY_USAGE_OCCURRENCE\(/g) ?? []).length).toBe(1)
      const solids = solidsOf(output)
      return { solids, bounds: new THREE.Box3().setFromPoints(solids.flatMap((solid) => solid.points)) }
    }
    const bracket = exportOne('bracket', 40)
    expect(bracket.solids).toHaveLength(1)
    expect(bracket.bounds.max.toArray().map(Math.round)).toEqual([136, 236, 319])
    expect(bracket.bounds.min.z).toBeCloseTo(281)
    const inside = exportOne('inside-corner')
    // One continuous casting plus the two DIN 913 M5×6 set screws.
    expect(inside.solids).toHaveLength(3)
    const casting = new THREE.Box3().setFromPoints(inside.solids[0].points)
    expect(casting.min.x).toBeCloseTo(95.8)
    expect(casting.min.y).toBeCloseTo(195.6)
    expect(casting.max.x).toBeCloseTo(121.3)
    expect(casting.max.y).toBeCloseTo(220.45)
    expect(casting.max.z - casting.min.z).toBeCloseTo(9.5)
    expect(inside.bounds.min.x).toBeCloseTo(95)
    expect(inside.bounds.min.y).toBeCloseTo(195.1)
    const gusset = exportOne('gusset', 40)
    expect(gusset.solids).toHaveLength(1)
    expect(gusset.bounds.min.toArray().map(Math.round)).toEqual([100, 200, 282])
    expect(gusset.bounds.max.toArray().map(Math.round)).toEqual([140, 240, 318])
    expect(gusset.solids[0].points.every((point) => (point.x - at[0]) + (point.y - at[1]) <= 40.00001)).toBe(true)
    const threeWay = exportOne('corner-3way', 40)
    expect(threeWay.solids).toHaveLength(1)
    expect(threeWay.bounds.min.toArray().map(Math.round)).toEqual([80, 180, 280])
    expect(threeWay.bounds.max.toArray().map(Math.round)).toEqual([120, 220, 320])
  })

  // Allow a full minute for the original caster's multi-body faceted BREP;
  // every entity reference and every shell edge is checked.
  it.each(CONNECTOR_CATALOG)('exports every $type body as a closed shell after rotation, without exporting visual-only markers', (entry) => {
    const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(.28, -.7, .43))
    const connector: ConnectorData = { id: entry.type, type: entry.type, series: 40,
      position: [35, -17, 130], quaternion: rotation.toArray() }
    const output = buildStep({ profiles: [], connectors: [connector] })
    const { defined, used } = ids(output)
    // Check all references/edges, but collect defects before asserting. Original
    // CAD meshes contain hundreds of thousands of entities; one matcher per
    // healthy entity made this linear topology check spend most time in Vitest.
    expect([...used].filter((id) => !defined.has(id)), `${entry.type}: unresolved references`).toEqual([])
    const solids = solidsOf(output)
    expect(solids.length, entry.type).toBeGreaterThan(0)
    // Fourteen bearing balls are separate solids, not one disconnected shell.
    if (entry.type === 'caster-mount') expect(solids).toHaveLength(23)
    const badEdges = solids.flatMap((solid) => [...solid.uses]
      .filter(([, directions]) => directions.length !== 2 || directions[0] === directions[1])
      .map(([edge, directions]) => ({ solid: solid.name, edge, directions })))
    expect(badEdges, `${entry.type}: every edge must be used twice in opposite directions`).toEqual([])
    expect(solids.every((solid) => solid.uses.size > 0)).toBe(true)
    if (['t-bracket', 'cross-bracket', 'flat-plate', 'joining-plate', 'bracket', 'gusset', 'corner-3way'].includes(entry.type)) expect(solids).toHaveLength(1)
  }, 60_000)

  it.each(['end-cap', 'foot'])('exports the 4040 B6 %s assembly as closed solids after rotation', (type) => {
    const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(.23, -.31, .67))
    const connector: ConnectorData = { id: `b6-${type}`, type, series: 20, profileSpec: '4040-B6',
      position: [57, 40, -81], quaternion: rotation.toArray() }
    const output = buildStep({ profiles: [], connectors: [connector] }), { defined, used } = ids(output)
    expect(output).toContain(`${type} 20 4040-B6`)
    expect([...used].filter((id) => !defined.has(id))).toEqual([])
    const solids = solidsOf(output)
    expect(solids).toHaveLength(type === 'end-cap' ? 4 : 10)
    const badEdges = solids.flatMap((solid) => [...solid.uses]
      .filter(([, directions]) => directions.length !== 2 || directions[0] === directions[1])
      .map(([edge, directions]) => ({ solid: solid.name, edge, directions })))
    expect(badEdges).toEqual([])
    expect(solids.every((solid) => solid.uses.size > 0)).toBe(true)
  }, 30_000)

  it.each([['2020', 1], ['2040', 3], ['3030', 5], ['4040', 5], ['4040-B6', 5]] as const)(
    'preserves the %s core and internal cavities in both end faces', (spec, holeCount) => {
      const profile = P(0, 0, 0, 0, 0, 80, spec)
      const out = buildStep({ profiles: [profile] })
      const solids = solidsOf(out)
      expect(solids).toHaveLength(1)
      expect((out.match(/= FACE_BOUND\(/g) ?? []).length).toBe(holeCount * 2)
      for (const [edge, senses] of solids[0].uses) expect(senses.sort(), `${spec} edge #${edge}`).toEqual(['F', 'T'])
      const size = new THREE.Box3().setFromPoints(solids[0].points).getSize(new THREE.Vector3())
      expect(size.toArray().map(Math.round)).toEqual([Number(spec.slice(0, 2)), Number(spec.slice(2, 4)), 80])
    },
  )

  it('an empty drawing is still a valid file', () => {
    const out = buildStep({ profiles: [] })
    const { defined, used } = ids(out)
    for (const u of used) expect(defined.has(u)).toBe(true)
    expect(out).toContain('SHAPE_REPRESENTATION')
  })

  it('preserves instance identifiers when equal parts are reordered, edited or removed', () => {
    const profiles = [P(0, 0, 0, 0, 600, 0), P(500, 0, 0, 500, 600, 0)]
      .map((p, i) => ({ ...p, id: `post-${i + 1}` }))
    const names = (out: string) => [...out.matchAll(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\('([^']+)'/g)].map((m) => m[1]).sort()
    const before = buildStep({ profiles })
    expect(names(before)).toEqual(profiles.map((p) => partNumber('profile', p.id)))
    const updated = buildStep({ profiles: [{ ...profiles[1], length: 800 }, profiles[0]] })
    expect(names(updated)).toEqual(names(before))
    expect(names(buildStep({ profiles: [profiles[1]] }))).toEqual([partNumber('profile', profiles[1].id)])
    for (const p of profiles) expect(updated).toContain(`PRODUCT('${partNumber('profile', p.id)}','${partNumber('profile', p.id)}',`)
  })

  it('exports configured drawer boards and reinforcements at their closed physical positions', () => {
    const drawer: FittingData = { id: 'drawer-closed', kind: 'drawer', width: 600, height: 240, depth: 500,
      position: [400, 800, -200], quaternion: new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), Math.PI / 2).toArray(),
      material: 'ply', open: 1, drawer: { sideClearance: 20, boxThickness: 18, bottomThickness: 9,
        rearClearance: 30, runnerLength: 400, runnerTravel: 300, reinforcement: { count: 2, width: 40, height: 20 } } }
    const out = buildStep({ profiles: [], fittings: [drawer] })
    const exported = solidsOf(out)
    const boards = fittingParts(drawer).boards
    const expected = fittingSolids(drawer, 0)
    expect(exported).toHaveLength(8)
    expect(exported.map((solid) => solid.name)).toEqual(boards.map((board) => fittingBoardNumber(drawer.id, board.key)))
    for (const [i, solid] of exported.entries()) {
      const actualBox = new THREE.Box3().setFromPoints(solid.points)
      const expectedBox = new THREE.Box3().setFromPoints(obbCorners(expected[i]))
      expect(actualBox.min.distanceTo(expectedBox.min), solid.name).toBeLessThan(1e-5)
      expect(actualBox.max.distanceTo(expectedBox.max), solid.name).toBeLessThan(1e-5)
    }
    expect(solidsOf(buildStep({ profiles: [], fittings: [{ ...drawer, open: 0 }] })))
      .toEqual(exported)
  })

  it('uses explicit trim rules and honours supplied and fixed cuts', () => {
    const profiles = [P(0, 0, 0, 0, 400, 0), P(0, 400, 0, 600, 400, 0)]
    const rails = solidsOf(buildStep({ profiles, rule: 'rails' }))
    const posts = solidsOf(buildStep({ profiles, rule: 'posts' }))
    expect(rails).not.toEqual(posts)
    expect(solidsOf(buildStep({ profiles, rule: 'posts', trims: computeAllTrims(profiles, 'rails') }))).toEqual(rails)
    const fixed = { ...P(0, 0, 0, 500, 0, 0), fixedTrims: { start: 10, end: 30 } }
    const box = new THREE.Box3().setFromPoints(solidsOf(buildStep({ profiles: [fixed] }))[0].points)
    expect(box.min.toArray()).toEqual([10, -10, -10])
    expect(box.max.toArray()).toEqual([470, 10, 10])
  })

  it('excludes equipment from the product tree and geometry', () => {
    const profiles = frame()
    const doc = { profiles, equipment: [equipment('excluded-device')] }
    const out = buildStep(doc)
    expect(solidsOf(out)).toEqual(solidsOf(buildStep({ profiles })))
    expect(out.match(/= PRODUCT\(/g)).toHaveLength(profiles.length + 1)
    expect(out).not.toContain('excluded-device')
  })
})

/** Verify trimmed dimensions and placement by reading exported BREP points. */
describe('reading the STEP back finds the frame that went in', () => {
  it('every member is there, where it was, as long as it is cut', () => {
    const frame = [
      P(0, 0, 0, 0, 800, 0),
      P(600, 0, 0, 600, 800, 0),
      P(0, 20, 0, 600, 20, 0),
      P(0, 20, 0, 0, 20, 400),
    ]
    const out = buildStep({ profiles: frame })

    const solids = solidsOf(out)
    expect(solids.length).toBe(frame.length)
    const trims = computeAllTrims(frame)
    for (const p of frame) {
      const t = trims.get(p.id)!
      const dir = getProfileDir(p)
      const start = new THREE.Vector3(...p.position).addScaledVector(dir, t.start.trim)
      // the member's own points, measured along it: from the cut start to the cut end
      const hit = solids.find((sol) => {
        const along = sol.points.map((q) => q.clone().sub(start).dot(dir))
        const across = sol.points.map((q) => q.clone().sub(start).projectOnPlane(dir).length())
        return Math.abs(Math.min(...along)) < 0.01
          && Math.abs(Math.max(...along) - t.cutLength) < 0.01
          && Math.max(...across) < 15
      })
      expect(hit, `${p.spec} from ${start.toArray()} for ${t.cutLength}`).toBeTruthy()
    }
  })
})
