import * as THREE from 'three'
import type { ConnectorData, FittingData, PanelData, ProfileData } from '../store/useStore'
import { connectorEntry, connectorExtent, connectorScale } from './connectorCatalog'
import { getProfileShape } from './profileShapes'
import { computeAllTrims } from './jointUtils'
import { getProfileDir, getProfileEndpoints } from './geometryCore'
import { fittingParts } from './fittingGeometry'

/**
 * STEP (ISO 10303-21, AP214) export.
 *
 * Without this a drawing stops here: it cannot be opened in FreeCAD or Fusion and it cannot
 * be sent to a shop's CAM. Every tool this one is measured against has it.
 *
 * Every part is written as a **boundary-represented solid**: a closed shell of flat faces,
 * the section polygon pushed along a straight line with a cap on each end. That is what an
 * extrusion is, and a board is the same thing with four corners. It was written as an
 * EXTRUDED_AREA_SOLID over an ARBITRARY_CLOSED_PROFILE_DEF — the IFC way of saying it, which
 * AP214 readers (OpenCASCADE, and so FreeCAD) do not translate: the file opened with no solid
 * and no face in it at all.
 *
 * Each part is its own PRODUCT under the assembly, named by what it is and how long it is
 * cut, so the tree in the CAD program is the cutting list. The brackets go in too, as simple
 * solids — a shop counting holes wants to see where they are.
 *
 * The profile written is the same outline the screen extrudes, slots and all, so what opens
 * in FreeCAD is what you were looking at — and the length written is the **cut length**,
 * after the joints have been trimmed, because that is the part that gets made.
 */

export interface StepInput {
  profiles: ProfileData[]
  panels?: PanelData[]
  fittings?: FittingData[]
  /** brackets, written as simple solids so they can be seen and counted */
  connectors?: ConnectorData[]
  /** what to call the assembly inside the file */
  name?: string
}

/** ISO 10303-21 wants 1.2E-5 style reals, and every real must look like a real */
function num(v: number): string {
  const r = Math.abs(v) < 1e-9 ? 0 : Math.round(v * 1e6) / 1e6
  return Number.isInteger(r) ? `${r}.` : String(r)
}

class Step {
  private lines: string[] = []
  private n = 0
  /** one entity per distinct body of text, so shared geometry is written once */
  private pool = new Map<string, number>()

  add(body: string): number {
    const found = this.pool.get(body)
    if (found !== undefined) return found
    const id = ++this.n
    this.lines.push(`#${id} = ${body};`)
    this.pool.set(body, id)
    return id
  }

  /** an entity that must not be shared, because something will refer to it by identity */
  addUnique(body: string): number {
    const id = ++this.n
    this.lines.push(`#${id} = ${body};`)
    return id
  }

  point(v: THREE.Vector3): number { return this.add(`CARTESIAN_POINT('',(${num(v.x)},${num(v.y)},${num(v.z)}))`) }
  direction(v: THREE.Vector3): number { return this.add(`DIRECTION('',(${num(v.x)},${num(v.y)},${num(v.z)}))`) }

  placement(at: THREE.Vector3, z: THREE.Vector3, x: THREE.Vector3): number {
    return this.add(`AXIS2_PLACEMENT_3D('',#${this.point(at)},#${this.direction(z)},#${this.direction(x)})`)
  }

  body(header: string[], footer: string[]): string {
    return [...header, ...this.lines, ...footer].join('\n')
  }

  get count(): number { return this.n }
}

/** the section outline, in millimetres, closed, as the screen draws it */
function sectionPoints(spec: string): THREE.Vector2[] {
  const pts = getProfileShape(spec as never).getPoints(1)
  // three closes the shape by repeating the first point; STEP wants that too, but only once
  const out = pts.slice()
  while (out.length > 1 && out[0].distanceTo(out[out.length - 1]) < 1e-6) out.pop()
  return out
}

/** a right-handed frame whose +Z is `dir` */
function frameFor(quat: THREE.Quaternion): { z: THREE.Vector3; x: THREE.Vector3 } {
  return {
    z: new THREE.Vector3(0, 0, 1).applyQuaternion(quat).normalize(),
    x: new THREE.Vector3(1, 0, 0).applyQuaternion(quat).normalize(),
  }
}

