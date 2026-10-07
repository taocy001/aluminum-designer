import { panelMountMeshes } from './panelMountGeometry'
import * as THREE from 'three'
import type { ConnectorData, ProfileSpec } from '../store/useStore'
import { connectorScale, type ConnectorSeries } from './connectorCatalog'
import { insideCornerDimensions } from './connectorHardware'
import { profileSlotDimensions } from './specUtils'
import { accessoryMeshes } from './connectorAccessoryGeometry'
import { geometryFromCad,
  type ConnectorMesh, type CollisionPart, type V3 } from './connectorSolidPrimitives'
import bracket20 from '../assets/connectorCad/motedis-s6bbr20.json'
import bracket30 from '../assets/connectorCad/motedis-s8bbr30.json'
import bracket40 from '../assets/connectorCad/motedis-s8ibr40.json'
import inside20 from '../assets/connectorCad/motedis-s6bibm5.json'
import inside8 from '../assets/connectorCad/motedis-s8ibibm6.json'
import screw5 from '../assets/connectorCad/motedis-din913-m5x6.json'
import screw6 from '../assets/connectorCad/motedis-din913-m6x8.json'
import gusset40 from '../assets/connectorCad/80-20-40-4332-derived.json'
import corner40 from '../assets/connectorCad/80-20-14173-derived.json'
export type { ConnectorMesh } from './connectorSolidPrimitives'

function normalized(parts: ConnectorMesh[], series: ConnectorSeries): ConnectorMesh[] {
  const k = 1 / connectorScale(series)
  const v = (p: readonly number[]): V3 => [p[0] * k, p[1] * k, p[2] * k]
  const part = (p: CollisionPart): CollisionPart => 'vertices' in p
    ? { vertices: p.vertices.map(v) } : { centre: v(p.centre), half: v(p.half) }
  return parts.map((p) => ({ ...p, geometry: p.geometry.scale(k, k, k),
    ...(p.collisionParts ? { collisionParts: p.collisionParts.map(part) } : {}),
    ...(p.collisionBoxes ? { collisionBoxes: p.collisionBoxes.map((b) => ({ centre: v(b.centre), half: v(b.half) })) } : {}),
    ...(p.collisionVertices ? { collisionVertices: p.collisionVertices.map(v) } : {}),
  }))
}

function bracketMeshes(series: ConnectorSeries): ConnectorMesh[] {
  const cad = series === 20 ? bracket20 : series === 30 ? bracket30 : bracket40
  const geometry = geometryFromCad(cad)
  // Collision parts conservatively enclose the CAD flanges, two separate side webs,
  // and each locating tab. The 0.5 mm flange margin covers cast root fillets.
  return [{ geometry, collisionParts: cad.collisionParts as CollisionPart[] }]
}

/** Origin is the intersection of inner arm surfaces; both physical arms occupy negative depth. */
function insideMeshes(series: ConnectorSeries, mountSeries: readonly [ConnectorSeries, ConnectorSeries] = [series, series]): ConnectorMesh[] {
  const d = insideCornerDimensions(series)
  const cad = series === 20 ? inside20 : inside8
  const parts: ConnectorMesh[] = [{ geometry: geometryFromCad(cad), collisionParts: cad.collisionParts as CollisionPart[] }]
  // DIN 913 lengths are physical 6/8 mm. In the tightened position the flat tip bears
  // on the reference slot floor; the 20-series screw therefore stands slightly proud.
  const ySlot = profileSlotDimensions(mountSeries[0]), xSlot = profileSlotDimensions(mountSeries[1])
  const screwLength = series === 20 ? 6 : 8
  const yMiddle = -(ySlot.depth - (ySlot.lipDepth - d.neckProjection)) + screwLength / 2
  const xMiddle = -(xSlot.depth - (xSlot.lipDepth - d.verticalNeckProjection)) + screwLength / 2
  for (const [axis, centre] of [['y', [d.xScrew, yMiddle, 0]], ['x', [xMiddle, d.yScrew, 0]]] as const) {
    const c = [...centre] as V3
    const radius = d.screwDiameter / 2
    const screw = geometryFromCad(series === 20 ? screw5 : screw6)
    if (axis === 'x') screw.rotateY(Math.PI / 2)
    else screw.rotateX(-Math.PI / 2)
    screw.translate(...c)
    const radialEnvelope = radius / Math.cos(Math.PI / 8)
    const vertices: V3[] = [-screwLength / 2, screwLength / 2].flatMap((end) => Array.from({ length: 8 }, (_, i): V3 => {
      const u = radialEnvelope * Math.cos((i + 0.5) * Math.PI / 4), v = radialEnvelope * Math.sin((i + 0.5) * Math.PI / 4)
      return axis === 'x' ? [c[0] + end, c[1] + u, v] : [c[0] + u, c[1] + end, v]
    }))
    parts.push({ geometry: screw, dark: true,
      collisionVertices: vertices })
  }
  return parts
}

