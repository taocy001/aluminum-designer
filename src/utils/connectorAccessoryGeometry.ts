import * as THREE from 'three'
import type { ProfileSpec } from '../store/useStore'
import type { ConnectorSeries } from './connectorCatalog'
import { accessoryHingeDimensions, accessoryMountPoints, accessoryNutDimensions, accessoryPlateDimensions } from './connectorAccessoryReferences'
import { boxGeometry, cylinderGeometry, plateGeometry, ringGeometry, geometryFromCad,
  type CollisionBox, type ConnectorMesh, type V3 } from './connectorSolidPrimitives'
import nut20 from '../assets/connectorCad/motedis-tnut-20-installed.json'
import nut30 from '../assets/connectorCad/motedis-tnut-30-installed.json'
import nut40 from '../assets/connectorCad/motedis-tnut-40-installed.json'
import cap2020 from '../assets/connectorCad/motedis-cap-2020.json'
import cap2040 from '../assets/connectorCad/motedis-cap-2040.json'
import cap3030 from '../assets/connectorCad/motedis-cap-3030.json'
import cap4040 from '../assets/connectorCad/motedis-cap-4040.json'
import caster0 from '../assets/connectorCad/motedis-caster-963-0.json'
import caster1 from '../assets/connectorCad/motedis-caster-963-1.json'
import caster2 from '../assets/connectorCad/motedis-caster-963-2.json'
import caster3 from '../assets/connectorCad/motedis-caster-963-3.json'
import caster4 from '../assets/connectorCad/motedis-caster-963-4.json'
import caster5 from '../assets/connectorCad/motedis-caster-963-5.json'
import caster6 from '../assets/connectorCad/motedis-caster-963-6.json'
import caster7 from '../assets/connectorCad/motedis-caster-963-7.json'

const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
const box = (size: V3, centre: V3, dark = false): ConnectorMesh => ({ geometry: boxGeometry(size, centre), dark,
  collisionBoxes: [{ centre, half: size.map((n) => n / 2) as V3 }] })
const axial = (radius: number, length: number, axis: 'x' | 'y' | 'z', centre: V3, dark = false): ConnectorMesh => ({
  geometry: cylinderGeometry(radius, length, axis, centre), dark,
  collisionVertices: [-1, 1].flatMap((end) => Array.from({ length: 12 }, (_, i): V3 => {
    const r = radius / Math.cos(Math.PI / 12), a = i * Math.PI / 6 + Math.PI / 12
    const p: V3 = [r * Math.cos(a), end * length / 2, r * Math.sin(a)]
    if (axis === 'x') [p[0], p[1]] = [p[1], -p[0]]
    if (axis === 'z') [p[1], p[2]] = [-p[2], p[1]]
    return p.map((n, j) => n + centre[j]) as V3
  })),
})
function mesh(geometry: THREE.BufferGeometry, collisionBoxes?: CollisionBox[]): ConnectorMesh { return { geometry, collisionBoxes } }
function normalize(parts: ConnectorMesh[], series: ConnectorSeries): ConnectorMesh[] {
  const k = 20 / series
  for (const part of parts) {
    part.geometry.scale(k, k, k)
    if (part.collisionBoxes) part.collisionBoxes = part.collisionBoxes.map((b) => ({
      centre: b.centre.map((n) => n * k) as V3, half: b.half.map((n) => n * k) as V3,
    }))
    if (part.collisionParts) part.collisionParts = part.collisionParts.map((solid) => 'vertices' in solid
      ? { vertices: solid.vertices.map((v) => v.map((n) => n * k) as V3) }
      : { centre: solid.centre.map((n) => n * k) as V3, half: solid.half.map((n) => n * k) as V3 })
    if (part.collisionVertices) part.collisionVertices = part.collisionVertices.map((v) => v.map((n) => n * k) as V3)
  }
  return parts
}

