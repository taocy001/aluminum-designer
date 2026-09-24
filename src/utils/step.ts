import * as THREE from 'three'
import type { FittingData, PanelData, ProfileData } from '../store/useStore'
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
 * A frame is a gift for this format. Everything in it is a **polygon swept along a straight
 * line** — that is what an extrusion is, and a board is the same thing with four corners. So
 * each part is one EXTRUDED_AREA_SOLID rather than a shell of hundreds of faces, and the
 * section is written once per spec and pointed at by every member that uses it. Twelve
 * cabinets come out as a few thousand entities instead of a few hundred thousand.
 *
 * The profile written is the same outline the screen extrudes, slots and all, so what opens
 * in FreeCAD is what you were looking at — and the length written is the **cut length**,
 * after the joints have been trimmed, because that is the part that gets made.
 */

export interface StepInput {
  profiles: ProfileData[]
  panels?: PanelData[]
  fittings?: FittingData[]
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

/**
 * One swept solid: the closed polygon `pts` (in the placement's own XY plane) pushed `depth`
 * along the placement's +Z.
 */
function sweep(s: Step, pts: THREE.Vector2[], label: string, at: THREE.Vector3, z: THREE.Vector3, x: THREE.Vector3, depth: number): number {
  // the section is the same for every member of a spec, so it is written once and pointed at
  const ids = pts.map((p) => s.point(new THREE.Vector3(p.x, p.y, 0)))
  const poly = s.add(`POLYLINE('',(${[...ids, ids[0]].map((i) => `#${i}`).join(',')}))`)
  const profile = s.add(`ARBITRARY_CLOSED_PROFILE_DEF(.AREA.,'${label}',#${poly})`)
  const place = s.placement(at, z, x)
  const up = s.direction(new THREE.Vector3(0, 0, 1))
  return s.addUnique(`EXTRUDED_AREA_SOLID('${label}',#${profile},#${place},#${up},${num(depth)})`)
}

export function buildStep({ profiles, panels = [], fittings = [], name = 'frame' }: StepInput): string {
  const s = new Step()
  const trims = computeAllTrims(profiles)
  const solids: number[] = []

  for (const p of profiles) {
    const t = trims.get(p.id)
    const quat = new THREE.Quaternion(...p.quaternion).normalize()
    const { z, x } = frameFor(quat)
    // the cut length, from the cut end: what is actually made and what is actually there
    const start = new THREE.Vector3(...p.position).addScaledVector(getProfileDir(p), t?.start.trim ?? 0)
    const depth = t?.cutLength ?? p.length
    if (depth <= 0) continue
    solids.push(sweep(s, sectionPoints(p.spec), p.spec, start, z, x, depth))
  }

  // a board is the same thing with four corners
  const slab = (w: number, h: number): THREE.Vector2[] => [
    new THREE.Vector2(-w / 2, -h / 2), new THREE.Vector2(w / 2, -h / 2),
    new THREE.Vector2(w / 2, h / 2), new THREE.Vector2(-w / 2, h / 2),
  ]
  for (const b of panels) {
    const quat = new THREE.Quaternion(...b.quaternion).normalize()
    const { z, x } = frameFor(quat)
    const back = new THREE.Vector3(...b.position).addScaledVector(z, -b.thickness / 2)
    solids.push(sweep(s, slab(b.width, b.height), b.material, back, z, x, b.thickness))
  }

  // ...and a door or a drawer is a handful of boards, each one placed in the fitting's frame
  for (const f of fittings) {
    const world = new THREE.Quaternion(...f.quaternion).normalize()
    const at = new THREE.Vector3(...f.position)
    for (const board of fittingParts(f).boards) {
      const quat = world.clone().multiply(new THREE.Quaternion(...board.quaternion))
      const { z, x } = frameFor(quat)
      const centre = new THREE.Vector3(...board.position).applyQuaternion(world).add(at)
      const back = centre.addScaledVector(z, -board.thickness / 2)
      solids.push(sweep(s, slab(board.width, board.height), `${f.kind}-${board.role}`, back, z, x, board.thickness))
    }
  }

  const ctx = s.addUnique(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#UNC))GLOBAL_UNIT_ASSIGNED_CONTEXT((#MM,#RAD,#SR))REPRESENTATION_CONTEXT('',''))`)
  const shape = s.addUnique(`SHAPE_REPRESENTATION('${name}',(${solids.map((i) => `#${i}`).join(',')}),#${ctx})`)

  // The units and the product wrapper are fixed boilerplate, so they are written by hand at
  // known ids and the context above is patched to point at them. Emitting them through the
  // pool would have them share ids with geometry, which is legal and unreadable.
  const base = s.count
  const mm = base + 1, rad = base + 2, sr = base + 3, unc = base + 4
  const appCtx = base + 5, appProt = base + 6, prodCtx = base + 7, prod = base + 8
  const formation = base + 9, pdCtx = base + 10, pd = base + 11, pds = base + 12, sdr = base + 13

  const tail = [
    `#${mm} = (LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));`,
    `#${rad} = (NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));`,
    `#${sr} = (NAMED_UNIT(*)SOLID_ANGLE_UNIT()SI_UNIT($,.STERADIAN.));`,
    `#${unc} = UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-05),#${mm},'distance_accuracy_value','confusion accuracy');`,
    `#${appCtx} = APPLICATION_CONTEXT('core data for automotive mechanical design processes');`,
    `#${appProt} = APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${appCtx});`,
    `#${prodCtx} = PRODUCT_CONTEXT('',#${appCtx},'mechanical');`,
    `#${prod} = PRODUCT('${name}','${name}','',(#${prodCtx}));`,
    `#${formation} = PRODUCT_DEFINITION_FORMATION('','',#${prod});`,
    `#${pdCtx} = PRODUCT_DEFINITION_CONTEXT('part definition',#${appCtx},'design');`,
    `#${pd} = PRODUCT_DEFINITION('','',#${formation},#${pdCtx});`,
    `#${pds} = PRODUCT_DEFINITION_SHAPE('','',#${pd});`,
    `#${sdr} = SHAPE_DEFINITION_REPRESENTATION(#${pds},#${shape});`,
    'ENDSEC;',
    'END-ISO-10303-21;',
  ]

  const stamp = new Date().toISOString().replace(/\.\d+Z$/, '')
  const head = [
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION(('aluminium extrusion frame'),'2;1');`,
    `FILE_NAME('${name}.step','${stamp}',(''),(''),'aluminum-designer','aluminum-designer','');`,
    `FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 3 1 1 }'));`,
    'ENDSEC;',
    'DATA;',
  ]

  return s.body(head, tail)
    .replace('#UNC', `#${unc}`)
    .replace('#MM,#RAD,#SR', `#${mm},#${rad},#${sr}`) + '\n'
}
