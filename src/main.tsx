import { projectSession } from './utils/projectSession'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { useStore } from './store/useStore'
import { useToolStore } from './store/useToolStore'
import { analyzeFrame, connectorOBB } from './utils/analysis'
import { record, noteNext, opLog, clearOpLog, opLogText, type Doc } from './utils/opLog'
import { decodeShare, takeShareLink } from './utils/shareLink'
import { translations } from './utils/translations'

const snapshotOf = (s: ReturnType<typeof useStore.getState>): Doc => ({
  profiles: s.profiles, connectors: s.connectors, panels: s.panels, fittings: s.fittings, equipment: s.equipment, throughRule: s.throughRule,
})
import { auditBrackets } from './utils/bracketSeat'
import { gizmoState } from './components/TransformGizmo'
import { countUnflush, unflushPairs, rollProfile } from './utils/faceAlign'
import { nextSuggestion } from './utils/suggestOps'
import { getProfileEndpoints } from './utils/geometryCore'

// Test hooks are enabled in development or when VITE_TEST_HOOK is set.
if (import.meta.env.DEV || import.meta.env.VITE_TEST_HOOK) {
  ;(window as any).__aluframe = {
    store: useStore, tool: useToolStore,
    trims: () => Object.fromEntries(analyzeFrame(useStore.getState().profiles, useStore.getState().connectors).trims),
    gizmoHandles: () => gizmoState.handles.map((h) => {
      const world = h.probe.getWorldPosition(h.probe.position.clone())
      return { kind: h.part.kind, axis: h.part.axis, position: [world.x, world.y, world.z] }
    }),
    gizmoBusy: () => gizmoState.busy,
    rollProfile,
    unflush: () => countUnflush(useStore.getState().profiles),
    connectorOBB: (id: string) => {
      const c = useStore.getState().connectors.find((q) => q.id === id)
      return c ? connectorOBB(c).center.toArray() : null
    },
    unflushPairs: () => {
      const s = useStore.getState()
      const spec = (id: string) => s.profiles.find((p) => p.id === id)?.spec ?? '?'
      return unflushPairs(s.profiles).map((u) => `${spec(u.a)} × ${spec(u.b)} @ ${u.at.map(Math.round)}`)
    },
    opLog, clearOpLog, opLogText,
    // press 建议 the way the button does, and read what is being offered
    suggest: () => {
      const t0 = performance.now()
      const c = nextSuggestion()
      return c ? { key: c.key, rule: c.rule, ms: performance.now() - t0 } : { key: null, ms: performance.now() - t0 }
    },
    suggestion: () => {
      const s = useToolStore.getState().suggestion
      if (!s) return null
      const { start, end } = getProfileEndpoints(s.cand.member)
      return {
        key: s.cand.key, rule: s.cand.rule, index: s.index, spec: s.cand.member.spec, length: s.cand.member.length,
        start: start.toArray(), end: end.toArray(), mid: start.clone().add(end).multiplyScalar(0.5).toArray(),
      }
    },
    bracketFaults: () => {
      const s = useStore.getState()
      return auditBrackets(s.profiles, s.connectors, undefined, undefined, s.panels).map((f) => ({ id: f.id, off: f.off, reason: f.reason }))
    },
    conflicts: () => {
      const s = useStore.getState()
      const { conflicts, conflictIds, equipmentConflicts, equipmentConflictIds } = analyzeFrame(s.profiles, s.connectors, s.panels, s.fittings, s.equipment)
      return { conflicts: conflicts.map((c) => ({ a: c.a, b: c.b, depth: c.depth })), ids: [...conflictIds],
        equipmentConflicts: equipmentConflicts.map(({ a, b, kind, depth }) => ({ a, b, kind, depth })),
        equipmentConflictIds: [...equipmentConflictIds] }
    },
  }
}

/**
 * Record document differences through store subscriptions.
 * Coalesce drag and stretch updates into one log entry when the gesture ends.
 */
{
  let prev = snapshotOf(useStore.getState())
  const unchanged = (a: Doc, b: Doc) => a.profiles === b.profiles && a.connectors === b.connectors
    && a.panels === b.panels && a.fittings === b.fittings && a.equipment === b.equipment && a.throughRule === b.throughRule
  const flush = () => {
    const next = snapshotOf(useStore.getState())
    if (unchanged(prev, next)) return
    const was = prev
    prev = next
    record(was, next)
  }
  const midGesture = () => {
    const t = useToolStore.getState()
    return t.isDragging || t.resize !== null
  }
  useStore.subscribe(() => { if (!midGesture()) flush() })
  let wasMid = false
  useToolStore.subscribe(() => {
    const now = midGesture()
    if (wasMid && !now) { noteNext('drag'); flush() }
    wasMid = now
  })
}

/** Consume shared project data from the URL before rendering the app. */
const root = ReactDOM.createRoot(document.getElementById('root')!)
async function start() {
  root.render(<React.StrictMode><App /></React.StrictMode>)
  const payload = takeShareLink()
  if (payload) {
    try {
      const doc = await decodeShare(payload)
      projectSession.requestReplacement(() => {
        useStore.getState().loadDocument(doc)
        useToolStore.getState().showToast(translations[useToolStore.getState().language].toastSharedOpened, 'success')
      })
    } catch {
      useToolStore.getState().showToast(translations[useToolStore.getState().language].toastImportFailed, 'error')
    }
  }
}
void start()
