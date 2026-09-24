import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { buildProfile } from '../utils/profileFactory'
import { buildStep } from '../utils/step'
import { computeAllTrims } from '../utils/jointUtils'
import { getProfileDir } from '../utils/geometryCore'
import type { ProfileData, ProfileSpec } from '../store/useStore'

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
  return [...all].filter(([, b]) => b.startsWith('MANIFOLD_SOLID_BREP(')).map(([id, body]) => {
    const ids = reach(all, id)
    const points: THREE.Vector3[] = []
    const uses = new Map<number, string[]>()
    for (const i of ids) {
      const b = all.get(i)!
      const pt = b.match(/^CARTESIAN_POINT\('',\(([-\d.eE]+),([-\d.eE]+),([-\d.eE]+)\)\)/)
      if (pt) points.push(new THREE.Vector3(+pt[1], +pt[2], +pt[3]))
      const oe = b.match(/^ORIENTED_EDGE\('',\*,\*,#(\d+),\.(T|F)\.\)/)
      if (oe) uses.set(+oe[1], [...(uses.get(+oe[1]) ?? []), oe[2]])
    }
    return { name: body.match(/'([^']*)'/)![1], points, uses }
  })
}

/**
 * Without this a drawing stops at the screen: it cannot be opened in FreeCAD, and it cannot
 * be sent to a shop's CAM. A frame is a gift for the format — everything in it is a polygon
 * swept along a straight line — so every part is one swept solid rather than a shell of
 * hundreds of faces.
 */
describe('STEP export', () => {
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
    // what OpenCASCADE (and so FreeCAD) will not translate: the file used to open empty
    expect(out).not.toContain('EXTRUDED_AREA_SOLID')
    expect(out).not.toContain('ARBITRARY_CLOSED_PROFILE_DEF')
    expect(solidsOf(out).length).toBe(mixed.length)
    expect((out.match(/= NEXT_ASSEMBLY_USAGE_OCCURRENCE\(/g) ?? []).length).toBe(mixed.length)
    // one product per part, plus the assembly they are all used in
    expect((out.match(/= PRODUCT\(/g) ?? []).length).toBe(mixed.length + 1)
    expect(out).toContain("PRODUCT('4040 L800','4040 L800'")
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
    expect(out).toContain("PRODUCT('2020 L580'")
  })

  it('a board comes out as a slab of its own thickness', () => {
    const board = {
      id: 'b1', width: 560, height: 760, thickness: 18,
      position: [300, 400, -20], quaternion: [0, 0, 0, 1], material: 'mdf',
    } as never
    const out = buildStep({ profiles: frame(), panels: [board] })
    const solids = solidsOf(out)
    expect(solids.length).toBe(5)
    const slab = solids.find((sol) => sol.name === 'mdf 560x760x18')!
    const box = new THREE.Box3().setFromPoints(slab.points)
    expect(box.min.toArray().map(Math.round)).toEqual([20, 20, -29])
    expect(box.max.toArray().map(Math.round)).toEqual([580, 780, -11])
  })

  it('every bracket is a solid, where the bracket is', () => {
    const at: [number, number, number] = [100, 200, 300]
    const connectors = [
      { id: 'c1', type: 'bracket', position: at, quaternion: [0, 0, 0, 1] },
      { id: 'c2', type: 'bracket', series: 40, position: at, quaternion: [0, 0, 0, 1] },
      { id: 'c3', type: 'inside-corner', position: at, quaternion: [0, 0, 0, 1] },
    ] as never
    const solids = solidsOf(buildStep({ profiles: [], connectors }))
    expect(solids.length).toBe(3)
    const box = (i: number) => new THREE.Box3().setFromPoints(solids[i].points)
    // a cast angle runs thirty out of its vertex along both members, eighteen across
    expect(box(0).min.toArray().map(Math.round)).toEqual([100, 200, 291])
    expect(box(0).max.toArray().map(Math.round)).toEqual([130, 230, 309])
    // the 40 series part is the same part twice the size
    expect(box(1).max.toArray().map(Math.round)).toEqual([160, 260, 318])
    // an inside corner connector sits in the slots: all that is outside is its vertex
    expect(box(2).max.x - box(2).min.x).toBeLessThan(5)
  })

  it('an empty drawing is still a valid file', () => {
    const out = buildStep({ profiles: [] })
    const { defined, used } = ids(out)
    for (const u of used) expect(defined.has(u)).toBe(true)
    expect(out).toContain('SHAPE_REPRESENTATION')
  })
})

/**
 * The exporter saying it wrote the right thing is not evidence. Reading the file back and
 * finding the frame in it is: every member's cut start and cut length has to be in there,
 * pointing the way the member points.
 */
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
