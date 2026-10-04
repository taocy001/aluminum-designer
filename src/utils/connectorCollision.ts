import * as THREE from 'three'
import type { ConnectorData } from '../store/useStore'
import { connectorScale } from './connectorCatalog'
import { connectorMeshes } from './connectorGeometry'
import { slotOffsets } from './specUtils'
import { makeOBB, obbCorners, type OBB } from './obb'

interface Solid {
  vertices: THREE.Vector3[]
  normals: THREE.Vector3[]
  edges: THREE.Vector3[]
  bounds: THREE.Box3
}
type V3 = [number, number, number]
const meshBounds = new Map<string, { centre: V3; half: V3 }[]>()

function componentBounds(type: string) {
  if (!meshBounds.has(type)) meshBounds.set(type, connectorMeshes(type).filter((mesh) => !mesh.dark).map(({ geometry }) => {
    if (!geometry.boundingBox) geometry.computeBoundingBox()
    return { centre: geometry.boundingBox!.getCenter(new THREE.Vector3()).toArray() as V3,
      half: geometry.boundingBox!.getSize(new THREE.Vector3()).multiplyScalar(0.5).toArray() as V3 }
  }))
  return meshBounds.get(type)!
}

function boxSolid(box: OBB): Solid {
  const vertices = obbCorners(box)
  return { vertices, normals: box.axes, edges: box.axes, bounds: new THREE.Box3().setFromPoints(vertices) }
}

/** Convex pieces of the modeled connector; excludes decorative hole markers. */
function buildSolids(c: ConnectorData, againstMetal = false): Solid[] {
  const q = new THREE.Quaternion(...c.quaternion).normalize(), k = connectorScale(c.series ?? 20)
  const position = new THREE.Vector3(...c.position)
  const point = (v: V3) => new THREE.Vector3(...v).multiplyScalar(k).applyQuaternion(q).add(position)
  const direction = (v: V3) => new THREE.Vector3(...v).normalize().applyQuaternion(q)
  const box = (centre: V3, half: V3) => boxSolid(makeOBB(point(centre), new THREE.Vector3(...half).multiplyScalar(k), q))
  if (c.type === 'gusset') {
    const vertices = [0, 4].flatMap((z) => [[-8, -8, z], [30, -8, z], [-8, 30, z]].map((v) => point(v as V3)))
    return [{ vertices, bounds: new THREE.Box3().setFromPoints(vertices),
    normals: [[1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1]].map((v) => direction(v as V3)),
    edges: [[1, 0, 0], [0, 1, 0], [1, -1, 0], [0, 0, 1]].map((v) => direction(v as V3)),
    }]
  }
  if (c.type === 't-bracket') return [box([0, 0, 2], [35, 10, 2]), box([0, 20, 2], [10, 20, 2])]
  if (c.type === 'bracket') return [box([15, 2, 0], [15, 2, 9]), box([2, 15, 0], [2, 15, 9])]
  if (c.type === 'inside-corner') return againstMetal ? [box([1, 1, 0], [1, 1, 3])] : [
    box([10, -3, 0], [10, 3, 3]), box([-3, 10, 0], [3, 10, 3]), box([1, 1, 0], [1, 1, 3]),
  ]
  if (c.type === 'corner-3way') return [box([10, 2, 0], [10, 2, 4]), box([2, 10, 0], [2, 10, 4]),
    box([2, 2, 5], [2, 2, 5]), box([0, 2, 15], [4, 2, 5]), box([0, 0, 0], [2, 2, 2])]
  // Only the parts outside the mounting face remain for a correctly aligned slot nut.
  if (c.type === 't-nut' && againstMetal) return [box([0, 1, 0], [9, 1, 3.5]), box([0, 5, 0], [2.5, 5, 2.5])]
  return componentBounds(c.type).map((bounds) => box(bounds.centre, bounds.half))
}

