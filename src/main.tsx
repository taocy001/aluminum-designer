import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { useStore } from './store/useStore'
import { useToolStore } from './store/useToolStore'
import { analyzeFrame } from './utils/analysis'
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
    conflicts: () => {
      const { conflicts, conflictIds } = analyzeFrame(useStore.getState().profiles)
      return { conflicts: conflicts.map((c) => ({ a: c.a, b: c.b, depth: c.depth })), ids: [...conflictIds] }
    },
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
