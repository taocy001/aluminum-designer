import * as THREE from 'three'
import { accessoryMeshes } from './connectorAccessoryGeometry'
import { cylinderGeometry, ringGeometry, type ConnectorMesh, type CollisionPart, type V3 } from './connectorSolidPrimitives'
import { panelBoltLength, type PanelMount } from './panelMounts'

function profileNutMeshes(): ConnectorMesh[] {
  // The B6 nut CAD already sits below its mounting face. Move only its bolt axis
  // to the profile-side plate hole: original [x, y, z] becomes [y, z, x - 10].
  const matrix = new THREE.Matrix4().set(0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, -10, 0, 0, 0, 1)
  const point = ([x, y, z]: readonly number[]): V3 => [y, z, x - 10]
  const part = (p: CollisionPart): CollisionPart => 'vertices' in p
    ? { ...p, vertices: p.vertices.map(point) }
    : { ...p, centre: point(p.centre), half: [p.half[1], p.half[2], p.half[0]] }
  return (accessoryMeshes('t-nut', 20) ?? []).map((mesh) => ({ ...mesh,
    geometry: mesh.geometry.clone().applyMatrix4(matrix),
    ...(mesh.collisionParts ? { collisionParts: mesh.collisionParts.map(part) } : {}),
    ...(mesh.collisionBoxes ? { collisionBoxes: mesh.collisionBoxes.map((p) => ({
      ...p, centre: point(p.centre), half: [p.half[1], p.half[2], p.half[0]] as V3,
    })) } : {}),
    ...(mesh.collisionVertices ? { collisionVertices: mesh.collisionVertices.map(point) } : {}),
  }))
}

/** Nominal fastener envelope; thread and drive recesses are omitted. All sizes are millimetres. */
export function panelMountMeshes(m: PanelMount): ConnectorMesh[] {
  const ring = (outer: number, inner: number, length: number, start: number, z: number): ConnectorMesh => ({
    geometry: ringGeometry(outer, inner, length, start).rotateY(Math.PI / 2).translate(0, 0, z), polished: true,
  })
  const cylinder = (radius: number, length: number, x: number, z: number, panelShaft = false): ConnectorMesh => ({
    geometry: cylinderGeometry(radius, length, 'x', [x, 0, z]), polished: true, panelShaft,
  })
  const bolt = panelBoltLength(m), far = -m.spacer - m.boardThickness
  return [
    ...profileNutMeshes(),
    ring(5, 2.65, 1, 4, -10), cylinder(4.25, 5, 7.5, -10), cylinder(2.5, 10, 0, -10),
    ...(m.spacer > 0 ? [ring(5, 2.75, m.spacer, -m.spacer, 10)] : []),
    ring(5, 2.65, 1, 4, 10), cylinder(4.25, 5, 7.5, 10), cylinder(2.5, bolt, 5 - bolt / 2, 10, true),
    ring(5, 2.65, 1, far - 1, 10), ring(4.6, 2.5, 4, far - 5, 10),
  ]
}