const shapeCache = new WeakMap<ConnectorData, {
  type: string; series: ConnectorData['series']; position: number[]; quaternion: number[]; full: Solid[]; metal: Solid[]
}>()
function solids(c: ConnectorData, againstMetal = false): Solid[] {
  let cached = shapeCache.get(c)
  if (!cached || cached.type !== c.type || cached.series !== c.series
    || cached.position[0] !== c.position[0] || cached.position[1] !== c.position[1] || cached.position[2] !== c.position[2]
    || cached.quaternion[0] !== c.quaternion[0] || cached.quaternion[1] !== c.quaternion[1]
    || cached.quaternion[2] !== c.quaternion[2] || cached.quaternion[3] !== c.quaternion[3]) {
    const full = buildSolids(c)
    cached = { type: c.type, series: c.series, position: [...c.position], quaternion: [...c.quaternion],
      full, metal: c.type === 'inside-corner' || c.type === 't-nut' ? buildSolids(c, true) : full }
    shapeCache.set(c, cached)
  }
  return againstMetal ? cached.metal : cached.full
}

/** SAT for convex polyhedra. Touching surfaces and the stated tolerance are permitted. */
function overlap(a: Solid, b: Solid, tolerance: number): boolean {
  if (!a.bounds.intersectsBox(b.bounds)) return false
  const separated = (x: number, y: number, z: number, scale = 1): boolean => {
    let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity
    for (const v of a.vertices) {
      const p = v.x * x + v.y * y + v.z * z
      if (p < amin) amin = p
      if (p > amax) amax = p
    }
    for (const v of b.vertices) {
      const p = v.x * x + v.y * y + v.z * z
      if (p < bmin) bmin = p
      if (p > bmax) bmax = p
    }
    return Math.min(amax - bmin, bmax - amin) <= (tolerance + 1e-8) * scale
  }
  for (const axis of a.normals) if (separated(axis.x, axis.y, axis.z)) return false
  for (const axis of b.normals) if (separated(axis.x, axis.y, axis.z)) return false
  for (const u of a.edges) for (const v of b.edges) {
    const x = u.y * v.z - u.z * v.y, y = u.z * v.x - u.x * v.z, z = u.x * v.y - u.y * v.x
    const lengthSq = x * x + y * y + z * z
    if (lengthSq > 1e-8 && separated(x, y, z, Math.sqrt(lengthSq))) return false
  }
  return true
}

export function connectorsCollide(a: ConnectorData, b: ConnectorData): boolean {
  return solids(a).some((x) => solids(b).some((y) => overlap(x, y, 1)))
}

/** The nut's normal, along-slot axis and origin must match this member's slot face. */
function nutInSlot(c: ConnectorData, body: OBB): boolean {
  const q = new THREE.Quaternion(...c.quaternion).normalize()
  const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
  const along = new THREE.Vector3(0, 0, 1).applyQuaternion(q)
  if (Math.abs(along.dot(body.axes[2])) < 0.999) return false
  const delta = new THREE.Vector3(...c.position).sub(body.center)
  if (Math.abs(delta.dot(body.axes[2])) > body.half.z + 0.5) return false
  for (const i of [0, 1] as const) {
    const facing = normal.dot(body.axes[i])
    if (Math.abs(facing) < 0.999) continue
    if (Math.abs(delta.dot(body.axes[i]) - Math.sign(facing) * body.half.getComponent(i)) > 0.5) continue
    const across = 1 - i, offset = delta.dot(body.axes[across])
    if (slotOffsets(body.half.getComponent(across) * 2).some((slot) => Math.abs(offset - slot) <= 1)) return true
  }
  return false
}

/** Profiles use solid section envelopes, with the modeled slot inserts handled separately. */
export function connectorHitsBody(c: ConnectorData, body: OBB, tolerance = 3, againstMetal = true): boolean {
  const box = boxSolid(body)
  const excludeInserts = againstMetal && (c.type !== 't-nut' || nutInSlot(c, body))
  return solids(c, excludeInserts).some((part) => overlap(part, box, tolerance))
}
