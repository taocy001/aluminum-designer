import * as THREE from 'three'
import { accessoryPlateDimensions } from './connectorAccessoryReferences'
import { accessoryMeshes } from './connectorAccessoryGeometry'
import { cylinderGeometry, ringGeometry, plateGeometry, type ConnectorMesh, type CollisionPart, type V3 } from './connectorSolidPrimitives'
import type { ConnectorSeries } from './connectorCatalog'
import { panelBoltLength, panelFastenerSizes, directStackExtra, type PanelMount } from './panelMounts'

function profileNutMeshes(series: ConnectorSeries, offset: number): ConnectorMesh[] {
  const k = series / 20
  // The series-specific nut CAD already sits below its mounting face. Move only its bolt axis
  // to the profile-side plate hole: original [x, y, z] becomes [y * k, z * k, x * k - offset].
  const matrix = new THREE.Matrix4().set(0, k, 0, 0, 0, 0, k, 0, k, 0, 0, -offset, 0, 0, 0, 1)
  const point = ([x, y, z]: readonly number[]): V3 => [y * k, z * k, x * k - offset]
  const part = (p: CollisionPart): CollisionPart => 'vertices' in p
    ? { ...p, vertices: p.vertices.map(point) }
    : { ...p, centre: point(p.centre), half: [p.half[1] * k, p.half[2] * k, p.half[0] * k] }
  return (accessoryMeshes('t-nut', series) ?? []).map((mesh) => ({ ...mesh,
    geometry: mesh.geometry.clone().applyMatrix4(matrix),
    ...(mesh.collisionParts ? { collisionParts: mesh.collisionParts.map(part) } : {}),
    ...(mesh.collisionBoxes ? { collisionBoxes: mesh.collisionBoxes.map((p) => ({
      ...p, centre: point(p.centre), half: [p.half[1] * k, p.half[2] * k, p.half[0] * k] as V3,
    })) } : {}),
    ...(mesh.collisionVertices ? { collisionVertices: mesh.collisionVertices.map(point) } : {}),
  }))
}

/** Nominal fastener envelope; thread and drive recesses are omitted. All sizes are millimetres. */
export function panelMountMeshes(m: PanelMount, series: ConnectorSeries = 20): ConnectorMesh[] {
  const ring = (outer: number, inner: number, length: number, start: number, z: number): ConnectorMesh => ({
    geometry: ringGeometry(outer, inner, length, start).rotateY(Math.PI / 2).translate(0, 0, z), polished: true,
  })
  const cylinder = (radius: number, length: number, x: number, z: number, panelShaft = false): ConnectorMesh => ({
    geometry: cylinderGeometry(radius, length, 'x', [x, 0, z]), polished: true, panelShaft,
  })
  const d = panelFastenerSizes(series), r = d.diameter / 2
  const bolt = panelBoltLength(m, series), far = -m.spacer - m.boardThickness, offset = series / 2
  if (m.mode === 'direct') {
    const extra = directStackExtra(m, series), washers = 1 + Math.floor((extra + 1e-6) / d.washer)
    const sleeve = Math.max(0, extra - (washers - 1) * d.washer), bearing = m.boardThickness + extra + d.washer
    return [...profileNutMeshes(series, 0),
      ...(sleeve > 1e-6 ? [ring(d.washerRadius, d.clearance / 2, sleeve, m.boardThickness, 0)] : []),
      ...Array.from({ length: washers }, (_, i) => ring(d.washerRadius, d.washerBore / 2, d.washer, m.boardThickness + sleeve + i * d.washer, 0)),
      cylinder(d.headRadius, d.headHeight, bearing + d.headHeight / 2, 0),
      cylinder(r, bolt, bearing - bolt / 2, 0, true)]
  }
  const nutRadius = d.nutAcross / Math.sqrt(3)
  const hex: [number, number][] = Array.from({ length: 6 }, (_, i) => [nutRadius * Math.cos(i * Math.PI / 3), nutRadius * Math.sin(i * Math.PI / 3)])
  const nut = plateGeometry(hex, d.nut, [{ x: 0, y: 0, r }], far - d.washer - d.nut)
    .rotateY(Math.PI / 2).translate(0, 0, offset)
  const plate = accessoryPlateDimensions('joining-plate', series).thickness
  const bearing = plate + d.washer, railBearing = bearing + d.railSpacer
  return [
    ...profileNutMeshes(series, offset),
    ...(d.railSpacer > 0 ? [ring(d.washerRadius, d.clearance / 2, d.railSpacer, plate, -offset)] : []),
    ring(d.washerRadius, d.washerBore / 2, d.washer, plate + d.railSpacer, -offset),
    cylinder(d.headRadius, d.headHeight, railBearing + d.headHeight / 2, -offset),
    cylinder(r, d.railBolt, railBearing - d.railBolt / 2, -offset),
    ...(m.spacer > 0 ? [ring(d.washerRadius, d.clearance / 2, m.spacer, -m.spacer, offset)] : []),
    ring(d.washerRadius, d.washerBore / 2, d.washer, plate, offset),
    cylinder(d.headRadius, d.headHeight, bearing + d.headHeight / 2, offset),
    cylinder(r, bolt, bearing - bolt / 2, offset, true),
    ring(d.washerRadius, d.washerBore / 2, d.washer, far - d.washer, offset),
    { geometry: nut, polished: true },
  ]
}
