import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { useStore } from './store/useStore'
import { useToolStore } from './store/useToolStore'
import { analyzeFrame } from './utils/analysis'
import { record, noteNext, opLog, clearOpLog, opLogText, type Doc } from './utils/opLog'

const snapshotOf = (s: ReturnType<typeof useStore.getState>): Doc => ({
  profiles: s.profiles, connectors: s.connectors, panels: s.panels, fittings: s.fittings,
})
import { auditBrackets } from './utils/bracketSeat'
import { gizmoState } from './components/TransformGizmo'
import { countUnflush, rollProfile } from './utils/faceAlign'

// Dev-only hook for end-to-end tests: window.__aluframe.{store,tool}
if (import.meta.env.DEV) {
  ;(window as any).__aluframe = {
    store: useStore, tool: useToolStore,
    trims: () => Object.fromEntries(analyzeFrame(useStore.getState().profiles).trims),
    gizmoHandles: () => gizmoState.handles.map((h) => {
      const world = h.probe.getWorldPosition(h.probe.position.clone())
      return { kind: h.part.kind, axis: h.part.axis, position: [world.x, world.y, world.z] }
    }),
    gizmoBusy: () => gizmoState.busy,
    rollProfile,
    unflush: () => countUnflush(useStore.getState().profiles),
    opLog, clearOpLog, opLogText,
    bracketFaults: () => {
      const s = useStore.getState()
      return auditBrackets(s.profiles, s.connectors).map((f) => ({ id: f.id, off: f.off, reason: f.reason }))
    },
    conflicts: () => {
      const { conflicts, conflictIds } = analyzeFrame(useStore.getState().profiles)
      return { conflicts: conflicts.map((c) => ({ a: c.a, b: c.b, depth: c.depth })), ids: [...conflictIds] }
    },
  }
}

/**
 * Keep the log. It subscribes rather than being called from each operation, so what it holds
 * is what the document actually did — a record, not a set of claims about intent.
 *
 * A drag writes to the store on every frame, so recording each write would bury a day's work
 * under a thousand one-millimetre moves. Nothing is recorded while a drag or a stretch is
 * under way; the comparison is held open against the document as it was before the gesture
 * started, and closed when the hand comes off.
 */
{
  let prev = snapshotOf(useStore.getState())
  const unchanged = (a: Doc, b: Doc) => a.profiles === b.profiles && a.connectors === b.connectors
    && a.panels === b.panels && a.fittings === b.fittings
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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
