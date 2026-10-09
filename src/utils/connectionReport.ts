import * as THREE from 'three'
import type { ConnectionReport } from '../store/useInspectionStore'
import type { ProfileData } from '../store/useStore'
import type { ProjectDocument } from './document'
import { createConnectorPlacementValidator, sameConnectorInstallation } from './connectorPlacement'

/** Keep the original failures so undo can bring a repaired item back into the list. */
export function remainingConnectionIssues(report: ConnectionReport, doc: ProjectDocument,
  originalHosts: ProfileData[], replacements: Record<number, string>) {
  const validate = createConnectorPlacementValidator(doc.profiles, doc)
  return report.issues.flatMap((original, sourceIndex) => {
    if (original.hosts.some(id => !doc.profiles.some(p => p.id === id))) return []
    const current = doc.connectors.find(c => c.id === (original.connectorId ?? replacements[sourceIndex]))
    if (original.connectorId && !current) return []
    const before = originalHosts.find(p => p.id === original.hosts[0])
    const after = doc.profiles.find(p => p.id === original.hosts[0])
    const rotation = before && after ? new THREE.Quaternion(...after.quaternion)
      .multiply(new THREE.Quaternion(...before.quaternion).invert()) : new THREE.Quaternion()
    const point = new THREE.Vector3(...original.position)
    if (before && after) point.sub(new THREE.Vector3(...before.position)).applyQuaternion(rotation).add(new THREE.Vector3(...after.position))
    const candidate = original.candidate ? { ...original.candidate, position: point.toArray() as [number, number, number],
      quaternion: rotation.clone().multiply(new THREE.Quaternion(...original.candidate.quaternion)).toArray() as [number, number, number, number] } : undefined
    const installed = current ?? (candidate && doc.connectors.find(c => sameConnectorInstallation(c, candidate)))
    const status = installed ? validate(installed, doc.connectors.filter(c => c.id !== installed.id)) : undefined
    if (status?.allowed) return []
    return [{ ...original, candidate, sourceIndex, connectorId: installed?.id ?? original.connectorId,
      position: installed?.position ?? point.toArray() as [number, number, number], reason: status?.reason ?? original.reason }]
  })
}