/** STEP strings are ASCII with the quote doubled; anything else would need \X2\ escapes */
function str(v: string): string {
  return v.replace(/[^\x20-\x7e]/g, '').replace(/'/g, "''")
}

/** the section with repeated points dropped and wound anticlockwise, so every cap faces out */
function tidy(pts: THREE.Vector2[]): THREE.Vector2[] {
  const out: THREE.Vector2[] = []
  for (const p of pts) if (!out.length || out[out.length - 1].distanceTo(p) > 1e-6) out.push(p)
  while (out.length > 1 && out[0].distanceTo(out[out.length - 1]) < 1e-6) out.pop()
  let area = 0
  for (let i = 0; i < out.length; i++) {
    const a = out[i], b = out[(i + 1) % out.length]
    area += a.x * b.y - b.x * a.y
  }
  return area < 0 ? out.reverse() : out
}

/**
 * One closed solid: the polygon `pts` (in the plane through `at` spanned by `x` and z × x)
 * pushed `depth` along `z`, written as a shell of flat faces — two caps and one side per edge
 * of the section. Every edge is written once and used by exactly the two faces either side of
 * it, once each way round, which is what makes the shell closed.
 */
function prism(s: Step, section: THREE.Vector2[], label: string, at: THREE.Vector3, z: THREE.Vector3, x: THREE.Vector3, depth: number): number {
  const pts = tidy(section)
  const y = new THREE.Vector3().crossVectors(z, x).normalize()
  const n = pts.length
  const world = (p: THREE.Vector2, h: number) => at.clone().addScaledVector(x, p.x).addScaledVector(y, p.y).addScaledVector(z, h)
  const lo = pts.map((p) => world(p, 0))
  const hi = pts.map((p) => world(p, depth))
  const vertex = (v: THREE.Vector3) => s.addUnique(`VERTEX_POINT('',#${s.point(v)})`)
  const vLo = lo.map(vertex)
  const vHi = hi.map(vertex)
  const edge = (a: THREE.Vector3, va: number, b: THREE.Vector3, vb: number) => {
    const d = b.clone().sub(a)
    const len = d.length()
    const line = s.addUnique(`LINE('',#${s.point(a)},#${s.add(`VECTOR('',#${s.direction(d.normalize())},${num(len)})`)})`)
    return s.addUnique(`EDGE_CURVE('',#${va},#${vb},#${line},.T.)`)
  }
  const eLo = lo.map((a, i) => edge(a, vLo[i], lo[(i + 1) % n], vLo[(i + 1) % n]))
  const eHi = hi.map((a, i) => edge(a, vHi[i], hi[(i + 1) % n], vHi[(i + 1) % n]))
  const eUp = lo.map((a, i) => edge(a, vLo[i], hi[i], vHi[i]))
  const use = (e: number, forward: boolean) => `#${s.addUnique(`ORIENTED_EDGE('',*,*,#${e},${forward ? '.T.' : '.F.'})`)}`
  const face = (edges: string[], point: THREE.Vector3, normal: THREE.Vector3, ref: THREE.Vector3) => {
    const loop = s.addUnique(`EDGE_LOOP('',(${edges.join(',')}))`)
    const bound = s.addUnique(`FACE_OUTER_BOUND('',#${loop},.T.)`)
    const plane = s.addUnique(`PLANE('',#${s.placement(point, normal, ref)})`)
    return s.addUnique(`ADVANCED_FACE('',(#${bound}),#${plane},.T.)`)
  }
  const faces: number[] = []
  // the far cap looks along +z and runs anticlockwise; the near one looks back and runs the other way
  faces.push(face(eHi.map((e) => use(e, true)), hi[0], z, x))
  faces.push(face(eLo.map((e) => use(e, false)).reverse(), lo[0], z.clone().negate(), x))
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const along = lo[j].clone().sub(lo[i]).normalize()
    const out = new THREE.Vector3().crossVectors(along, z).normalize()
    faces.push(face([use(eLo[i], true), use(eUp[j], true), use(eHi[i], false), use(eUp[i], false)], lo[i], out, along))
  }
  const shell = s.addUnique(`CLOSED_SHELL('',(${faces.map((f) => `#${f}`).join(',')}))`)
  return s.addUnique(`MANIFOLD_SOLID_BREP('${str(label)}',#${shell})`)
}

/** a board is the same thing with four corners */
function slab(w: number, h: number): THREE.Vector2[] {
  return [
    new THREE.Vector2(-w / 2, -h / 2), new THREE.Vector2(w / 2, -h / 2),
    new THREE.Vector2(w / 2, h / 2), new THREE.Vector2(-w / 2, h / 2),
  ]
}

/** a cast corner bracket, as the screen draws it: two flanges at a right angle meeting at the origin */
const ANGLE_T = 4
const ANGLE_W = 18
const ANGLE_REACH = 30

const mm = (v: number) => Math.round(v * 10) / 10

export function buildStep({ profiles, panels = [], fittings = [], connectors = [], name = 'frame' }: StepInput): string {
  const s = new Step()

  // units and the one geometric context every representation shares
  const lenUnit = s.addUnique('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))')
  const radUnit = s.addUnique('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))')
  const srUnit = s.addUnique('(NAMED_UNIT(*)SOLID_ANGLE_UNIT()SI_UNIT($,.STERADIAN.))')
  const unc = s.addUnique(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-05),#${lenUnit},'distance_accuracy_value','confusion accuracy')`)
  const ctx = s.addUnique(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lenUnit},#${radUnit},#${srUnit}))REPRESENTATION_CONTEXT('',''))`)
  const appCtx = s.addUnique(`APPLICATION_CONTEXT('core data for automotive mechanical design processes')`)
  s.addUnique(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${appCtx})`)
  const prodCtx = s.addUnique(`PRODUCT_CONTEXT('',#${appCtx},'mechanical')`)
  const pdCtx = s.addUnique(`PRODUCT_DEFINITION_CONTEXT('part definition',#${appCtx},'design')`)

  const origin = () => s.addUnique(`AXIS2_PLACEMENT_3D('',#${s.point(new THREE.Vector3())},#${s.direction(new THREE.Vector3(0, 0, 1))},#${s.direction(new THREE.Vector3(1, 0, 0))})`)

  /** a PRODUCT with its definition, its shape and the representation that is that shape */
  const product = (label: string, rep: number) => {
    const prod = s.addUnique(`PRODUCT('${str(label)}','${str(label)}','',(#${prodCtx}))`)
    const formation = s.addUnique(`PRODUCT_DEFINITION_FORMATION('','',#${prod})`)
    const pd = s.addUnique(`PRODUCT_DEFINITION('design','',#${formation},#${pdCtx})`)
    const pds = s.addUnique(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`)
    s.addUnique(`SHAPE_DEFINITION_REPRESENTATION(#${pds},#${rep})`)
    return pd
  }

  const asmOrigin = origin()
  const asmRep = s.addUnique(`SHAPE_REPRESENTATION('${str(name)}',(#${asmOrigin}),#${ctx})`)
  const asm = product(name, asmRep)

  // Geometry is written where it is in the drawing, so every part sits in the assembly with
  // no transformation of its own: the placement that ties the two together is the identity.
  let count = 0
  const part = (label: string, solid: number) => {
    count++
    const own = origin()
    const rep = s.addUnique(`ADVANCED_BREP_SHAPE_REPRESENTATION('${str(label)}',(#${solid},#${own}),#${ctx})`)
    const pd = product(label, rep)
    const nauo = s.addUnique(`NEXT_ASSEMBLY_USAGE_OCCURRENCE('${count}','${str(label)}','',#${asm},#${pd},$)`)
    const pds = s.addUnique(`PRODUCT_DEFINITION_SHAPE('','',#${nauo})`)
    const idt = s.addUnique(`ITEM_DEFINED_TRANSFORMATION('','',#${own},#${asmOrigin})`)
    const rel = s.addUnique(`(REPRESENTATION_RELATIONSHIP('','',#${rep},#${asmRep})REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#${idt})SHAPE_REPRESENTATION_RELATIONSHIP())`)
    s.addUnique(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#${rel},#${pds})`)
  }

  const trims = computeAllTrims(profiles)
  for (const p of profiles) {
    const t = trims.get(p.id)
    const quat = new THREE.Quaternion(...p.quaternion).normalize()
    const { z, x } = frameFor(quat)
    // the cut length, from the cut end: what is actually made and what is actually there
    const start = new THREE.Vector3(...p.position).addScaledVector(getProfileDir(p), t?.start.trim ?? 0)
    const depth = t?.cutLength ?? p.length
    if (depth <= 0) continue
    const label = `${p.spec} L${mm(depth)}`
    part(label, prism(s, sectionPoints(p.spec), label, start, z, x, depth))
  }

  for (const b of panels) {
    if (b.width <= 0 || b.height <= 0 || b.thickness <= 0) continue
    const quat = new THREE.Quaternion(...b.quaternion).normalize()
    const { z, x } = frameFor(quat)
    const back = new THREE.Vector3(...b.position).addScaledVector(z, -b.thickness / 2)
    const label = `${b.material} ${mm(b.width)}x${mm(b.height)}x${mm(b.thickness)}`
    part(label, prism(s, slab(b.width, b.height), label, back, z, x, b.thickness))
  }

  // ...and a door or a drawer is a handful of boards, each one placed in the fitting's frame
  for (const f of fittings) {
    const world = new THREE.Quaternion(...f.quaternion).normalize()
    const at = new THREE.Vector3(...f.position)
    for (const board of fittingParts(f).boards) {
      if (board.width <= 0 || board.height <= 0 || board.thickness <= 0) continue
      const quat = world.clone().multiply(new THREE.Quaternion(...board.quaternion))
      const { z, x } = frameFor(quat)
      const centre = new THREE.Vector3(...board.position).applyQuaternion(world).add(at)
      const back = centre.addScaledVector(z, -board.thickness / 2)
      const label = `${f.kind}-${board.role} ${mm(board.width)}x${mm(board.height)}x${mm(board.thickness)}`
      part(label, prism(s, slab(board.width, board.height), label, back, z, x, board.thickness))
    }
  }

  // A bracket is a simple solid: a cast angle as its two flanges, anything else as the room
  // it takes up. Enough to see where every one of them goes and to count them.
  for (const c of connectors) {
    const series = c.series ?? 20
    const k = connectorScale(series)
    const quat = new THREE.Quaternion(...c.quaternion).normalize()
    const { z, x } = frameFor(quat)
    const at = new THREE.Vector3(...c.position)
    const label = `${c.type} ${series}`
    if (c.type !== 'inside-corner' && connectorEntry(c.type)?.seat === 'angle') {
      const r = ANGLE_REACH * k, t = ANGLE_T * k
      const L = [[0, 0], [r, 0], [r, t], [t, t], [t, r], [0, r]].map(([u, v]) => new THREE.Vector2(u, v))
      part(label, prism(s, L, label, at.addScaledVector(z, -ANGLE_W * k / 2), z, x, ANGLE_W * k))
    } else {
      const { centre, half } = connectorExtent(c.type)
      const mid = at.add(new THREE.Vector3(...centre).multiplyScalar(k).applyQuaternion(quat))
      const [hx, hy, hz] = half.map((h) => h * k)
      part(label, prism(s, slab(2 * hx, 2 * hy), label, mid.addScaledVector(z, -hz), z, x, 2 * hz))
    }
  }

  const stamp = new Date().toISOString().replace(/\.\d+Z$/, '')
  const head = [
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION(('aluminium extrusion frame'),'2;1');`,
    `FILE_NAME('${str(name)}.step','${stamp}',(''),(''),'aluminum-designer','aluminum-designer','');`,
    `FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 3 1 1 }'));`,
    'ENDSEC;',
    'DATA;',
  ]
  return s.body(head, ['ENDSEC;', 'END-ISO-10303-21;']) + '\n'
}
