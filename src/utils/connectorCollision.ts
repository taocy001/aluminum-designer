import * as THREE from 'three'
import type { ConnectorData, ProfileSpec } from '../store/useStore'
import { connectorScale } from './connectorCatalog'
import { connectorMeshes } from './connectorGeometry'
import { getProfileShape } from './profileShapes'
import { makeOBB, type OBB } from './obb'

interface Solid {
  vertices?: THREE.Vector3[]
  box?: OBB
  normals: THREE.Vector3[]
  edges: THREE.Vector3[]
  bounds: THREE.Box3
}
type V3 = [number, number, number]

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

function polySolid(vertices: THREE.Vector3[]): Solid {
  const edges: THREE.Vector3[] = [], normals: THREE.Vector3[] = []
  const add = (list: THREE.Vector3[], v: THREE.Vector3) => {
    if (v.lengthSq() < 1e-12) return
    v.normalize()
    if (!list.some((x) => Math.abs(x.dot(v)) > 0.99999)) list.push(v)
  }
  for (let i = 0; i < vertices.length; i++) for (let j = i + 1; j < vertices.length; j++) {
    const edge = vertices[j].clone().sub(vertices[i]); add(edges, edge.clone())
    for (let k = j + 1; k < vertices.length; k++) add(normals, new THREE.Vector3().crossVectors(edge, vertices[k].clone().sub(vertices[i])))
  }
  return { vertices, normals, edges, bounds: new THREE.Box3().setFromPoints(vertices) }
}

/** Mesh producers expose convex pieces in the same local coordinates as the visible part. */
function buildSolids(c: ConnectorData): Solid[] {
  const q = new THREE.Quaternion(...c.quaternion).normalize(), k = connectorScale(c.series ?? 20)
  const position = new THREE.Vector3(...c.position)
  const point = (v: V3) => new THREE.Vector3(...v).multiplyScalar(k).applyQuaternion(q).add(position)
  const box = (centre: V3, half: V3) => boxSolid(makeOBB(point(centre), new THREE.Vector3(...half).multiplyScalar(k), q))
  return connectorMeshes(c.type, c.series, c.profileSpec, c.mountSeries).filter((mesh) => !mesh.visualOnly).flatMap((mesh) => {
    if (mesh.collisionParts) return mesh.collisionParts.map((part) => 'vertices' in part
      ? polySolid(part.vertices.map((v) => point(v as V3))) : box(part.centre, part.half))
    if (mesh.collisionVertices) return [polySolid(mesh.collisionVertices.map((v) => point(v as V3)))]
    if (mesh.collisionBoxes) return mesh.collisionBoxes.map((b) => box(b.centre, b.half))
    mesh.geometry.computeBoundingBox()
    const bounds = mesh.geometry.boundingBox!
    return [box(bounds.getCenter(new THREE.Vector3()).toArray(), bounds.getSize(new THREE.Vector3()).multiplyScalar(0.5).toArray())]
  })
}

interface ShapeGeometry {
  type: string; series: ConnectorData['series']; profileSpec: ConnectorData['profileSpec']; mountSeries: string; position: number[]; quaternion: number[]; full: Solid[]; metal: Solid[]
  mounts?: { axis: THREE.Vector3; normal: THREE.Vector3; point: THREE.Vector3 }[]
  bodyHits: Map<string, boolean>
}
const shapeCache = new WeakMap<ConnectorData, ShapeGeometry>()
function shapeGeometry(c: ConnectorData): ShapeGeometry {
  let cached = shapeCache.get(c)
  if (!cached || cached.type !== c.type || cached.series !== c.series || cached.profileSpec !== c.profileSpec
    || cached.mountSeries !== (c.mountSeries?.join(':') ?? '')
    || cached.position[0] !== c.position[0] || cached.position[1] !== c.position[1] || cached.position[2] !== c.position[2]
    || cached.quaternion[0] !== c.quaternion[0] || cached.quaternion[1] !== c.quaternion[1]
    || cached.quaternion[2] !== c.quaternion[2] || cached.quaternion[3] !== c.quaternion[3]) {
    const full = buildSolids(c)
    cached = { type: c.type, series: c.series, profileSpec: c.profileSpec, mountSeries: c.mountSeries?.join(':') ?? '', position: [...c.position], quaternion: [...c.quaternion],
      full, metal: full, bodyHits: new Map() }
    shapeCache.set(c, cached)
  }
  return cached
}
function solids(c: ConnectorData, againstMetal = false): Solid[] {
  const geometry = shapeGeometry(c)
  return againstMetal ? geometry.metal : geometry.full
}

