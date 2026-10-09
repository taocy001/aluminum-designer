import type { ConnectorData, ProfileData, PanelData, FittingData, EquipmentData } from '../store/useStore'
import { computeAllTrims } from './jointUtils'
import { panelOBB, trimmedOBB } from './analysis'
import { equipmentClearance } from './equipmentGeometry'
import { fittingBodies } from './fittingGeometry'
import { connectorHitsBody, connectorsCollide } from './connectorCollision'
import { connectorOBB } from './analysis'

/** Detailed obstruction geometry is computed only for an explicitly inspected installation. */
export function placementObstacles(part: ConnectorData, doc: {
  profiles: ProfileData[]; panels: PanelData[]; fittings: FittingData[]; equipment: EquipmentData[]; connectors: ConnectorData[]
}) {
  const trims = computeAllTrims(doc.profiles)
  const solids = [
    ...doc.profiles.map(p => ({ id: p.id, body: trimmedOBB(p, trims.get(p.id)!), profile: true })),
    ...doc.panels.map(p => ({ id: p.id, body: panelOBB(p), profile: false })),
    ...doc.fittings.flatMap(p => fittingBodies(p).map(body => ({ id: p.id, body, profile: false }))),
    ...doc.equipment.map(p => ({ id: p.id, body: equipmentClearance(p), profile: false })),
  ]
  return [
    ...solids.filter(({ id, body, profile }) => connectorHitsBody(part, body, profile ? 0.15 : 1, profile, id)),
    ...doc.connectors.filter(c => c.id !== part.id && connectorsCollide(part, c)).map(c => ({ id: c.id, body: connectorOBB(c), profile: false })),
  ]
}