/** Closed plate with a cylindrical bore and 90° countersink in the same shell. */
function countersunkPlate(points: [number, number][], depth: number, holes: { x: number; y: number; bore: number; sink: number }[]) {
  const segments = 32, positions: number[] = []
  const circle = (h: typeof holes[number], r: number) => Array.from({ length: segments }, (_, i) =>
    new THREE.Vector2(h.x + r * Math.cos(i * 2 * Math.PI / segments), h.y + r * Math.sin(i * 2 * Math.PI / segments)))
  const outer = points.map(([x, y]) => new THREE.Vector2(x, y))
  const triangle = (a: V3, b: V3, c: V3) => positions.push(...a, ...b, ...c)
  for (const top of [false, true]) {
    const rims = holes.map((h) => circle(h, (top ? h.sink : h.bore) / 2)), all = [...outer, ...rims.flat()]
    for (let [a, b, c] of THREE.ShapeUtils.triangulateShape(outer.slice(), rims.map((r) => r.slice()))) {
      const signed = (all[b].x - all[a].x) * (all[c].y - all[a].y) - (all[b].y - all[a].y) * (all[c].x - all[a].x)
      if ((signed > 0) !== top) [b, c] = [c, b]
      triangle([all[a].x, all[a].y, top ? depth : 0], [all[b].x, all[b].y, top ? depth : 0], [all[c].x, all[c].y, top ? depth : 0])
    }
  }
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length]
    triangle([...a, 0], [...b, 0], [...b, depth]); triangle([...a, 0], [...b, depth], [...a, depth])
  }
  for (const h of holes) {
    const low = circle(h, h.bore / 2), high = circle(h, h.sink / 2), start = depth - (h.sink - h.bore) / 2
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments
      const a: V3 = [low[i].x, low[i].y, 0], b: V3 = [low[j].x, low[j].y, 0]
      const c: V3 = [low[j].x, low[j].y, start], d: V3 = [low[i].x, low[i].y, start]
      const e: V3 = [high[j].x, high[j].y, depth], f: V3 = [high[i].x, high[i].y, depth]
      triangle(a, d, c); triangle(a, c, b); triangle(d, f, e); triangle(d, e, c)
    }
  }
  const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.computeVertexNormals()
  return g
}

