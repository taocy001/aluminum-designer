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
  profiles: s.profiles, connectors: s.connectors, panels: s.panels, fittings: s.fittings,
})
import { auditBrackets } from './utils/bracketSeat'
import { gizmoState } from './components/TransformGizmo'
import { countUnflush, unflushPairs, rollProfile } from './utils/faceAlign'

// Dev-only hook for end-to-end tests: window.__aluframe.{store,tool}
// VITE_TEST_HOOK=1 keeps it in a production build, so what users run can be measured
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

/**
 * A link that carries a drawing opens that drawing.
 *
 * Before the first paint, so nothing of the previous session is ever on screen — arriving at
 * somebody else's link and seeing your own cabinet for a frame would be alarming. The link is
 * taken out of the address bar afterwards, so a reload is not a reset to what was sent.
 */
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
