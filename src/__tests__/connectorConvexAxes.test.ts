import { expect, it } from 'vitest'
import * as THREE from 'three'
import type { ConnectorData } from '../store/useStore'
import { connectorScale } from '../utils/connectorCatalog'
import { connectorMeshes } from '../utils/connectorGeometry'
import { connectorHitsBody } from '../utils/connectorCollision'
import { makeOBB, obbCorners, type OBB } from '../utils/obb'

type Convex = { vertices: THREE.Vector3[]; edges: THREE.Vector3[]; normals: THREE.Vector3[] }
// The reference derives axes after the complete world transform, without using
// cached local directions. Its tolerance and degeneracy thresholds match SAT.
function worldConvex(vertices: THREE.Vector3[]): Convex {
  const edges: THREE.Vector3[] = [], normals: THREE.Vector3[] = []
  const add = (list: THREE.Vector3[], axis: THREE.Vector3) => {
    if (axis.lengthSq() < 1e-12) return
    axis.normalize()
    if (!list.some((previous) => Math.abs(previous.dot(axis)) > .99999)) list.push(axis)
  }
  for (let i = 0; i < vertices.length; i++) for (let j = i + 1; j < vertices.length; j++) {
    const edge = vertices[j].clone().sub(vertices[i]); add(edges, edge.clone())
    for (let k = j + 1; k < vertices.length; k++) add(normals,
      new THREE.Vector3().crossVectors(edge, vertices[k].clone().sub(vertices[i])))
  }
  return { vertices, edges, normals }
}
function referenceSolids(connector: ConnectorData): Convex[] {
  const scale = connectorScale(connector.series ?? 20), q = new THREE.Quaternion(...connector.quaternion).normalize()
  const point = (v: readonly number[]) => new THREE.Vector3(...v).multiplyScalar(scale).applyQuaternion(q).add(new THREE.Vector3(...connector.position))
  const box = (centre: readonly number[], half: readonly number[]): Convex => {
    const obb = makeOBB(point(centre), new THREE.Vector3(...half).multiplyScalar(scale), q)
    return { vertices: obbCorners(obb), normals: obb.axes, edges: obb.axes }
  }
  return connectorMeshes(connector.type, connector.series, connector.profileSpec, connector.mountSeries)
    .filter((mesh) => !mesh.visualOnly).flatMap((mesh) => {
      if (mesh.collisionParts) return mesh.collisionParts.map((part) => 'vertices' in part
        ? worldConvex(part.vertices.map(point)) : box(part.centre, part.half))
      if (mesh.collisionVertices) return [worldConvex(mesh.collisionVertices.map(point))]
      if (mesh.collisionBoxes) return mesh.collisionBoxes.map((b) => box(b.centre, b.half))
      mesh.geometry.computeBoundingBox()
      const bounds = mesh.geometry.boundingBox!
      return [box(bounds.getCenter(new THREE.Vector3()).toArray(), bounds.getSize(new THREE.Vector3()).multiplyScalar(.5).toArray())]
    })
}
function referenceHit(shape: Convex, body: OBB, tolerance: number): boolean {
  const other = obbCorners(body), axes = [...shape.normals, ...body.axes]
  for (const a of shape.edges) for (const b of body.axes) {
    const cross = a.clone().cross(b)
    if (cross.lengthSq() > 1e-8) axes.push(cross)
  }
  return axes.every((axis) => {
    const left = shape.vertices.map((v) => v.dot(axis)), right = other.map((v) => v.dot(axis))
    return Math.min(Math.max(...left) - Math.min(...right), Math.max(...right) - Math.min(...left))
      > (tolerance + 1e-8) * axis.length()
  })
}