interface BodyGeometry {
  pose: number[]
  bounds: THREE.Box3
  axes?: OBB['axes']
  solid?: Solid
  slots?: [number[], number[]]
  metal?: Solid[]
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

const sectionTriangles = new Map<ProfileSpec, THREE.Vector2[][]>()
const metalByPose = new Map<string, Solid[]>()

/** Extrude the rendered section's triangulation, including slot undercuts and core holes. */
function profileMetal(body: OBB, cache: BodyGeometry): Solid[] {
  if (cache.metal) return cache.metal
  const width = Math.round(body.half.x * 2), height = Math.round(body.half.y * 2)
  const spec = `${width}${height}` as ProfileSpec
  if (!['2020', '2040', '3030', '3040', '4040'].includes(spec)) return [bodySolid(body, cache)]
  const key = cache.pose.join(':')
  const saved = metalByPose.get(key)
  if (saved) return cache.metal = saved
  let triangles = sectionTriangles.get(spec)
  if (!triangles) {
    const shape = getProfileShape(spec).extractPoints(6)
    for (const ring of [shape.shape, ...shape.holes]) if (ring.length > 1 && ring[0].equals(ring[ring.length - 1])) ring.pop()
    const points = [...shape.shape, ...shape.holes.flat()]
    triangles = THREE.ShapeUtils.triangulateShape(shape.shape, shape.holes).map((tri) => tri.map((i) => points[i]))
    sectionTriangles.set(spec, triangles)
  }
  cache.metal = triangles.map((tri): Solid => {
    const vertices = [-body.half.z, body.half.z].flatMap((z) => tri.map((p) =>
      body.center.clone().addScaledVector(body.axes[0], p.x)
        .addScaledVector(body.axes[1], p.y).addScaledVector(body.axes[2], z)))
    // A triangular prism has three in-plane edge directions and one extrusion axis.
    const axis = body.axes[2].clone()
    const sides = [0, 1, 2].map((i) => vertices[(i + 1) % 3].clone().sub(vertices[i]).normalize())
    return { vertices, edges: [...sides, axis], normals: [axis, ...sides.map((e) => new THREE.Vector3().crossVectors(e, axis).normalize())],
      bounds: new THREE.Box3().setFromPoints(vertices) }
  })
  // Door-motion checks rebuild profile OBBs. Reuse unchanged poses with bounded memory.
  if (metalByPose.size >= 256) metalByPose.delete(metalByPose.keys().next().value!)
  metalByPose.set(key, cache.metal)
  return cache.metal
}

/** Profile metal follows its visible section; panel/equipment checks use complete solid bounds. */
export function connectorHitsBody(c: ConnectorData, body: OBB, tolerance = 0.15, againstMetal = true): boolean {
  const member = bodyGeometry(body), shape = shapeGeometry(c)
  if (!shape.full.some((part) => part.bounds.intersectsBox(member.bounds))) return false
  // Rebuilt OBBs often describe the same cut profile during suggestion and door
  // checks. All body coordinates, clearance and material mode belong to the key;
  // changing any connector coordinate replaces shapeGeometry and this cache.
  const key = `${againstMetal}:${tolerance}:${member.pose.join(':')}`
  const previous = shape.bodyHits.get(key)
  if (previous !== undefined) return previous
  const metal = againstMetal ? profileMetal(body, member) : [bodySolid(body, member)]
  // The M8 envelope may overlap only its coaxial 3030/4040 tapping pilot. The foot's
  // locknut/base, other members and non-metal obstacles retain normal clearance.
  const origin = new THREE.Vector3(...c.position), into = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(...c.quaternion).normalize())
  const delta = origin.clone().sub(body.center)
  const tappedFootHost = againstMetal && c.type === 'foot' && (c.series === 30 || c.series === 40)
    && Math.abs(body.half.x - c.series / 2) < 1e-6 && Math.abs(body.half.y - c.series / 2) < 1e-6
    && Math.abs(delta.dot(body.axes[0])) < 1e-5 && Math.abs(delta.dot(body.axes[1])) < 1e-5
    && Math.abs(Math.abs(delta.dot(body.axes[2])) - body.half.z) < 1e-5
    && Math.abs(into.dot(body.axes[2])) > .999999 && into.dot(delta) < 0
  const q = new THREE.Quaternion(...c.quaternion).normalize()
  const capNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(q)
  const capX = new THREE.Vector3(1, 0, 0).applyQuaternion(q)
  const capSpec = c.profileSpec ?? `${c.series ?? 20}${c.series ?? 20}`
  const pressFitCapHost = againstMetal && c.type === 'end-cap' && capSpec !== '3040'
    && capSpec === `${Math.round(body.half.x * 2)}${Math.round(body.half.y * 2)}`
    && Math.abs(delta.dot(body.axes[0])) < 1e-5 && Math.abs(delta.dot(body.axes[1])) < 1e-5
    && Math.abs(Math.abs(delta.dot(body.axes[2])) - body.half.z) < 1e-5
    && Math.abs(capNormal.dot(body.axes[2])) > .999999 && capNormal.dot(delta) > 0
    && (Math.abs(capX.dot(body.axes[0])) > .999999
      || (body.half.x === body.half.y && Math.abs(capX.dot(body.axes[1])) > .999999))
  // Retention ribs of the matching plastic cap interfere with the core by up to
  // 0.6 mm in the manufacturer CAD. Only those inserted pieces permit press fit;
  // the cover plate (piece 0) and unrelated obstacles keep normal clearance.
  const hit = shape.full.some((part, i) => metal.some((wall) => overlap(part, wall,
    tappedFootHost && i === 0 ? .85 : pressFitCapHost && i > 0 ? .65 : tolerance)))
  if (shape.bodyHits.size >= 128) shape.bodyHits.delete(shape.bodyHits.keys().next().value!)
  shape.bodyHits.set(key, hit)
  return hit
}
