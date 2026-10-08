import { panelMountBoardFits } from './panelMounts'
import * as THREE from 'three'
import type { ConnectorData, ProfileSpec } from '../store/useStore'
import { connectorScale } from './connectorCatalog'
import { connectorMeshes } from './connectorGeometry'
import { ALL_SPECS } from './specUtils'
import { getProfileShape } from './profileShapes'
import { makeOBB, type OBB } from './obb'

interface Solid {
  panelShaft?: boolean
  pressFit?: boolean
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

interface LocalPoly {
  coordinates: number[][]
  scale: number
  solid: Solid
}
const localPolys = new WeakMap<readonly (readonly number[])[], LocalPoly>()

/** A rigid transform rotates SAT axes without changing their local construction. */
function transformedPoly(points: readonly (readonly number[])[], scale: number,
  rotation: THREE.Quaternion, position: THREE.Vector3): Solid {
  let cached = localPolys.get(points)
  if (!cached || cached.scale !== scale || cached.coordinates.length !== points.length
    || points.some((point, i) => point[0] !== cached!.coordinates[i][0]
      || point[1] !== cached!.coordinates[i][1] || point[2] !== cached!.coordinates[i][2])) {
    cached = { scale, coordinates: points.map((point) => [point[0], point[1], point[2]]),
      solid: polySolid(points.map((point) => new THREE.Vector3(point[0], point[1], point[2]).multiplyScalar(scale))) }
    localPolys.set(points, cached)
  }
  const vertices = cached.solid.vertices!.map((v) => v.clone().applyQuaternion(rotation).add(position))
  return { vertices, normals: cached.solid.normals.map((v) => v.clone().applyQuaternion(rotation)),
    edges: cached.solid.edges.map((v) => v.clone().applyQuaternion(rotation)),
    bounds: new THREE.Box3().setFromPoints(vertices) }
}

/** Mesh producers expose convex pieces in the same local coordinates as the visible part. */
function buildSolids(c: ConnectorData): Solid[] {
  const q = new THREE.Quaternion(...c.quaternion).normalize(), k = connectorScale(c.series ?? 20)
  const position = new THREE.Vector3(...c.position)
  const point = (v: V3) => new THREE.Vector3(...v).multiplyScalar(k).applyQuaternion(q).add(position)
  const box = (centre: V3, half: V3) => boxSolid(makeOBB(point(centre), new THREE.Vector3(...half).multiplyScalar(k), q))
  return connectorMeshes(c.type, c.series, c.profileSpec, c.mountSeries, c.panelMount).filter((mesh) => !mesh.visualOnly).flatMap((mesh) => {
    if (mesh.collisionParts) return mesh.collisionParts.map((part) => ({
      ...('vertices' in part ? transformedPoly(part.vertices, k, q, position) : box(part.centre, part.half)),
      pressFit: part.pressFit,
    }))
    if (mesh.collisionVertices) return [transformedPoly(mesh.collisionVertices, k, q, position)]
    if (mesh.collisionBoxes) return mesh.collisionBoxes.map((b) => box(b.centre, b.half))
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    const bounds = mesh.geometry.boundingBox!
    return [{ ...box(bounds.getCenter(new THREE.Vector3()).toArray(), bounds.getSize(new THREE.Vector3()).multiplyScalar(0.5).toArray()), panelShaft: mesh.panelShaft }]
  })
}

interface ShapeGeometry {
  type: string; series: ConnectorData['series']; profileSpec: ConnectorData['profileSpec']; mountSeries: string; position: number[]; quaternion: number[]; full: Solid[]; metal: Solid[]
  panelMount?: ConnectorData['panelMount']
  bounds: THREE.Box3
  mounts?: { axis: THREE.Vector3; normal: THREE.Vector3; point: THREE.Vector3 }[]
  bodyHits: Map<string, boolean>
}
const shapeCache = new WeakMap<ConnectorData, ShapeGeometry>()
function shapeGeometry(c: ConnectorData): ShapeGeometry {
  let cached = shapeCache.get(c)
  if (!cached || cached.type !== c.type || cached.series !== c.series || cached.profileSpec !== c.profileSpec
    || !!cached.panelMount !== !!c.panelMount
    || cached.panelMount?.mode !== c.panelMount?.mode
    || cached.panelMount?.spacer !== c.panelMount?.spacer
    || cached.panelMount?.boardThickness !== c.panelMount?.boardThickness
    || cached.panelMount?.panelId !== c.panelMount?.panelId
    || cached.panelMount?.profileId !== c.panelMount?.profileId
    || cached.mountSeries !== (c.mountSeries?.join(':') ?? '')
    || cached.position[0] !== c.position[0] || cached.position[1] !== c.position[1] || cached.position[2] !== c.position[2]
    || cached.quaternion[0] !== c.quaternion[0] || cached.quaternion[1] !== c.quaternion[1]
    || cached.quaternion[2] !== c.quaternion[2] || cached.quaternion[3] !== c.quaternion[3]) {
    const full = buildSolids(c)
    cached = { type: c.type, series: c.series, profileSpec: c.profileSpec, mountSeries: c.mountSeries?.join(':') ?? '', position: [...c.position], quaternion: [...c.quaternion],
      panelMount: c.panelMount ? { ...c.panelMount } : undefined, full, metal: full, bodyHits: new Map(),
      bounds: full.reduce((bounds, part) => bounds.union(part.bounds), new THREE.Box3()) }
    shapeCache.set(c, cached)
  }
  return cached
}
interface BodyGeometry {
  profileSpec?: ProfileSpec
  pose: number[]
  bounds: THREE.Box3
  axes?: OBB['axes']
  solid?: Solid
  slots?: [number[], number[]]
  metal?: SectionMetal
}
const bodyCache = new WeakMap<OBB, BodyGeometry>()
function sameVector(v: THREE.Vector3, pose: number[], offset: number): boolean {
  return v.x === pose[offset] && v.y === pose[offset + 1] && v.z === pose[offset + 2]
}

/** Keep transformed section geometry only while every OBB coordinate is unchanged. */
function bodyGeometry(body: OBB): BodyGeometry {
  let geometry = bodyCache.get(body)
  const { center, half, axes } = body
  if (!geometry || geometry.profileSpec !== body.profileSpec || !sameVector(center, geometry.pose, 0) || !sameVector(half, geometry.pose, 3)
    || !sameVector(axes[0], geometry.pose, 6) || !sameVector(axes[1], geometry.pose, 9) || !sameVector(axes[2], geometry.pose, 12)) {
    geometry = { profileSpec: body.profileSpec, pose: [center.x, center.y, center.z, half.x, half.y, half.z,
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
  const first = shapeGeometry(a), second = shapeGeometry(b)
  // Most fasteners are far apart. Reject disjoint whole-part bounds before
  // visiting their convex pieces; overlapping bounds still use the same SAT.
  return first.bounds.intersectsBox(second.bounds)
    && first.full.some((x) => second.full.some((y) => overlap(x, y, 1)))
}

const sectionTriangles = new Map<ProfileSpec, THREE.Vector2[][]>()
interface SectionMetal {
  triangles: THREE.Vector2[][]
  bounds: Float64Array
  solids: (Solid | undefined)[]
}
const metalByPose = new Map<string, SectionMetal>()

/** Cache conservative prism bounds; construct exact solids only near the connector. */
function profileMetal(body: OBB, cache: BodyGeometry, parts: Solid[]): Solid[] {
  let section = cache.metal
  if (!section) {
    const width = Math.round(body.half.x * 2), height = Math.round(body.half.y * 2)
    const spec = body.profileSpec ?? `${width}${height}` as ProfileSpec
    if (!ALL_SPECS.includes(spec)) return [bodySolid(body, cache)]
    const key = `${spec}:${cache.pose.join(':')}`
    section = metalByPose.get(key)
    if (!section) {
      let triangles = sectionTriangles.get(spec)
      if (!triangles) {
        const shape = getProfileShape(spec).extractPoints(6)
        for (const ring of [shape.shape, ...shape.holes]) if (ring.length > 1 && ring[0].equals(ring[ring.length - 1])) ring.pop()
        const points = [...shape.shape, ...shape.holes.flat()]
        triangles = THREE.ShapeUtils.triangulateShape(shape.shape, shape.holes).map((tri) => tri.map((i) => points[i]))
        sectionTriangles.set(spec, triangles)
      }
      const bounds = new Float64Array(triangles.length * 6)
      const { center, axes, half } = body
      for (let i = 0; i < triangles.length; i++) {
        const offset = i * 6
        bounds[offset] = bounds[offset + 1] = bounds[offset + 2] = Infinity
        bounds[offset + 3] = bounds[offset + 4] = bounds[offset + 5] = -Infinity
        // Use the same six vertices and operation order as the exact prism.
        for (let end = -1; end <= 1; end += 2) for (const p of triangles[i]) {
          const z = half.z * end
          const x = ((center.x + axes[0].x * p.x) + axes[1].x * p.y) + axes[2].x * z
          const y = ((center.y + axes[0].y * p.x) + axes[1].y * p.y) + axes[2].y * z
          const w = ((center.z + axes[0].z * p.x) + axes[1].z * p.y) + axes[2].z * z
          bounds[offset] = Math.min(bounds[offset], x)
          bounds[offset + 1] = Math.min(bounds[offset + 1], y)
          bounds[offset + 2] = Math.min(bounds[offset + 2], w)
          bounds[offset + 3] = Math.max(bounds[offset + 3], x)
          bounds[offset + 4] = Math.max(bounds[offset + 4], y)
          bounds[offset + 5] = Math.max(bounds[offset + 5], w)
        }
      }
      section = { triangles, bounds, solids: new Array(triangles.length) }
      // Door-motion checks rebuild OBBs. Keep a bounded set of unchanged poses.
      if (metalByPose.size >= 256) metalByPose.delete(metalByPose.keys().next().value!)
      metalByPose.set(key, section)
    }
    cache.metal = section
  }
  const metal: Solid[] = [], { bounds } = section
  for (let i = 0; i < section.triangles.length; i++) {
    const offset = i * 6
    // Expand only this prefilter. The final AABB and SAT keep their original
    // tests, including negative clearance and host-specific fit tolerances.
    const nearby = parts.some(({ bounds: other }) => !(other.max.x < bounds[offset] - 1e-8
      || other.min.x > bounds[offset + 3] + 1e-8 || other.max.y < bounds[offset + 1] - 1e-8
      || other.min.y > bounds[offset + 4] + 1e-8 || other.max.z < bounds[offset + 2] - 1e-8
      || other.min.z > bounds[offset + 5] + 1e-8))
    if (!nearby) continue
    let solid = section.solids[i]
    if (!solid) {
      const tri = section.triangles[i]
      const vertices = [-body.half.z, body.half.z].flatMap((z) => tri.map((p) =>
        body.center.clone().addScaledVector(body.axes[0], p.x)
          .addScaledVector(body.axes[1], p.y).addScaledVector(body.axes[2], z)))
      const axis = body.axes[2].clone()
      const sides = [0, 1, 2].map((j) => vertices[(j + 1) % 3].clone().sub(vertices[j]).normalize())
      solid = { vertices, edges: [...sides, axis], normals: [axis, ...sides.map((e) => new THREE.Vector3().crossVectors(e, axis).normalize())],
        bounds: new THREE.Box3().setFromPoints(vertices) }
      section.solids[i] = solid
    }
    metal.push(solid)
  }
  return metal
}

/** Profile metal follows its visible section; panel/equipment checks use complete solid bounds. */
export function connectorHitsBody(c: ConnectorData, body: OBB, tolerance = 0.15, againstMetal = true, bodyId?: string): boolean {
  const member = bodyGeometry(body), shape = shapeGeometry(c)
  if (!shape.full.some((part) => part.bounds.intersectsBox(member.bounds))) return false
  // Rebuilt OBBs often describe the same cut profile during suggestion and door
  // checks. All body coordinates, clearance and material mode belong to the key;
  // changing any connector coordinate replaces shapeGeometry and this cache.
  // Only the matching board's drilled hole depends on identity. Fresh candidate
  // IDs with identical solid geometry must reuse the same collision result.
  const panelHost = !againstMetal && !!bodyId && c.panelMount?.panelId === bodyId
  const key = `${panelHost}:${againstMetal}:${tolerance}:${body.profileSpec ?? ''}:${member.pose.join(':')}`
  const previous = shape.bodyHits.get(key)
  if (previous !== undefined) return previous
  const metal = againstMetal ? profileMetal(body, member, shape.full) : [bodySolid(body, member)]
  // Only the foot stud or caster fixing screw may overlap its coaxial M8 tapping
  // pilot. Their remaining parts and unrelated bodies retain normal clearance.
  const origin = new THREE.Vector3(...c.position), into = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(...c.quaternion).normalize())
  const delta = origin.clone().sub(body.center)
  const tappedFootHost = againstMetal && (c.type === 'foot' || c.type === 'caster-mount') && (c.series === 30 || c.series === 40)
    && body.profileSpec !== '4040-B6'
    && Math.abs(body.half.x - c.series / 2) < 1e-6 && Math.abs(body.half.y - c.series / 2) < 1e-6
    && Math.abs(delta.dot(body.axes[0])) < 1e-5 && Math.abs(delta.dot(body.axes[1])) < 1e-5
    && Math.abs(Math.abs(delta.dot(body.axes[2])) - body.half.z) < 1e-5
    && Math.abs(into.dot(body.axes[2])) > .999999 && into.dot(delta) < 0
  const q = new THREE.Quaternion(...c.quaternion).normalize()
  const adapterHost = againstMetal && c.type === 'foot' && c.series === 20 && c.profileSpec === '4040-B6'
    && body.profileSpec === '4040-B6'
    && Math.abs(delta.dot(body.axes[0])) < 1e-5 && Math.abs(delta.dot(body.axes[1])) < 1e-5
    && Math.abs(Math.abs(delta.dot(body.axes[2])) - body.half.z) < 1e-5
    && Math.abs(into.dot(body.axes[2])) > .999999 && into.dot(delta) < 0
    && (Math.abs(new THREE.Vector3(1, 0, 0).applyQuaternion(q).dot(body.axes[0])) > .999999
      || Math.abs(new THREE.Vector3(1, 0, 0).applyQuaternion(q).dot(body.axes[1])) > .999999)
  const capNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(q)
  const capX = new THREE.Vector3(1, 0, 0).applyQuaternion(q)
  const capSpec = c.profileSpec ?? `${c.series ?? 20}${c.series ?? 20}`
  const pressFitCapHost = againstMetal && c.type === 'end-cap' && capSpec !== '3040'
    && capSpec === (body.profileSpec ?? `${Math.round(body.half.x * 2)}${Math.round(body.half.y * 2)}`)
    && Math.abs(delta.dot(body.axes[0])) < 1e-5 && Math.abs(delta.dot(body.axes[1])) < 1e-5
    && Math.abs(Math.abs(delta.dot(body.axes[2])) - body.half.z) < 1e-5
    && Math.abs(capNormal.dot(body.axes[2])) > .999999 && capNormal.dot(delta) > 0
    && (Math.abs(capX.dot(body.axes[0])) > .999999
      || (body.half.x === body.half.y && Math.abs(capX.dot(body.axes[1])) > .999999))
  // Retention ribs of the matching plastic cap interfere with the core by up to
  // 0.6 mm in the manufacturer CAD. Only those inserted pieces permit press fit;
  // every cover plate and unrelated obstacle keeps normal clearance.
  const boardHole = panelHost && panelMountBoardFits(c, body)
  const hit = shape.full.some((part, i) => !(part.panelShaft && boardHole) && metal.some((wall) => overlap(part, wall,
    tappedFootHost && i === 0 ? .85 : adapterHost && i < 8 && i % 2 === 0 ? .4 : pressFitCapHost && part.pressFit ? .65 : tolerance)))
  if (shape.bodyHits.size >= 128) shape.bodyHits.delete(shape.bodyHits.keys().next().value!)
  shape.bodyHits.set(key, hit)
  return hit
}