it('matches world-derived convex axes for real connector CAD under rigid transforms and clearance boundaries', () => {
  for (const type of ['inside-corner', 'bracket', 't-nut']) for (const series of [20, 30, 40] as const) {
    for (let rotation = 0; rotation < 3; rotation++) {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rotation * .31, rotation * -.47, rotation * .73))
      const position = new THREE.Vector3(rotation * 137.1, rotation * -283.2, rotation * 411.3)
      const connector: ConnectorData = { id: 'convex', type, series, position: position.toArray(), quaternion: q.toArray() }
      if (type === 'inside-corner' && series === 30) connector.mountSeries = [30, 40]
      const shapes = referenceSolids(connector)
      for (const shape of shapes) {
        const bounds = new THREE.Box3().setFromPoints(shape.vertices), centre = bounds.getCenter(new THREE.Vector3())
        for (const offset of [-.15001, -.15, -.14999, 0, .15]) {
          const body = makeOBB(new THREE.Vector3(bounds.max.x + .3 + offset, centre.y, centre.z),
            new THREE.Vector3(.3, 1.7, 2.1), new THREE.Quaternion())
          for (const tolerance of [0, .15, 1]) expect(connectorHitsBody(connector, body, tolerance, false),
            `${type}/${series}/${rotation}/${offset}/${tolerance}`).toBe(shapes.some((part) => referenceHit(part, body, tolerance)))
        }
        const body = makeOBB(centre, new THREE.Vector3(.6, .7, .8), q)
        expect(connectorHitsBody(connector, body, 0, false)).toBe(shapes.some((part) => referenceHit(part, body, 0)))
      }
    }
  }
})

it('refreshes local axes when a source convex piece changes in place', () => {
  const mesh = connectorMeshes('inside-corner', 20).find((item) => item.collisionVertices)!
  const points = mesh.collisionVertices!
  const original = points.map((point) => [...point])
  const connector = (): ConnectorData => ({ id: 'mutated-solid', type: 'inside-corner', series: 20,
    position: [0, 0, 0], quaternion: [0, 0, 0, 1] })
  const body = makeOBB(new THREE.Vector3(100, 100, 100), new THREE.Vector3(1, 1, 1), new THREE.Quaternion())
  try {
    expect(connectorHitsBody(connector(), body, 0, false)).toBe(false)
    const centre = new THREE.Box3().setFromPoints(points.map((p) => new THREE.Vector3(...p))).getCenter(new THREE.Vector3())
    for (const point of points) for (let axis = 0; axis < 3; axis++) point[axis] += 100 - centre.getComponent(axis)
    expect(connectorHitsBody(connector(), body, 0, false)).toBe(true)
  } finally {
    for (let i = 0; i < points.length; i++) points[i].splice(0, 3, ...original[i])
  }
  expect(connectorHitsBody(connector(), body, 0, false)).toBe(false)
})

it('checks newly visited slot walls after clear queries and refreshes changed profile poses', () => {
  const specs = [['2020', 20], ['3030', 30], ['4040', 40], ['4040-B6', 20]] as const
  for (const [spec, series] of specs) for (const rotation of [0, 1]) {
    const half = Number(spec.slice(0, 2)) / 2
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rotation * .7, rotation * -.4, rotation * .2))
    const centre = new THREE.Vector3(107.2, -203.1, 307.3)
    const body = makeOBB(centre.clone(), new THREE.Vector3(half, half, 50), q)
    body.profileSpec = spec
    for (let face = 0; face < 4; face++) {
      const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), face * Math.PI / 2)
      const orientation = q.clone().multiply(turn)
      const at = (side: number, depth: number, end = 0): ConnectorData => ({
        id: `slot-${spec}-${face}`, type: 't-nut', series,
        position: new THREE.Vector3((spec === '4040-B6' ? 10 : 0) + side, half + depth, end)
          .applyQuaternion(turn).applyQuaternion(q).add(centre).toArray(),
        quaternion: orientation.toArray(),
      })
      // One clear face must not mark unbuilt prisms elsewhere as already checked.
      expect(connectorHitsBody(at(0, 0), body), `${spec}/${face}/seated`).toBe(false)
      expect(connectorHitsBody(at(2, 0), body), `${spec}/${face}/lip`).toBe(true)
      expect(connectorHitsBody(at(0, -2), body), `${spec}/${face}/bottom`).toBe(true)
      expect(connectorHitsBody(at(0, 0, 80), body), `${spec}/${face}/past-end`).toBe(false)
      const shifted = at(2, 0)
      body.center.addScaledVector(body.axes[2], 150)
      expect(connectorHitsBody(shifted, body), `${spec}/${face}/changed-body`).toBe(false)
      body.center.copy(centre)
      expect(connectorHitsBody(shifted, body), `${spec}/${face}/restored-body`).toBe(true)
    }
  }
})
