import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { useStore } from './store/useStore'
import { useToolStore } from './store/useToolStore'

// Dev-only hook for end-to-end tests: window.__aluframe.{store,tool}
if (import.meta.env.DEV) {
  ;(window as any).__aluframe = { store: useStore, tool: useToolStore }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
