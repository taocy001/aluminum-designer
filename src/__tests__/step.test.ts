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

  it('one swept solid per member, and the section written once per spec', () => {
    const mixed = [...frame(), P(0, 0, 400, 0, 800, 400, '4040'), P(600, 0, 400, 600, 800, 400, '4040')]
    const out = buildStep({ profiles: mixed })
    expect((out.match(/EXTRUDED_AREA_SOLID/g) ?? []).length).toBe(mixed.length)
    // six members, two sections: the points of each section are shared, so the file stays small
    expect((out.match(/CARTESIAN_POINT/g) ?? []).length).toBeLessThan(200)
  })

  it('writes the cut length, not the centreline length', () => {
    const out = buildStep({ profiles: frame() })
    // the rails butt into the posts, so they are cut shorter than the 600 they were drawn
    const depths = [...out.matchAll(/EXTRUDED_AREA_SOLID\('2020',#\d+,#\d+,#\d+,([\d.]+)\)/g)].map((m) => parseFloat(m[1]))
    expect(depths).toContain(580)
    expect(depths).not.toContain(600)
  })

  it('a board comes out as a slab of its own thickness', () => {
    const board = {
      id: 'b1', width: 560, height: 760, thickness: 18,
      position: [300, 400, -20], quaternion: [0, 0, 0, 1], material: 'mdf',
    } as never
    const out = buildStep({ profiles: frame(), panels: [board] })
    expect((out.match(/EXTRUDED_AREA_SOLID/g) ?? []).length).toBe(5)
    expect(out).toContain("ARBITRARY_CLOSED_PROFILE_DEF(.AREA.,'mdf'")
    expect(out).toContain(',18.)')
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

    const points = new Map<string, [number, number, number]>()
    for (const m of out.matchAll(/^#(\d+) = CARTESIAN_POINT\('',\(([-\d.]+),([-\d.]+),([-\d.]+)\)\)/gm)) {
      points.set(m[1], [parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])])
    }
    const dirs = new Map<string, [number, number, number]>()
    for (const m of out.matchAll(/^#(\d+) = DIRECTION\('',\(([-\d.]+),([-\d.]+),([-\d.]+)\)\)/gm)) {
      dirs.set(m[1], [parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])])
    }
    const places = new Map<string, { at: [number, number, number]; z: [number, number, number] }>()
    for (const m of out.matchAll(/^#(\d+) = AXIS2_PLACEMENT_3D\('',#(\d+),#(\d+),#(\d+)\)/gm)) {
      places.set(m[1], { at: points.get(m[2])!, z: dirs.get(m[3])! })
    }
    const solids = [...out.matchAll(/EXTRUDED_AREA_SOLID\('[^']*',#\d+,#(\d+),#\d+,([\d.]+)\)/g)]
      .map((m) => ({ ...places.get(m[1])!, depth: parseFloat(m[2]) }))

    expect(solids.length).toBe(frame.length)
    const trims = computeAllTrims(frame)
    for (const p of frame) {
      const t = trims.get(p.id)!
      const dir = getProfileDir(p)
      const start = new THREE.Vector3(...p.position).addScaledVector(dir, t.start.trim)
      const hit = solids.find((s) =>
        new THREE.Vector3(...s.at).distanceTo(start) < 0.01
        && Math.abs(s.depth - t.cutLength) < 0.01
        && new THREE.Vector3(...s.z).dot(dir) > 0.999)
      expect(hit, `${p.spec} from ${start.toArray()} for ${t.cutLength}`).toBeTruthy()
    }
  })
})
