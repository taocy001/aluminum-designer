import * as THREE from 'three'
import type { ProjectGeometry } from './document'
import { computeAllTrims } from './jointUtils'
import { panelOBB } from './analysis'
import { panelMountFrame } from './panelMounts'
import { createConnectorPlacementValidator } from './connectorPlacement'
import { shelfEdges } from './shelfSupport'

/** Geometric fastening coverage, not a load rating. Exterior boards need distributed points. */
export function unfastenedPanels(doc: ProjectGeometry): string[] {
  const trims = computeAllTrims(doc.profiles)
  const validate = createConnectorPlacementValidator(doc.profiles, doc, trims)
  const edges = shelfEdges(doc.panels, doc.profiles, trims, doc.connectors, doc)
  return doc.panels.filter(panel => {
    const body = panelOBB(panel)
    if (Math.abs(body.axes[2].y) > .999999) {
      const perimeter = edges.filter(e => e.panelId === panel.id)
      return perimeter.length !== 4 || perimeter.some(e => !e.fixed)
    }
    const holes = doc.connectors.filter(c => c.panelMount?.panelId === panel.id && c.panelMount.mode === 'direct'
      && validate(c, doc.connectors.filter(other => other.id !== c.id)).allowed)
      .map(c => panelMountFrame(c).boardHole.sub(new THREE.Vector3(...panel.position)))
    // Require one sound mount in each outer quadrant, at least half a board apart.
    return ![-1, 1].every(x => [-1, 1].every(y => holes.some(h =>
      h.dot(body.axes[0]) * x >= body.half.x / 2 - .05
      && h.dot(body.axes[1]) * y >= body.half.y / 2 - .05)))
  }).map(p => p.id)
}
