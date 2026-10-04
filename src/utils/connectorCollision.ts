import * as THREE from 'three'
import type { ConnectorData } from '../store/useStore'
import { connectorMounts, connectorScale, insideCornerSection } from './connectorCatalog'
import { connectorMeshes } from './connectorGeometry'
import { profileSlotDimensions, slotOffsets } from './specUtils'
import { makeOBB, type OBB } from './obb'

interface Solid {
  vertices?: THREE.Vector3[]
  box?: OBB
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

function boxBounds({ center, half, axes }: OBB): THREE.Box3 {
  const rx = Math.abs(axes[0].x) * half.x + Math.abs(axes[1].x) * half.y + Math.abs(axes[2].x) * half.z
  const ry = Math.abs(axes[0].y) * half.x + Math.abs(axes[1].y) * half.y + Math.abs(axes[2].y) * half.z
  const rz = Math.abs(axes[0].z) * half.x + Math.abs(axes[1].z) * half.y + Math.abs(axes[2].z) * half.z
  return new THREE.Box3(new THREE.Vector3(center.x - rx, center.y - ry, center.z - rz),
    new THREE.Vector3(center.x + rx, center.y + ry, center.z + rz))
}

function boxSolid(box: OBB): Solid {
  return { box, normals: box.axes, edges: box.axes, bounds: boxBounds(box) }
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
  if (c.type === 'inside-corner') {
    const { depth, width } = insideCornerSection(c.series ?? 20)
    return [box([10, -depth / 2, 0], [10, depth / 2, width / 2]),
      box([-depth / 2, 10, 0], [depth / 2, 10, width / 2]),
      box([depth / 2, depth / 2, 0], [depth / 2, depth / 2, width / 2])]
  }
  if (c.type === 'corner-3way') return [box([10, 2, 0], [10, 2, 4]), box([2, 10, 0], [2, 10, 4]),
    box([2, 2, 5], [2, 2, 5]), box([0, 2, 15], [4, 2, 5]), box([0, 0, 0], [2, 2, 2])]
  // Only the parts outside the mounting face remain for a correctly aligned slot nut.
  if (c.type === 't-nut' && againstMetal) return [box([0, 1, 0], [9, 1, 3.5]), box([0, 5, 0], [2.5, 5, 2.5])]
  return componentBounds(c.type).map((bounds) => box(bounds.centre, bounds.half))
}

interface ShapeGeometry {
  type: string; series: ConnectorData['series']; position: number[]; quaternion: number[]; full: Solid[]; metal: Solid[]
  mounts?: { axis: THREE.Vector3; normal: THREE.Vector3; point: THREE.Vector3 }[]
}
const shapeCache = new WeakMap<ConnectorData, ShapeGeometry>()
function shapeGeometry(c: ConnectorData): ShapeGeometry {
  let cached = shapeCache.get(c)
  if (!cached || cached.type !== c.type || cached.series !== c.series
    || cached.position[0] !== c.position[0] || cached.position[1] !== c.position[1] || cached.position[2] !== c.position[2]
    || cached.quaternion[0] !== c.quaternion[0] || cached.quaternion[1] !== c.quaternion[1]
    || cached.quaternion[2] !== c.quaternion[2] || cached.quaternion[3] !== c.quaternion[3]) {
    const full = buildSolids(c)
    cached = { type: c.type, series: c.series, position: [...c.position], quaternion: [...c.quaternion],
      full, metal: c.type === 't-nut' ? buildSolids(c, true) : full }
    shapeCache.set(c, cached)
  }
  return cached
}
function solids(c: ConnectorData, againstMetal = false): Solid[] {
  const geometry = shapeGeometry(c)
  return againstMetal ? geometry.metal : geometry.full
}

type Slot = { face: 0 | 1; side: number; offset: number }
interface BodyGeometry {
  pose: number[]
  bounds: THREE.Box3
  axes?: OBB['axes']
  solid?: Solid
  slots?: [number[], number[]]
  cavities?: { slot: Slot; metal: Solid[] }[]
}
const bodyCache = new WeakMap<OBB, BodyGeometry>()
function sameVector(v: THREE.Vector3, pose: number[], offset: number): boolean {
  return v.x === pose[offset] && v.y === pose[offset + 1] && v.z === pose[offset + 2]
}

/** Keep transformed section geometry only while every OBB coordinate is unchanged. */
function bodyGeometry(body: OBB): BodyGeometry {
  let geometry = bodyCache.get(body)
  const { center, half, axes } = body
  if (!geometry || !sameVector(center, geometry.pose, 0) || !sameVector(half, geometry.pose, 3)
    || !sameVector(axes[0], geometry.pose, 6) || !sameVector(axes[1], geometry.pose, 9) || !sameVector(axes[2], geometry.pose, 12)) {
    geometry = { pose: [center.x, center.y, center.z, half.x, half.y, half.z,
      axes[0].x, axes[0].y, axes[0].z, axes[1].x, axes[1].y, axes[1].z, axes[2].x, axes[2].y, axes[2].z],
    bounds: boxBounds(body) }
    bodyCache.set(body, geometry)
  }
  return geometry
}

function bodyAxes(body: OBB, geometry: BodyGeometry): OBB['axes'] {
  return geometry.axes ??= body.axes.map((axis) => axis.clone()) as OBB['axes']
}

function bodySolid(body: OBB, geometry: BodyGeometry): Solid {
  const axes = bodyAxes(body, geometry)
  return geometry.solid ??= { box: { center: body.center.clone(), half: body.half.clone(), axes },
    normals: axes, edges: axes, bounds: geometry.bounds }
}

/** SAT for convex polyhedra. Touching surfaces and the stated tolerance are permitted. */
function overlap(a: Solid, b: Solid, tolerance: number): boolean {
  if (!a.bounds.intersectsBox(b.bounds)) return false
  const separated = (x: number, y: number, z: number, scale = 1): boolean => {
    let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity
    if (a.box) {
      const { center, half, axes } = a.box
      const middle = center.x * x + center.y * y + center.z * z
      const radius = Math.abs(axes[0].x * x + axes[0].y * y + axes[0].z * z) * half.x
        + Math.abs(axes[1].x * x + axes[1].y * y + axes[1].z * z) * half.y
        + Math.abs(axes[2].x * x + axes[2].y * y + axes[2].z * z) * half.z
      amin = middle - radius; amax = middle + radius
    } else for (const v of a.vertices!) {
      const p = v.x * x + v.y * y + v.z * z
      if (p < amin) amin = p
      if (p > amax) amax = p
    }
    if (b.box) {
      const { center, half, axes } = b.box
      const middle = center.x * x + center.y * y + center.z * z
      const radius = Math.abs(axes[0].x * x + axes[0].y * y + axes[0].z * z) * half.x
        + Math.abs(axes[1].x * x + axes[1].y * y + axes[1].z * z) * half.y
        + Math.abs(axes[2].x * x + axes[2].y * y + axes[2].z * z) * half.z
      bmin = middle - radius; bmax = middle + radius
    } else for (const v of b.vertices!) {
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

/** The actual mounting slot for an inside-corner arm on this particular member. */
function insideMountSlot(c: ConnectorData, body: OBB, shape: ShapeGeometry, member: BodyGeometry): Slot | null {
  if (!shape.mounts) {
    const q = new THREE.Quaternion(...c.quaternion).normalize(), k = connectorScale(c.series ?? 20)
    const origin = new THREE.Vector3(...c.position), axes = shape.full[0].normals
    const index = { x: 0, y: 1, z: 2 }
    shape.mounts = connectorMounts('inside-corner').map((mount) => ({ axis: axes[index[mount.axis]],
      normal: axes[index[mount.normal]], point: new THREE.Vector3(...mount.bolts[0]).multiplyScalar(k).applyQuaternion(q).add(origin) }))
  }
  for (const mount of shape.mounts) {
    if (Math.abs(mount.axis.dot(body.axes[2])) < 0.999) continue
    const dx = mount.point.x - body.center.x, dy = mount.point.y - body.center.y, dz = mount.point.z - body.center.z
    const length = body.axes[2]
    if (Math.abs(dx * length.x + dy * length.y + dz * length.z) > body.half.z + 0.5) continue
    for (const face of [0, 1] as const) {
      const normal = body.axes[face], facing = mount.normal.dot(normal)
      if (Math.abs(facing) < 0.999) continue
      const side = Math.sign(facing)
      if (Math.abs(dx * normal.x + dy * normal.y + dz * normal.z - side * body.half.getComponent(face)) > 0.5) continue
      const across = 1 - face, transverse = body.axes[across]
      const offset = dx * transverse.x + dy * transverse.y + dz * transverse.z
      member.slots ??= [slotOffsets(body.half.x * 2), slotOffsets(body.half.y * 2)]
      const slot = member.slots[across].find((at) => Math.abs(offset - at) <= 1)
      if (slot !== undefined) return { face, side, offset: slot }
    }
  }
  return null
}

/** Subtract one rectangular slot cavity from the trimmed member, retaining its metal walls. */
function slottedMember(body: OBB, slot: Slot, geometry: BodyGeometry): Solid[] {
  const cached = geometry.cavities?.find((entry) => entry.slot.face === slot.face && entry.slot.side === slot.side && entry.slot.offset === slot.offset)
  if (cached) return cached.metal
  const { face, side, offset } = slot, across = 1 - face
  const axes = bodyAxes(body, geometry)
  const { width, depth } = profileSlotDimensions(body.half.x * 2)
  const h = body.half.getComponent(face), a = body.half.getComponent(across)
  const piece = (lo: number[], hi: number[]): Solid | null => {
    const half = new THREE.Vector3(...hi).sub(new THREE.Vector3(...lo)).multiplyScalar(0.5)
    if (half.x <= 0 || half.y <= 0 || half.z <= 0) return null
    const center = body.center.clone()
    for (let i = 0; i < 3; i++) center.addScaledVector(body.axes[i], (lo[i] + hi[i]) / 2)
    return boxSolid({ center, half, axes })
  }
  const low = [-body.half.x, -body.half.y, -body.half.z], high = [body.half.x, body.half.y, body.half.z]
  const coreLow = [...low], coreHigh = [...high]
  if (side > 0) coreHigh[face] = h - depth
  else coreLow[face] = -h + depth
  const pieces = [piece(coreLow, coreHigh)]
  for (const [from, to] of [[-a, offset - width / 2], [offset + width / 2, a]]) {
    const lo = [...low], hi = [...high]
    if (side > 0) lo[face] = h - depth
    else hi[face] = -h + depth
    lo[across] = Math.max(-a, from)
    hi[across] = Math.min(a, to)
    pieces.push(piece(lo, hi))
  }
  const metal = pieces.filter((part): part is Solid => part !== null)
  ;(geometry.cavities ??= []).push({ slot, metal })
  return metal
}

/** Profiles use solid section envelopes, with the modeled slot inserts handled separately. */
export function connectorHitsBody(c: ConnectorData, body: OBB, tolerance = 3, againstMetal = true): boolean {
  const member = bodyGeometry(body), shape = shapeGeometry(c)
  if (!shape.full.some((part) => part.bounds.intersectsBox(member.bounds))) return false
  if (againstMetal && c.type === 'inside-corner') {
    const parts = shape.full, slot = insideMountSlot(c, body, shape, member)
    if (slot) {
      // Contact tolerance must not conceal an insert crossing a slot side or floor.
      const metal = slottedMember(body, slot, member)
      return parts.some((part) => metal.some((wall) => overlap(part, wall, 0)))
    }
    return parts.some((part) => overlap(part, bodySolid(body, member), tolerance))
  }
  const excludeInserts = againstMetal && (c.type !== 't-nut' || nutInSlot(c, body))
  return (excludeInserts ? shape.metal : shape.full).some((part) => overlap(part, bodySolid(body, member), tolerance))
}
