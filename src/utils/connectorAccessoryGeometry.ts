import * as THREE from 'three'
import type { ProfileSpec } from '../store/useStore'
import type { ConnectorSeries } from './connectorCatalog'
import { accessoryHingeDimensions, accessoryMountPoints, accessoryNutDimensions, accessoryPlateDimensions } from './connectorAccessoryReferences'
import { boxGeometry, cylinderGeometry, plateGeometry, ringGeometry, geometryFromCad,
  type CollisionBox, type CollisionPart, type ConnectorMesh, type V3 } from './connectorSolidPrimitives'
import nut20 from '../assets/connectorCad/motedis-tnut-20-installed.json'
import nut30 from '../assets/connectorCad/motedis-tnut-30-installed.json'
import nut40 from '../assets/connectorCad/motedis-tnut-40-installed.json'
import cap2020 from '../assets/connectorCad/motedis-cap-2020.json'
import cap2040 from '../assets/connectorCad/motedis-cap-2040.json'
import cap3030 from '../assets/connectorCad/motedis-cap-3030.json'
import cap4040 from '../assets/connectorCad/motedis-cap-4040.json'
import casterBearings from '../assets/connectorCad/motedis-caster-10146-bearings.json'
import casterAxleTube from '../assets/connectorCad/motedis-caster-10146-14.json'
import casterAxle from '../assets/connectorCad/motedis-caster-10146-15.json'
import casterNut from '../assets/connectorCad/motedis-caster-10146-16.json'
import casterWheel from '../assets/connectorCad/motedis-caster-10146-17.json'
import casterFork from '../assets/connectorCad/motedis-caster-10146-18.json'
import casterSwivel from '../assets/connectorCad/motedis-caster-10146-19.json'
import casterBore from '../assets/connectorCad/motedis-caster-10146-20.json'
import casterCover from '../assets/connectorCad/motedis-caster-10146-21.json'
import casterScrew from '../assets/connectorCad/din7991-m8x25-caster.json'
import adapterScrew from '../assets/connectorCad/din7991-m6x20.json'

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
      ...b, centre: b.centre.map((n) => n * k) as V3, half: b.half.map((n) => n * k) as V3,
    }))
    if (part.collisionParts) part.collisionParts = part.collisionParts.map((solid) => 'vertices' in solid
      ? { ...solid, vertices: solid.vertices.map((v) => v.map((n) => n * k) as V3) }
      : { ...solid, centre: solid.centre.map((n) => n * k) as V3, half: solid.half.map((n) => n * k) as V3 })
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
    if (spec === '4040-B6') {
      // Four original B6 caps: each pin enters one core; retention tabs face outwards.
      for (const x of [-10, 10]) for (const y of [-10, 10]) {
        const sign = x < 0 ? 1 : -1
        parts.push({ geometry: geometryFromCad(cap2020).rotateZ(x < 0 ? 0 : Math.PI).translate(x, y, 0), dark: true,
          collisionParts: cap2020.collisionParts.map((b, i) => ({
            centre: [sign * b.centre[0] + x, sign * b.centre[1] + y, b.centre[2]] as V3,
            half: b.half as V3, pressFit: i > 0,
          })) })
      }
    } else {
      const cad = spec === '2020' ? cap2020 : spec === '2040' ? cap2040 : spec === '4040' ? cap4040 : cap3030
      parts.push({ geometry: geometryFromCad(cad), dark: true,
        collisionParts: cad.collisionParts.map((b, i) => ({ centre: b.centre as V3, half: b.half as V3, pressFit: i > 0 })) })
    }
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
      { centre: [0, -d.shoulderDepth + d.neckHeight / 2, z], half: [series === 30 ? 4 : d.neckWidth / 2, d.neckHeight / 2, d.length / 2] },
      { centre: [0, -d.shoulderDepth - (d.thickness - d.neckHeight) / 2, z], half: [series === 40 ? 6.753 : d.width / 2, (d.thickness - d.neckHeight) / 2, d.length / 2] },
    ]
    if (series === 40) pieces.push({ centre: [0, -11.45, 9.5], half: [2.5, .55, 2.5] })
    if (series === 30) {
      parts.push({ geometry: geometryFromCad(nut30), collisionParts: nut30.collisionParts as CollisionPart[] })
    } else if (series === 20) {
      // The B6 hammer nut has 2 mm bottom chamfers matching the slot floor.
      const chamfer = 2, half = d.width / 2
      const bottom = -d.shoulderDepth - d.thickness + d.neckHeight
      parts.push({ geometry: geometryFromCad(nut20), collisionParts: [pieces[0], {
        vertices: [-d.length / 2, d.length / 2].flatMap((depth) => [
          [-half, -d.shoulderDepth, depth], [half, -d.shoulderDepth, depth], [half, bottom + chamfer, depth],
          [half - chamfer, bottom, depth], [-half + chamfer, bottom, depth], [-half, bottom + chamfer, depth],
        ] as V3[]),
      }] })
    } else parts.push(mesh(geometryFromCad(nut40), pieces))
  } else if (type === 'foot') {
    const adapter = series === 20 && profileSpec === '4040-B6'
    if (adapter) {
      // Each M6 screw contributes a shaft followed by a head collision solid.
      for (const x of [-10, 10]) for (const z of [-10, 10]) {
        const shaft = axial(3, 16.7, 'y', [x, 3.75, z])
        parts.push({ geometry: geometryFromCad(adapterScrew).translate(x, -7.9, z), polished: true,
          collisionParts: [{ vertices: shaft.collisionVertices! }, { centre: [x, -6.25, z], half: [6, 1.65, 6] }] })
        shaft.geometry.dispose()
      }
      const holes = [-10, 10].flatMap((x) => [-10, 10].map((y) => ({ x, y, bore: 6.6, sink: 12.8 })))
      holes.push({ x: 0, y: 0, bore: 8, sink: 8 })
      parts.push(mesh(countersunkPlate(rect(-20, -20, 20, 20), 8, holes).rotateX(Math.PI / 2)))
    }
    // 10 mm of the M8 stud enters the tapped end; the locknut's contact face is Y=0.
    const footStart = parts.length
    parts.push({ ...axial(4, 58.74, 'y', [0, -19.37, 0]), polished: true })
    const nut = (y: number) => {
      const polygon = Array.from({ length: 6 }, (_, i): [number, number] => [7 / Math.cos(Math.PI / 6) * Math.cos(i * Math.PI / 3), 7 / Math.cos(Math.PI / 6) * Math.sin(i * Math.PI / 3)])
      return mesh(plateGeometry(polygon, 6, [{ x: 0, y: 0, r: 4 }]).rotateX(-Math.PI / 2).translate(0, y, 0))
    }
    parts.push(nut(-6), nut(-55))
    const base = new THREE.CylinderGeometry(6.5, 19.7, 12, 40).translate(0, -54.74, 0)
    parts.push({ geometry: base, dark: true }, axial(19.7, 7.5, 'y', [0, -64.49, 0], true))
    if (adapter) for (const part of parts.slice(footStart)) {
      part.geometry.translate(0, -8, 0)
      if (part.collisionVertices) part.collisionVertices = part.collisionVertices.map(([x, y, z]) => [x, y - 8, z])
      if (part.collisionBoxes) part.collisionBoxes = part.collisionBoxes.map((b) => ({ ...b, centre: [b.centre[0], b.centre[1] - 8, b.centre[2]] }))
    }
  } else if (type === 'caster-mount') {
    // The fixing screw bears on the STEP bore's lower edge. Its first collision
    // part is only the M8 shaft; the head remains subject to normal clearance.
    const shaft = axial(4, 20.6, 'y', [0, -1.9391, 0])
    parts.push({ geometry: geometryFromCad(casterScrew), polished: true, collisionParts: [
      { vertices: shaft.collisionVertices! }, { centre: [0, -14.4391, 0], half: [8, 2.2, 8] },
    ] })
    shaft.geometry.dispose()
    parts.push({ geometry: geometryFromCad(casterFork), collisionBoxes: casterFork.collisionParts as CollisionBox[] })
    for (const cad of [casterBearings, casterAxleTube, casterAxle, casterNut, casterSwivel, casterBore, casterCover])
      parts.push({ geometry: geometryFromCad(cad), polished: true })
    parts.push({ geometry: geometryFromCad(casterWheel), dark: true })
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
