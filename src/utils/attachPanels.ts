import * as THREE from 'three'
import type { ProjectGeometry } from './document'
import type { ConnectorData } from '../store/useStore'
import { panelMountCandidates, panelMountSupports } from './panelMounts'
import { createConnectorPlacementValidator, sameConnectorInstallation } from './connectorPlacement'
import { computeAllTrims } from './jointUtils'

/** Leave boards and members untouched. Repeated calls reuse existing installations. */
export function attachPanels(doc: ProjectGeometry, panelIds: readonly string[], nextId: () => string) {
  const trims = computeAllTrims(doc.profiles)
  const validate = createConnectorPlacementValidator(doc.profiles, doc)
  const made: ConnectorData[] = []
  let blocked = 0, existing = 0, unsupported = 0
  for (const panel of doc.panels.filter((p) => panelIds.includes(p.id))) {
    const candidates = panelMountCandidates(panel, doc.profiles, trims)
    if (!candidates.length) unsupported++
    for (const candidate of candidates) {
      // Adjacent boards may share a slot. Try nearby positions along that slot,
      // preserving the mounting face and checking the complete assembly again.
      const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(...candidate.quaternion))
      const offsets = [0, -(candidate.series ?? 20), candidate.series ?? 20]
      let placed = false
      for (const offset of offsets) {
        const choice = offset ? { ...candidate, position: new THREE.Vector3(...candidate.position).addScaledVector(axis, offset).toArray() } : candidate
        const others = [...doc.connectors, ...made]
        const status = validate(choice, others)
        if (status.occupied) {
          const complete = others.find(c => sameConnectorInstallation(choice, c)
            && c.panelMount?.panelId === panel.id && c.panelMount?.profileId === choice.panelMount?.profileId
            && c.panelMount?.mode === choice.panelMount?.mode && panelMountSupports(c, doc.profiles, doc.panels, trims)
            && validate(c, others.filter(other => other.id !== c.id)).allowed)
          if (complete) { existing++; placed = true; break }
          continue
        }
        if (status.allowed) { made.push({ ...choice, id: nextId() }); placed = true; break }
      }
      if (!placed) blocked++
    }
  }
  return { made, blocked, existing, unsupported }
}
