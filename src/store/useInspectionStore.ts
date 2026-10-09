import { useToolStore } from './useToolStore'
import { create } from 'zustand'
import { useStore, type ConnectorData, type ProfileData } from './useStore'
import { projectSession } from '../utils/projectSession'
import type { ScreenPick } from '../utils/screenPick'
import type { ConnectorPlacementReason } from '../utils/connectorPlacement'

export interface ConnectionIssue {
  position: [number, number, number]
  hosts: string[]
  reason: ConnectorPlacementReason
  connectorId?: string
  candidate?: ConnectorData
}
export interface ConnectionReport {
  type: string
  placed: number
  skipped: number
  repaired: number
  issues: ConnectionIssue[]
}
type Overlap = { x: number; y: number; picks: Pick<ScreenPick, 'id' | 'kind'>[] }
export const useInspectionStore = create<{
  overlap: Overlap | null
  report: ConnectionReport | null
  reportHosts: ProfileData[]
  replacements: Record<number, string>
  recordRepair: (sourceIndex: number, id: string) => void
  focus: { position: [number, number, number] } | null
  setOverlap: (overlap: Overlap | null) => void
  setReport: (report: ConnectionReport | null) => void
  focusAt: (position: [number, number, number]) => void
}>((set) => ({ overlap: null, report: null, reportHosts: [], replacements: {}, focus: null,
  recordRepair: (sourceIndex, id) => set(s => ({ replacements: { ...s.replacements, [sourceIndex]: id } })),
  setOverlap: overlap => set({ overlap }), setReport: report => set({ report, reportHosts: structuredClone(useStore.getState().profiles), replacements: {}, focus: null }), focusAt: position => set({ focus: { position } }),
}))

// Reports are revalidated against current geometry, including undo. Only a document switch clears them.
let sessionId = projectSession.getState().id
projectSession.subscribe(() => {
  const next = projectSession.getState().id
  if (next !== sessionId) {
    sessionId = next
    useInspectionStore.getState().setReport(null)
    useInspectionStore.setState({ overlap: null })
  }
})
useStore.subscribe((s, p) => {
  if (s.throughRule !== p.throughRule || s.profiles !== p.profiles || s.connectors !== p.connectors || s.panels !== p.panels || s.fittings !== p.fittings || s.equipment !== p.equipment) {
    useInspectionStore.setState({ overlap: null, focus: null })
  }
})

useToolStore.subscribe((s, p) => {
  if (s.section !== p.section || s.buildStep !== p.buildStep || s.showFittings !== p.showFittings || s.held !== p.held || s.viewMode !== p.viewMode || s.isDrawing !== p.isDrawing) useInspectionStore.setState({ overlap: null })
})
