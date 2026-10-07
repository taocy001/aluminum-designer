import * as THREE from 'three'
import type { ConnectorData, FittingData, PanelData, ProfileData } from '../store/useStore'
import { connectorScale } from './connectorCatalog'
import { connectorMeshes } from './connectorGeometry'
import { getProfileShape } from './profileShapes'
import { computeAllTrims, type ProfileTrims, type ThroughRule } from './jointUtils'
import { getProfileDir } from './geometryCore'
import { fittingParts } from './fittingGeometry'
import { fittingBoardNumber, partNumber } from './partNumbers'

/**
 * ISO 10303-21 AP214 export. Each part is a PRODUCT containing a closed BREP shell
 * of planar faces. Profiles use the display section outline at cut length;
 * connectors use their display bodies, with curved surfaces faceted and hole markers omitted.
 */

export interface StepInput {
  profiles: ProfileData[]
  panels?: PanelData[]
  fittings?: FittingData[]
  /** Display bodies, without decorative hole markers. */
  connectors?: ConnectorData[]
  rule?: ThroughRule
  trims?: Map<string, ProfileTrims>
  /** what to call the assembly inside the file */
  name?: string
}

/** Write integer-valued reals with a decimal point. */
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
function prism(s: Step, section: THREE.Vector2[], label: string, at: THREE.Vector3, z: THREE.Vector3, x: THREE.Vector3, depth: number, holes: THREE.Vector2[][] = []): number {
  const rings = [tidy(section), ...holes.map((hole) => tidy(hole).reverse())]
  const pts = rings.flat()
  const y = new THREE.Vector3().crossVectors(z, x).normalize()
  const next: number[] = []
  let start = 0
  for (const ring of rings) {
    ring.forEach((_, i) => next.push(start + (i + 1) % ring.length))
    start += ring.length
  }
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
  const eLo = lo.map((a, i) => edge(a, vLo[i], lo[next[i]], vLo[next[i]]))
  const eHi = hi.map((a, i) => edge(a, vHi[i], hi[next[i]], vHi[next[i]]))
  const eUp = lo.map((a, i) => edge(a, vLo[i], hi[i], vHi[i]))
  const use = (e: number, forward: boolean) => `#${s.addUnique(`ORIENTED_EDGE('',*,*,#${e},${forward ? '.T.' : '.F.'})`)}`
  const face = (loops: string[][], point: THREE.Vector3, normal: THREE.Vector3, ref: THREE.Vector3) => {
    const bounds = loops.map((edges, index) => {
      const loop = s.addUnique(`EDGE_LOOP('',(${edges.join(',')}))`)
      return s.addUnique(`${index === 0 ? 'FACE_OUTER_BOUND' : 'FACE_BOUND'}('',#${loop},.T.)`)
    })
    const plane = s.addUnique(`PLANE('',#${s.placement(point, normal, ref)})`)
    return s.addUnique(`ADVANCED_FACE('',(${bounds.map((id) => `#${id}`).join(',')}),#${plane},.T.)`)
  }
  const faces: number[] = []
  // the far cap looks along +z and runs anticlockwise; the near one looks back and runs the other way
  const capLoops = (edges: number[], forward: boolean) => {
    let offset = 0
    return rings.map((ring) => {
      const loop = edges.slice(offset, offset + ring.length).map((e) => use(e, forward))
      offset += ring.length
      return forward ? loop : loop.reverse()
    })
  }
  faces.push(face(capLoops(eHi, true), hi[0], z, x))
  faces.push(face(capLoops(eLo, false), lo[0], z.clone().negate(), x))
  for (let i = 0; i < n; i++) {
    const j = next[i]
    const along = lo[j].clone().sub(lo[i]).normalize()
    const out = new THREE.Vector3().crossVectors(along, z).normalize()
    faces.push(face([[use(eLo[i], true), use(eUp[j], true), use(eHi[i], false), use(eUp[i], false)]], lo[i], out, along))
  }
  const shell = s.addUnique(`CLOSED_SHELL('',(${faces.map((f) => `#${f}`).join(',')}))`)
  return s.addUnique(`MANIFOLD_SOLID_BREP('${str(label)}',#${shell})`)
}

/** Rectangular section for a board or connector envelope. */
function slab(w: number, h: number): THREE.Vector2[] {
  return [
    new THREE.Vector2(-w / 2, -h / 2), new THREE.Vector2(w / 2, -h / 2),
    new THREE.Vector2(w / 2, h / 2), new THREE.Vector2(-w / 2, h / 2),
  ]
}

/** Export a display body as a closed, faceted BREP. Weld face-normal seams before creating edges. */
function meshSolid(s: Step, geometry: THREE.BufferGeometry, label: string, transform: THREE.Matrix4): number {
  const positions = geometry.getAttribute('position')
  const indices = geometry.getIndex()
  const points: THREE.Vector3[] = []
  const vertices: number[] = []
  const byPosition = new Map<string, number>()
  const pointIndex = (source: number) => {
    const point = new THREE.Vector3().fromBufferAttribute(positions, source).applyMatrix4(transform)
    const key = [point.x, point.y, point.z].map(num).join(',')
    let index = byPosition.get(key)
    if (index === undefined) {
      index = points.length
      byPosition.set(key, index)
      points.push(point)
      vertices.push(s.addUnique(`VERTEX_POINT('',#${s.point(point)})`))
    }
    return index
  }
  const edges = new Map<string, { id: number; from: number }>()
  const use = (a: number, b: number) => {
    const key = a < b ? `${a}/${b}` : `${b}/${a}`
    let edge = edges.get(key)
    if (!edge) {
      const direction = points[b].clone().sub(points[a])
      const length = direction.length()
      const vector = s.add(`VECTOR('',#${s.direction(direction.normalize())},${num(length)})`)
      const line = s.addUnique(`LINE('',#${s.point(points[a])},#${vector})`)
      edge = { id: s.addUnique(`EDGE_CURVE('',#${vertices[a]},#${vertices[b]},#${line},.T.)`), from: a }
      edges.set(key, edge)
    }
    return s.addUnique(`ORIENTED_EDGE('',*,*,#${edge.id},.${edge.from === a ? 'T' : 'F'}.)`)
  }
  const faces: number[] = []
  for (let i = 0; i < (indices?.count ?? positions.count); i += 3) {
    const triangle = [0, 1, 2].map((offset) => pointIndex(indices ? indices.getX(i + offset) : i + offset))
    if (new Set(triangle).size < 3) continue
    const [a, b, c] = triangle.map((index) => points[index])
    const along = b.clone().sub(a).normalize()
    const normal = along.clone().cross(c.clone().sub(a)).normalize()
    if (normal.lengthSq() < 1e-12) continue
    const loop = s.addUnique(`EDGE_LOOP('',(${triangle.map((index, j) => `#${use(index, triangle[(j + 1) % 3])}`).join(',')}))`)
    const bound = s.addUnique(`FACE_OUTER_BOUND('',#${loop},.T.)`)
    const plane = s.addUnique(`PLANE('',#${s.placement(a, normal, along)})`)
    faces.push(s.addUnique(`ADVANCED_FACE('',(#${bound}),#${plane},.T.)`))
  }
  const shell = s.addUnique(`CLOSED_SHELL('',(${faces.map((face) => `#${face}`).join(',')}))`)
  return s.addUnique(`MANIFOLD_SOLID_BREP('${str(label)}',#${shell})`)
}

const mm = (v: number) => Math.round(v * 10) / 10

export function buildStep({ profiles, panels = [], fittings = [], connectors = [], rule, trims: suppliedTrims, name = 'frame' }: StepInput): string {
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
  const product = (label: string, rep: number, description = '') => {
    const prod = s.addUnique(`PRODUCT('${str(label)}','${str(label)}','${str(description)}',(#${prodCtx}))`)
    const formation = s.addUnique(`PRODUCT_DEFINITION_FORMATION('','',#${prod})`)
    const pd = s.addUnique(`PRODUCT_DEFINITION('design','',#${formation},#${pdCtx})`)
    const pds = s.addUnique(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`)
    s.addUnique(`SHAPE_DEFINITION_REPRESENTATION(#${pds},#${rep})`)
    return pd
  }

  const asmOrigin = origin()
  const asmRep = s.addUnique(`SHAPE_REPRESENTATION('${str(name)}',(#${asmOrigin}),#${ctx})`)
  const asm = product(name, asmRep)

  // World-space geometry uses an identity assembly placement.
  const part = (label: string, description: string, solid: number | number[]) => {
    const own = origin()
    const bodies = (Array.isArray(solid) ? solid : [solid]).map((body) => `#${body}`).join(',')
    const rep = s.addUnique(`ADVANCED_BREP_SHAPE_REPRESENTATION('${str(label)}',(${bodies},#${own}),#${ctx})`)
    const pd = product(label, rep, description)
    const nauo = s.addUnique(`NEXT_ASSEMBLY_USAGE_OCCURRENCE('${str(label)}','${str(label)}','${str(description)}',#${asm},#${pd},$)`)
    const pds = s.addUnique(`PRODUCT_DEFINITION_SHAPE('','',#${nauo})`)
    const idt = s.addUnique(`ITEM_DEFINED_TRANSFORMATION('','',#${own},#${asmOrigin})`)
    const rel = s.addUnique(`(REPRESENTATION_RELATIONSHIP('','',#${rep},#${asmRep})REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#${idt})SHAPE_REPRESENTATION_RELATIONSHIP())`)
    s.addUnique(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#${rel},#${pds})`)
  }

  const trims = suppliedTrims ?? computeAllTrims(profiles, rule)
  for (const p of profiles) {
    const t = trims.get(p.id)
    const quat = new THREE.Quaternion(...p.quaternion).normalize()
    const { z, x } = frameFor(quat)
    // Extrude from the trimmed start face over the finished cut length.
    const start = new THREE.Vector3(...p.position).addScaledVector(getProfileDir(p), t?.start.trim ?? 0)
    const depth = t?.cutLength ?? p.length
    if (depth <= 0) continue
    const label = partNumber('profile', p.id)
    const section = getProfileShape(p.spec).extractPoints(6)
    part(label, `${p.spec} L${mm(depth)}`, prism(s, section.shape, label, start, z, x, depth, section.holes))
  }

  for (const b of panels) {
    if (b.width <= 0 || b.height <= 0 || b.thickness <= 0) continue
    const quat = new THREE.Quaternion(...b.quaternion).normalize()
    const { z, x } = frameFor(quat)
    const back = new THREE.Vector3(...b.position).addScaledVector(z, -b.thickness / 2)
    const label = partNumber('panel', b.id)
    part(label, `${b.material} ${mm(b.width)}x${mm(b.height)}x${mm(b.thickness)}`,
      prism(s, slab(b.width, b.height), label, back, z, x, b.thickness))
  }

  // Export each fitting board in its closed position.
  for (const f of fittings) {
    const world = new THREE.Quaternion(...f.quaternion).normalize()
    const at = new THREE.Vector3(...f.position)
    for (const board of fittingParts(f).boards) {
      if (board.width <= 0 || board.height <= 0 || board.thickness <= 0) continue
      const quat = world.clone().multiply(new THREE.Quaternion(...board.quaternion))
      const { z, x } = frameFor(quat)
      const centre = new THREE.Vector3(...board.position).applyQuaternion(world).add(at)
      const back = centre.addScaledVector(z, -board.thickness / 2)
      const label = fittingBoardNumber(f.id, board.key)
      part(label, `${f.kind}/${board.role} ${mm(board.width)}x${mm(board.height)}x${mm(board.thickness)}`,
        prism(s, slab(board.width, board.height), label, back, z, x, board.thickness))
    }
  }

  // Keep each connector as one assembly part containing its modeled bodies.
  for (const c of connectors) {
    const series = c.series ?? 20
    const k = connectorScale(series)
    const quat = new THREE.Quaternion(...c.quaternion).normalize()
    const at = new THREE.Vector3(...c.position)
    const label = partNumber('connector', c.id)
    const description = `${c.type} ${series}${c.profileSpec ? ` ${c.profileSpec}` : ''}`
    const transform = new THREE.Matrix4().compose(at, quat, new THREE.Vector3(k, k, k))
    const bodies = connectorMeshes(c.type, series, c.profileSpec, c.mountSeries).filter((mesh) => !mesh.visualOnly)
      .map(({ geometry }, index) => meshSolid(s, geometry, `${label}-${index + 1}`, transform))
    part(label, description, bodies)
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
