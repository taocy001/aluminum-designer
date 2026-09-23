import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { useStore } from './store/useStore'
import { useToolStore } from './store/useToolStore'
import { analyzeFrame } from './utils/analysis'
import { record, noteNext, opLog, clearOpLog, opLogText, type Doc } from './utils/opLog'
import { decodeShare, takeShareLink } from './utils/shareLink'
import { translations } from './utils/translations'

const snapshotOf = (s: ReturnType<typeof useStore.getState>): Doc => ({
  profiles: s.profiles, connectors: s.connectors, panels: s.panels, fittings: s.fittings,
})
import { auditBrackets } from './utils/bracketSeat'
import { gizmoState } from './components/TransformGizmo'
import { countUnflush, unflushPairs, rollProfile } from './utils/faceAlign'

// Dev-only hook for end-to-end tests: window.__aluframe.{store,tool}
if (import.meta.env.DEV) {
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
    unflushPairs: () => {
      const s = useStore.getState()
      const spec = (id: string) => s.profiles.find((p) => p.id === id)?.spec ?? '?'
      return unflushPairs(s.profiles).map((u) => `${spec(u.a)} × ${spec(u.b)} @ ${u.at.map(Math.round)}`)
    },
    opLog, clearOpLog, opLogText,
    bracketFaults: () => {
      const s = useStore.getState()
      return auditBrackets(s.profiles, s.connectors).map((f) => ({ id: f.id, off: f.off, reason: f.reason }))
    },
    conflicts: () => {
      const s = useStore.getState()
      const { conflicts, conflictIds } = analyzeFrame(s.profiles, s.connectors, s.panels, s.fittings)
      return { conflicts: conflicts.map((c) => ({ a: c.a, b: c.b, depth: c.depth })), ids: [...conflictIds] }
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

/** Consume shared project data from the URL before rendering the app. */
{
  const payload = takeShareLink()
  if (payload) {
    decodeShare(payload).then((doc) => {
      useStore.getState().loadDocument(doc)
      useToolStore.getState().showToast(translations[useToolStore.getState().language].toastSharedOpened, 'success')
    }).catch(() => { /* a link we cannot read is not a link for us */ })
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
