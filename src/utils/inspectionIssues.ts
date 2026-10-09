import * as THREE from 'three'
import type { ProjectDocument } from './document'
import { analyzeFrame } from './analysis'
import { cachedHardwareSupports } from './connectorAuditCache'
import { runnerFaults } from './runnerMount'
import { shelfEdges } from './shelfSupport'
import { swingClashes } from './fittingGeometry'

export interface InspectionIssue {
  key: string
  kind: 'collision' | 'equipment-body' | 'equipment-clearance' | 'joint' | 'connector' | 'runner' | 'shelf' | 'swing'
  ids: string[]
  position: [number, number, number]
  detail?: string
}

/** These are geometry checks, not a load certification or a machining approval. */
export function inspectDocument(doc: ProjectDocument): InspectionIssue[] {
  const analysis = analyzeFrame(doc.profiles, doc.connectors, doc.panels, doc.fittings, doc.equipment ?? [])
  const center = (box: THREE.Box3) => box.getCenter(new THREE.Vector3()).toArray() as [number, number, number]
  const rows: InspectionIssue[] = [
    ...analysis.conflicts.map(c => ({ key: `collision:${c.a}:${c.b}`, kind: 'collision' as const,
      ids: [c.a, c.b], position: center(c.region), detail: `${c.depth.toFixed(1)} mm` })),
    ...analysis.equipmentConflicts.map(c => ({ key: `${c.kind}:${c.a}:${c.b}`, kind: c.kind,
      ids: [c.a, c.b], position: center(c.region), detail: `${c.depth.toFixed(1)} mm` })),
    ...analysis.mismatches.map(c => ({ key: `joint:${c.a}:${c.b}`, kind: 'joint' as const,
      ids: [c.a, c.b], position: c.at.toArray() as [number, number, number], detail: c.specs.join(' / ') })),
    ...cachedHardwareSupports(doc, analysis.trims).faultDetails.map(c => ({ key: `connector:${c.id}`, kind: 'connector' as const,
      ids: [c.id], position: c.at.toArray() as [number, number, number], detail: c.reason })),
    ...runnerFaults(doc.profiles, analysis.trims, doc.fittings, doc.panels).map(c => ({ key: `runner:${c.id}:${c.side}`, kind: 'runner' as const,
      ids: [c.id], position: doc.fittings.find(f => f.id === c.id)!.position, detail: c.side })),
    ...shelfEdges(doc.panels, doc.profiles, analysis.trims, doc.connectors, doc).filter(c => !c.carried && !c.fixed)
      .map(c => ({ key: `shelf:${c.panelId}:${c.edge}`, kind: 'shelf' as const,
        ids: [c.panelId], position: c.a.clone().add(c.b).multiplyScalar(.5).toArray() as [number, number, number], detail: c.edge })),
    ...swingClashes(doc.fittings).map(([a, b]) => ({ key: `swing:${a}:${b}`, kind: 'swing' as const,
      ids: [a, b], position: doc.fittings.find(f => f.id === a)!.position })),
  ]
  return rows
}
