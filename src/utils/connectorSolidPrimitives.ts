import * as THREE from 'three'
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg/src/index.js'

export type V3 = [number, number, number]
export interface CollisionBox { centre: V3; half: V3; pressFit?: boolean }
export type CollisionPart = CollisionBox | { vertices: readonly V3[]; pressFit?: boolean }
export interface ConnectorMesh {
  /** Shared immutable geometry, already transformed into the normalized connector frame. */
  geometry: THREE.BufferGeometry
  dark?: boolean
  polished?: boolean
  previewDepthWrite?: boolean
  visualOnly?: boolean
  /** Through bolt: only the validated board hole permits this shaft to overlap. */
  panelShaft?: boolean
  collisionParts?: readonly CollisionPart[]
  /** Conservative convex parts; holes may be filled, but empty L corners never are. */
  collisionBoxes?: readonly CollisionBox[]
  /** One convex solid's vertices, for triangular ribs that must not fill their empty corner. */
  collisionVertices?: readonly V3[]
}
export type PlateHole = { x: number; y: number; r: number } | { points: [number, number][] }

export function geometryFromCad(cad: { positions: readonly number[]; indices: readonly number[] }): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(cad.positions, 3))
  geometry.setIndex([...cad.indices])
  geometry.computeVertexNormals()
  return geometry
}

export function plateGeometry(points: readonly [number, number][], depth: number,
  holes: readonly PlateHole[] = [], z = 0): THREE.BufferGeometry {
  const shape = new THREE.Shape()
  points.forEach(([x, y], i) => i ? shape.lineTo(x, y) : shape.moveTo(x, y))
  shape.closePath()
  for (const hole of holes) {
    const path = new THREE.Path()
    if ('r' in hole) path.absarc(hole.x, hole.y, hole.r, 0, Math.PI * 2, true)
    else {
      hole.points.forEach(([x, y], i) => i ? path.lineTo(x, y) : path.moveTo(x, y))
      path.closePath()
    }
    shape.holes.push(path)
  }
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 16 })
  geometry.translate(0, 0, z)
  return geometry
}
export const polygonPrism = plateGeometry

/** Circular annulus extruded along local Z. */
export function ringGeometry(outerRadius: number, innerRadius: number, depth: number, z = 0): THREE.BufferGeometry {
  const outer = Array.from({ length: 48 }, (_, i): [number, number] => [
    outerRadius * Math.cos(i * Math.PI / 24), outerRadius * Math.sin(i * Math.PI / 24),
  ])
  return plateGeometry(outer, depth, innerRadius > 0 ? [{ x: 0, y: 0, r: innerRadius }] : [], z)
}

/** Apply an actual subtractive hole; unlike a dark cylinder this is also empty in STEP/picking. */
export function subtractGeometry(body: THREE.BufferGeometry, cutter: THREE.BufferGeometry): THREE.BufferGeometry {
  const evaluator = new Evaluator()
  evaluator.attributes = ['position', 'normal']
  evaluator.useGroups = false
  const a = new Brush(body), b = new Brush(cutter)
  a.updateMatrixWorld(); b.updateMatrixWorld()
  const result = evaluator.evaluate(a, b, SUBTRACTION).geometry
  result.clearGroups()
  return result
}

export function cylinderGeometry(radius: number, length: number, axis: 'x' | 'y' | 'z', centre: V3): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(radius, radius, length, 32)
  if (axis === 'x') g.rotateZ(Math.PI / 2)
  if (axis === 'z') g.rotateX(Math.PI / 2)
  return g.translate(...centre)
}

export function boxGeometry(size: V3, centre: V3): THREE.BufferGeometry {
  return new THREE.BoxGeometry(...size).translate(...centre)
}