/** Dimensioned 80/20 40-4332 reference, always in its actual 40 mm physical size. */
function gussetMeshes(): ConnectorMesh[] {
  const length = 40, wall = 6, width = 36, innerSum = length - wall * Math.SQRT2
  const sections: [number, number][][] = [
    [[0, 0], [40, 0], [34, 6], [0, 6]],
    [[0, 6], [6, 6], [6, 34], [0, 40]],
    [[6, innerSum - 6], [innerSum - 6, 6], [34, 6], [6, 34]],
  ]
  return [{ geometry: geometryFromCad(gusset40), polished: true,
    collisionParts: sections.map((points) => ({ vertices:
      [-width / 2, width / 2].flatMap((z) => points.map(([x, y]): V3 => [x, y, z])),
    })),
  }]
}

/** Cube centre origin; three profile ends contact -X/-Y/-Z at -20 mm. */
function cornerMeshes(): ConnectorMesh[] {
  // Internal die-cast pockets/fillets and removable caps are omitted. The closed
  // CAD-kernel model retains the referenced outer envelope and actual access bores.
  return [{ geometry: geometryFromCad(corner40), collisionBoxes: [{ centre: [0, 0, 0], half: [20, 20, 20] }] }]
}

const meshCache = new Map<string, readonly ConnectorMesh[]>()
export function connectorMeshes(type: string, series: ConnectorSeries = 20, profileSpec?: ProfileSpec,
  mountSeries?: readonly [ConnectorSeries, ConnectorSeries], panelMount?: ConnectorData['panelMount']): readonly ConnectorMesh[] {
  const key = `${type}:${series}:${profileSpec ?? ''}:${mountSeries?.join(',') ?? ''}:${panelMount ? `${panelMount.spacer}:${panelMount.boardThickness}` : ''}`
  if (!meshCache.has(key)) {
    let physical: ConnectorMesh[] | undefined
    if (type === 'inside-corner') physical = insideMeshes(series, mountSeries)
    if (type === 'bracket') physical = bracketMeshes(series)
    if (type === 'gusset') physical = gussetMeshes()
    if (type === 'corner-3way') physical = cornerMeshes()
    if (type === 'joining-plate' && panelMount && series === 20) physical = [...(accessoryMeshes(type, series) ?? []), ...panelMountMeshes(panelMount)]
    meshCache.set(key, physical ? normalized(physical, series) : accessoryMeshes(type, series, profileSpec) ?? [])
  }
  return meshCache.get(key)!
}

/** Maximum world Y of rendered vertices, including curved parts, rotation and series. */
export function connectorSolidTop(connector: ConnectorData): number {
  const quat = new THREE.Quaternion(...connector.quaternion).normalize()
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quat.invert())
  const scale = connectorScale(connector.series ?? 20)
  let top = -Infinity
  for (const { geometry } of connectorMeshes(connector.type, connector.series, connector.profileSpec, connector.mountSeries, connector.panelMount)) {
    const positions = geometry.getAttribute('position')
    for (let i = 0; i < positions.count; i++) {
      const y = positions.getX(i) * up.x + positions.getY(i) * up.y + positions.getZ(i) * up.z
      top = Math.max(top, connector.position[1] + y * scale)
    }
  }
  return top
}