/** All builders use physical mm and normalize once, so series selection never stretches a real SKU. */
export function accessoryMeshes(type: string, series: ConnectorSeries, profileSpec?: ProfileSpec): ConnectorMesh[] | undefined {
  const parts: ConnectorMesh[] = []
  if (['flat-plate', 'joining-plate', 't-bracket', 'cross-bracket'].includes(type)) {
    const d = accessoryPlateDimensions(type, series), s = d.pitch, t = d.thickness
    const holes = accessoryMountPoints(type, series)!.flatMap((m) => m.bolts)
    if (type === 'flat-plate') {
      const g = plateGeometry(rect(-2 * s, -d.width / 2, 2 * s, d.width / 2), t,
        holes.map(([x]) => ({ x, y: 0, r: d.hole / 2 }))).rotateX(-Math.PI / 2)
      parts.push(mesh(g, [{ centre: [0, t / 2, 0], half: [2 * s, t / 2, d.width / 2] }]))
    } else if (type === 'joining-plate') {
      const g = plateGeometry(rect(-s, -d.width / 2, s, d.width / 2), t,
        holes.map(([, , z]) => ({ x: -z, y: 0, r: d.hole / 2 }))).rotateY(Math.PI / 2)
      parts.push(mesh(g, [{ centre: [t / 2, 0, 0], half: [t / 2, d.width / 2, s] }]))
    } else if (type === 't-bracket') {
      const arm = s - 2, bar = s - 1
      const outline: [number, number][] = [[-1.5 * s, -.5 * s], [1.5 * s, -.5 * s], [1.5 * s, -.5 * s + bar],
        [arm / 2, -.5 * s + bar], [arm / 2, 2.5 * s], [-arm / 2, 2.5 * s], [-arm / 2, -.5 * s + bar], [-1.5 * s, -.5 * s + bar]]
      parts.push(mesh(plateGeometry(outline, t, holes.map(([x, y]) => ({ x, y, r: d.hole / 2 }))), [
        { centre: [0, -.5, t / 2], half: [1.5 * s, bar / 2, t / 2] },
        { centre: [0, (2.5 * s + -.5 * s + bar) / 2, t / 2], half: [arm / 2, (3 * s - bar) / 2, t / 2] },
      ]))
    } else {
      const outline: [number, number][] = [[-2.5 * s, -.5 * s], [-.5 * s, -1.5 * s], [.5 * s, -1.5 * s], [2.5 * s, -.5 * s],
        [2.5 * s, .5 * s], [.5 * s, 1.5 * s], [-.5 * s, 1.5 * s], [-2.5 * s, .5 * s]]
      parts.push({ geometry: plateGeometry(outline, t, holes.map(([x, y]) => ({ x, y, r: d.hole / 2 }))),
        collisionVertices: [0, t].flatMap((z) => outline.map(([x, y]): V3 => [x, y, z])) })
    }
  } else if (type === 'end-cap') {
    const spec = profileSpec ?? `${series}${series}`
    const cad = spec === '2020' ? cap2020 : spec === '2040' ? cap2040 : spec === '4040' ? cap4040 : cap3030
    parts.push({ geometry: geometryFromCad(cad), dark: true, collisionParts: cad.collisionParts as { centre: V3; half: V3 }[] })
  } else if (type === 'hinge') {
    const d = accessoryHingeDimensions(series), r = d.barrelRadius
    for (const side of [-1, 1]) {
      const y0 = side < 0 ? -d.width / 2 : r - .5, y1 = side < 0 ? -r + .5 : d.width / 2
      // The temporary XY plate maps x→Y, y→Z and extrusion Z→X.
      const g = countersunkPlate(rect(y0, -d.length / 2, y1, d.length / 2), d.thickness,
        [-1, 1].map((end) => ({ x: side * d.acrossPitch / 2, y: end * d.alongPitch / 2, bore: d.hole, sink: d.sink })))
      g.applyMatrix4(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)))
      parts.push(mesh(g, [{ centre: [d.thickness / 2, (y0 + y1) / 2, 0], half: [d.thickness / 2, (y1 - y0) / 2, d.length / 2] }]))
    }
    const pinRadius = 2
    for (let i = 0; i < 3; i++) {
      const z0 = -d.length / 2 + i * d.length / 3 + .15, length = d.length / 3 - .3
      parts.push(mesh(ringGeometry(r, pinRadius, length, z0).translate(d.axisHeight, 0, 0)))
      // Alternating lugs connect the barrels to the corresponding leaf.
      const side = i === 1 ? 1 : -1
      parts.push(box([d.thickness, r, length], [d.thickness / 2, side * r / 2, z0 + length / 2]))
    }
    parts.push({ ...axial(pinRadius, d.length + 2, 'z', [d.axisHeight, 0, 0]), polished: true })
  } else if (type === 't-nut') {
    const d = accessoryNutDimensions(series), z = d.length / 2 - d.holeFromEnd
    const pieces: CollisionBox[] = [
      { centre: [0, -d.shoulderDepth + d.neckHeight / 2, z], half: [d.neckWidth / 2, d.neckHeight / 2, d.length / 2] },
      { centre: [0, -d.shoulderDepth - (d.thickness - d.neckHeight) / 2, z], half: [d.width / 2, (d.thickness - d.neckHeight) / 2, d.length / 2] },
    ]
    if (series === 40) pieces.push({ centre: [0, -11.45, 9.5], half: [2.5, .55, 2.5] })
    parts.push(mesh(geometryFromCad(series === 20 ? nut20 : series === 30 ? nut30 : nut40), pieces))
  } else if (type === 'foot') {
    // 10 mm of the M8 stud enters the tapped end; the locknut's contact face is Y=0.
    parts.push({ ...axial(4, 58.74, 'y', [0, -19.37, 0]), polished: true })
    const nut = (y: number) => {
      const polygon = Array.from({ length: 6 }, (_, i): [number, number] => [7 / Math.cos(Math.PI / 6) * Math.cos(i * Math.PI / 3), 7 / Math.cos(Math.PI / 6) * Math.sin(i * Math.PI / 3)])
      return mesh(plateGeometry(polygon, 6, [{ x: 0, y: 0, r: 4 }]).rotateX(-Math.PI / 2).translate(0, y, 0))
    }
    parts.push(nut(-6), nut(-55))
    const base = new THREE.CylinderGeometry(6.5, 19.7, 12, 40).translate(0, -54.74, 0)
    parts.push({ geometry: base, dark: true }, axial(19.7, 7.5, 'y', [0, -64.49, 0], true))
  } else if (type === 'caster-mount') {
    const fork = geometryFromCad(caster0)
    parts.push({ geometry: fork, collisionBoxes: [
      { centre: [8, -32, -12.75], half: [19, 24.7, .75] },
      { centre: [8, -32, 12.75], half: [19, 24.7, .75] },
      { centre: [0, -9.45, 0], half: [18.95, 2.25, 18.95] },
      { centre: [-8.5, -30, 0], half: [10.5, 15, 12] },
    ] })
    for (const [i, cad] of [caster1, caster2, caster3, caster4, caster5, caster6, caster7].entries())
      parts.push({ geometry: geometryFromCad(cad), dark: i < 3 })
  } else if (type === 'pivot') {
    // Each foot is drilled along Y; the housing and bearing are drilled along Z.
    // Separate closed solids share attachment faces without CSG triangulation seams.
    const outline: [number, number][] = [[-10, 0], [10, 0], [10, 14], [6, 22], [-6, 22], [-10, 14]]
    parts.push(mesh(plateGeometry(outline, 10, [{ x: 0, y: 11, r: 7 }], -5), [
      { centre: [0, 11, 0], half: [10, 11, 5] },
    ]))
    for (const side of [-1, 1]) {
      const x0 = side < 0 ? -18 : 10, x1 = side < 0 ? -10 : 18
      parts.push(mesh(plateGeometry(rect(x0, -5, x1, 5), 5, [{ x: side * 13, y: 0, r: 2.75 }]).rotateX(-Math.PI / 2), [
        { centre: [side * 14, 2.5, 0], half: [4, 2.5, 5] },
      ]))
    }
    parts.push({ geometry: ringGeometry(7, 5, 9, -4.5).translate(0, 11, 0), dark: true })
  } else return undefined
  return normalize(parts, series)
}

export const accessoryConnectorMeshes = accessoryMeshes
