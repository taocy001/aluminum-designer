import * as THREE from 'three'
import { useStore, type ConnectorData } from '../store/useStore'
import { reportEditResult } from './editFeedback'
import { connectorPlacementCandidates } from './connectorPlacement'

type ConnectorPose = Pick<ConnectorData, 'position' | 'quaternion'>

/** Keep the support relation only when its host is transformed in the same operation. */
export function connectorTransformUpdates(
  connector: ConnectorData, updates: Partial<ConnectorPose>, movedProfiles: ReadonlySet<string> = new Set(),
): Partial<ConnectorData> {
  const position = updates.position?.some((value, index) => Math.abs(value - connector.position[index]) > 1e-7)
    ? updates.position : undefined
  const quaternion = updates.quaternion && Math.abs(new THREE.Quaternion(...connector.quaternion).normalize()
    .dot(new THREE.Quaternion(...updates.quaternion).normalize())) < 1 - 1e-12 ? updates.quaternion : undefined
  const pose = { ...(position ? { position } : {}), ...(quaternion ? { quaternion } : {}) }
  if (!position && !quaternion) return {}
  if (connector.supportBinding && !movedProfiles.has(connector.supportBinding.profileId)) {
    return { ...pose, supportBinding: undefined }
  }
  return pose
}

/** An explicit pose edit detaches a generated connector in the same undo step. */
export function setConnectorPose(id: string, updates: Partial<ConnectorPose>): boolean {
  const store = useStore.getState(), connector = store.connectors.find((part) => part.id === id)
  if (!connector || connector.locked) return false
  if (updates.position && !updates.position.every(Number.isFinite)) return false
  if (updates.quaternion && (!updates.quaternion.every(Number.isFinite) || Math.hypot(...updates.quaternion) < 1e-9)) return false
  const position = updates.position?.map((value) => Math.round(value * 1000) / 1000) as ConnectorData['position'] | undefined
  const quaternion = updates.quaternion
    ? new THREE.Quaternion(...updates.quaternion).normalize().toArray() as ConnectorData['quaternion'] : undefined
  const changedPosition = position && position.some((value, index) => value !== connector.position[index])
  const changedRotation = quaternion && Math.abs(new THREE.Quaternion(...connector.quaternion).normalize()
    .dot(new THREE.Quaternion(...quaternion))) < 1 - 1e-12
  if (!changedPosition && !changedRotation) return false
  const pose = { ...(changedPosition ? { position } : {}), ...(changedRotation ? { quaternion } : {}) }
  return reportEditResult(store.commitTransform({ connectors: [{ id, updates: connectorTransformUpdates(connector, pose) }] }))
}

/** The editable angles use the same YXZ decomposition as the orientation display. */
export function setConnectorAngles(id: string, degrees: [number, number, number]): boolean {
  if (!degrees.every(Number.isFinite)) return false
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    ...degrees.map(THREE.MathUtils.degToRad) as [number, number, number], 'YXZ',
  )).toArray() as ConnectorData['quaternion']
  return setConnectorPose(id, { quaternion })
}

/** Recheck the installation choice against the current document before replacing it. */
export function reseatConnector(id: string, key: string, anchor: ConnectorData['position']): boolean {
  const store = useStore.getState(), connector = store.connectors.find((part) => part.id === id)
  if (!connector || connector.locked) return false
  const candidate = connectorPlacementCandidates(connector.type, new THREE.Vector3(...anchor),
    store.profiles, store.connectors, undefined, undefined,
    { excludeConnectorId: id, equipment: store.equipment, panels: store.panels, fittings: store.fittings }).find((seat) => seat.key === key)
  if (!candidate?.allowed) return false
  const { position, quaternion, series, profileSpec, mountSeries } = candidate.seat
  return reportEditResult(store.commitTransform({ connectors: [{ id,
    updates: { position, quaternion, series, profileSpec, mountSeries, supportBinding: undefined } }] }))
}
