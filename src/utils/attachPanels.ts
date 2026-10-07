import type { ProjectGeometry } from './document'
import type { ConnectorData } from '../store/useStore'
import { panelMountCandidates } from './panelMounts'
import { createConnectorPlacementValidator } from './connectorPlacement'
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
      const status = validate(candidate, [...doc.connectors, ...made])
      if (status.occupied) existing++
      else if (!status.allowed) blocked++
      else made.push({ ...candidate, id: nextId() })
    }
  }
  return { made, blocked, existing, unsupported }
}
