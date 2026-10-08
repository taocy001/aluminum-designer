import * as THREE from 'three'
import type { ConnectorData, PanelData } from '../store/useStore'
import { panelMountBoardFits, panelMountFrame, panelFastenerSizes } from './panelMounts'
import { panelOBB } from './analysis'

/** Local XY centres, measured from the panel centre; series-specific through holes. */
export function panelDrillCenters(panel: PanelData, connectors: ConnectorData[]): (THREE.Vector2 & { diameter: number })[] {
  const inverse = new THREE.Quaternion(...panel.quaternion).normalize().invert()
  const body = panelOBB(panel), at = new THREE.Vector3(...panel.position)
  const holes: (THREE.Vector2 & { diameter: number })[] = []
  for (const c of connectors) {
    if (c.panelMount?.panelId !== panel.id || !panelMountBoardFits(c, body)) continue
    const local = panelMountFrame(c).boardHole.sub(at).applyQuaternion(inverse)
    const hole = Object.assign(new THREE.Vector2(local.x, local.y), { diameter: panelFastenerSizes(c.series).clearance })
    if (!holes.some((h) => h.distanceTo(hole) < .05)) holes.push(hole)
  }
  return holes
}
export function panelShape(panel: PanelData, connectors: ConnectorData[]): THREE.Shape {
  const shape = new THREE.Shape()
  shape.moveTo(-panel.width / 2, -panel.height / 2)
  shape.lineTo(panel.width / 2, -panel.height / 2)
  shape.lineTo(panel.width / 2, panel.height / 2)
  shape.lineTo(-panel.width / 2, panel.height / 2)
  shape.closePath()
  for (const hole of panelDrillCenters(panel, connectors)) {
    const path = new THREE.Path()
    path.absarc(hole.x, hole.y, hole.diameter / 2, 0, Math.PI * 2, true)
    shape.holes.push(path)
  }
  return shape
}
