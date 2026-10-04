import * as THREE from 'three'
import type { ConnectorData } from '../store/useStore'
import { connectorMounts, connectorScale, insideCornerSection, type ConnectorSeries } from './connectorCatalog'

type V3 = [number, number, number]
export interface ConnectorMesh {
  /** Geometry already transformed into the connector's local frame. Shared and immutable. */
  geometry: THREE.BufferGeometry
  dark?: boolean
  polished?: boolean
  previewDepthWrite?: boolean
}

/** Rendered solids also define physical bounds; collision boxes are approximate. */
function buildMeshes(type: string, series: ConnectorSeries): ConnectorMesh[] {
  const parts: ConnectorMesh[] = []
  const add = (geometry: THREE.BufferGeometry, position: V3 = [0, 0, 0], rotation: V3 = [0, 0, 0],
    style: Omit<ConnectorMesh, 'geometry'> = {}) => {
    geometry.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rotation)))
    geometry.translate(...position)
    parts.push({ geometry, ...style })
  }
  const box = (size: V3, position?: V3) => add(new THREE.BoxGeometry(...size), position)
  const cylinder = (size: [number, number, number, number], position?: V3, rotation?: V3,
    style?: Omit<ConnectorMesh, 'geometry'>) => add(new THREE.CylinderGeometry(...size), position, rotation, style)
  const sideways: V3 = [Math.PI / 2, 0, 0]
  const across: V3 = [0, 0, Math.PI / 2]
  switch (type) {
    case 'bracket':
      // Two 4 mm flanges run along +X/+Y from their inside vertex, with a cast web.
      box([30, 4, 18], [15, 2, 0]); box([4, 30, 18], [2, 15, 0])
      cylinder([6.4, 6.4, 9.9, 3], undefined, sideways, { previewDepthWrite: true })
      break
    case 'gusset': {
      const shape = new THREE.Shape()
      shape.moveTo(-8, -8); shape.lineTo(30, -8); shape.lineTo(-8, 30); shape.closePath()
      add(new THREE.ExtrudeGeometry(shape, { depth: 4, bevelEnabled: false }), undefined, undefined,
        { polished: true, previewDepthWrite: true })
      break
    }
    case 'inside-corner': {
      // The heel bridges both slot inserts in the open inside corner, away from the frame ends.
      const { depth, width } = insideCornerSection(series)
      const shape = new THREE.Shape()
      shape.moveTo(0, 0); shape.lineTo(0, -depth); shape.lineTo(20, -depth); shape.lineTo(20, 0)
      shape.lineTo(depth, 0); shape.lineTo(depth, depth); shape.lineTo(0, depth)
      shape.lineTo(0, 20); shape.lineTo(-depth, 20); shape.lineTo(-depth, 0); shape.closePath()
      add(new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false }), [0, 0, -width / 2])
      break
    }
    case 'flat-plate':
      box([60, 4, 18])
      cylinder([2.5, 2.5, 5, 12], [-20, 3, 0], sideways)
      cylinder([2.5, 2.5, 5, 12], [20, 3, 0], sideways)
      break
    case 't-bracket':
      box([70, 20, 4], [0, 0, 2]); box([20, 40, 4], [0, 20, 2])
      break
    case 'cross-bracket':
      box([48, 4, 4]); box([4, 48, 4])
      break
    case 'end-cap':
      box([20, 20, 3]); box([10, 10, 6], [0, 0, 4])
      break
    case 'hinge':
      box([3, 30, 18], [-1.5, 0, 0]); box([3, 30, 18], [1.5, 0, 0])
      cylinder([2.5, 2.5, 32, 12], undefined, sideways)
      break
    case 'pivot':
      box([30, 6, 20], [0, -3, 0])
      cylinder([8, 8, 10, 16], [0, 5, 0]); cylinder([4, 4, 16, 12], [0, 5, 0], undefined, { dark: true })
      break
    case 'caster-mount':
      box([40, 4, 40]); cylinder([12, 12, 8, 16], [0, -6, 0])
      cylinder([8, 8, 20, 12], [0, -18, 0], sideways)
      break
    case 'foot':
      cylinder([18, 18, 3, 16], [0, -1.5, 0]); cylinder([5, 5, 24, 12], [0, 12, 0])
      box([20, 4, 20], [0, 26, 0])
      break
    case 'joining-plate':
      box([4, 16, 50])
      cylinder([3, 3, 6, 12], [0, 0, -16], across); cylinder([3, 3, 6, 12], [0, 0, 16], across)
      break
    case 'corner-3way':
      box([20, 4, 8], [10, 2, 0]); box([4, 20, 8], [2, 10, 0])
      // Clear the adjoining member before widening the third arm around its bolt.
      box([4, 4, 10], [2, 2, 5]); box([8, 4, 10], [0, 2, 15]); box([4, 4, 4])
      break
    case 't-nut':
      box([18, 4, 7]); box([10, 8, 4], [0, -4, 0]); cylinder([2.5, 2.5, 12, 12], [0, 4, 0])
      break
    default: box([10, 10, 10])
  }
  // Hole markers use the exact contact definitions used by installation auditing.
  // Inside-corner grub screws remain within the inserted arms, so omit visible markers.
  if (type !== 'inside-corner') for (const mount of connectorMounts(type)) {
    for (const bolt of mount.bolts) {
      const position = [...bolt] as V3
      position[mount.normal === 'x' ? 0 : mount.normal === 'y' ? 1 : 2] += 2
      cylinder([2.6, 2.6, 4.1, 12], position, mount.normal === 'z' ? sideways : mount.normal === 'x' ? across : undefined, { dark: true })
    }
  }
  return parts
}

const meshCache = new Map<string, readonly ConnectorMesh[]>()
export function connectorMeshes(type: string, series: ConnectorSeries = 20): readonly ConnectorMesh[] {
  const key = type === 'inside-corner' ? `${type}:${series}` : type
  if (!meshCache.has(key)) meshCache.set(key, buildMeshes(type, series))
  return meshCache.get(key)!
}

/** Maximum world Y of rendered vertices, including curved parts, rotation and series. */
export function connectorSolidTop(connector: ConnectorData): number {
  const quat = new THREE.Quaternion(...connector.quaternion).normalize()
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quat.invert())
  const scale = connectorScale(connector.series ?? 20)
  let top = -Infinity
  for (const { geometry } of connectorMeshes(connector.type, connector.series)) {
    const positions = geometry.getAttribute('position')
    for (let i = 0; i < positions.count; i++) {
      const y = positions.getX(i) * up.x + positions.getY(i) * up.y + positions.getZ(i) * up.z
      top = Math.max(top, connector.position[1] + y * scale)
    }
  }
  return top
}
