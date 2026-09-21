import React, { useEffect, useRef, useState, useCallback } from 'react'
import Viewport from './components/Viewport'
import Sidebar from './components/Sidebar'
import { useStore } from './store/useStore'
import { useToolStore } from './store/useToolStore'
import { translations } from './utils/translations'
import { tryAddProfile } from './utils/profileFactory'
import { duplicateSelected, nudgeSelected, rotateSelected } from './utils/editOps'
import { Languages, Home, Ruler, MousePointer2, Pencil, Hand, Rotate3d } from 'lucide-react'
import type { Axis } from './utils/jointUtils'

const AXIS_COLORS: Record<string, string> = { x: '#ef4444', y: '#22c55e', z: '#3b82f6' }

function App() {
  const { clearSelection, removeSelected, undo, redo } = useStore()
  const {
    language, setLanguage, isDrawing, startPoint, currentPoint, drawAxis, lockedAxis, setLockedAxis, snapKind,
    viewMode, setViewMode, triggerCameraReset, cancelDraw, activeSpec,
    isDragging, showDimensionLabels, toggleDimensionLabels, showGizmo, toggleGizmo,
    selectMode, setSelectMode,
    isFrameSelecting, frameSelectStart, frameSelectCurrent,
    startFrameSelect, updateFrameSelect, endFrameSelect,
    toasts, showToast, dragConflict, hoverProfileId, snapGuides,
  } = useToolStore()
  const t = translations[language]

  // Exact-length input while drawing
  const [preciseInput, setPreciseInput] = useState('')
  const preciseInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (!isDrawing) setPreciseInput('') }, [isDrawing])

  const drawDist = isDrawing && startPoint && currentPoint ? startPoint.distanceTo(currentPoint) : 0

  const confirmPreciseLength = useCallback(() => {
    if (!startPoint || !currentPoint || startPoint.distanceTo(currentPoint) < 1) {
      showToast(t.toastNeedDirection, 'info')
      return
    }
    if (preciseInput.trim() === '') { showToast(t.toastNeedLength, 'info'); return }
    const len = parseFloat(preciseInput)
    if (!isFinite(len) || len < 10) { showToast(t.toastTooShort, 'error'); return }
    const dir = currentPoint.clone().sub(startPoint).normalize()
    const end = startPoint.clone().addScaledVector(dir, len)
    tryAddProfile(startPoint, end, activeSpec)
    cancelDraw()
    setPreciseInput('')
  }, [preciseInput, startPoint, currentPoint, activeSpec, cancelDraw, showToast, t])

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      const isInInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
      const mod = e.ctrlKey || e.metaKey

      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return }
      if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return }
      if (isInInput) return

      if (e.key === 'Escape') {
        if (isDrawing) cancelDraw()
        else if (selectMode) setSelectMode(false)
        else if (viewMode === 'draw') setViewMode('navigate')
        else clearSelection()
        return
      }

      if (isDrawing) {
        // Digits open the exact-length box; X/Y/Z lock the axis
        if (/^[0-9.]$/.test(e.key)) {
          e.preventDefault()
          const el = preciseInputRef.current
          if (el) { setPreciseInput(e.key); el.focus() }
          return
        }
        const k = e.key.toLowerCase()
        if (k === 'x' || k === 'y' || k === 'z') { setLockedAxis(lockedAxis === k ? null : (k as Axis)); return }
        return
      }

      if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); return }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelected(); return }
      if (e.key.toLowerCase() === 'r' && !mod) { rotateSelected('y', e.shiftKey ? -90 : 90); return }
      if (e.key.toLowerCase() === 'f' && !mod) { triggerCameraReset(); return }

      const step = e.shiftKey ? 50 : 5
      const nudge: Record<string, [number, number, number]> = {
        ArrowLeft: [-step, 0, 0], ArrowRight: [step, 0, 0],
        ArrowUp: [0, 0, -step], ArrowDown: [0, 0, step],
        PageUp: [0, step, 0], PageDown: [0, -step, 0],
      }
      if (nudge[e.key]) { e.preventDefault(); nudgeSelected(nudge[e.key]) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isDrawing, viewMode, selectMode, lockedAxis, cancelDraw, setViewMode, setSelectMode, setLockedAxis, removeSelected, undo, redo, clearSelection, triggerCameraReset])

  // A press outside the 3D canvas while drawing cancels it — otherwise the draw hangs with no way out
  useEffect(() => {
    if (!isDrawing) return
    const onDown = (e: PointerEvent) => {
      const el = e.target as HTMLElement | null
      if (!el || el.tagName === 'CANVAS') return
      if (el.closest('[data-keep-draw]')) return // the exact-length HUD
      cancelDraw()
      showToast(t.toastDrawCancelled, 'info')
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [isDrawing, cancelDraw, showToast, t])

  // Frame selection overlay
  const mainRef = useRef<HTMLDivElement>(null)
  const frameRect = isFrameSelecting && frameSelectStart && frameSelectCurrent ? {
    left: Math.min(frameSelectStart.x, frameSelectCurrent.x),
    top: Math.min(frameSelectStart.y, frameSelectCurrent.y),
    width: Math.abs(frameSelectCurrent.x - frameSelectStart.x),
    height: Math.abs(frameSelectCurrent.y - frameSelectStart.y),
  } : null

  const handleMainPointerDown = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).tagName !== 'CANVAS') return // toolbar / overlays
    if (viewMode !== 'navigate' || e.button !== 0) return
    // Plain selection and clearing are handled by PointerRouter (on release, so orbiting keeps it)
    if (selectMode) startFrameSelect(e.clientX, e.clientY)
  }, [selectMode, viewMode, startFrameSelect])

  const handleMainPointerMove = useCallback((e: React.PointerEvent) => {
    if (!isFrameSelecting) return
    if (isDragging) { endFrameSelect(e.clientX, e.clientY); return }
    updateFrameSelect(e.clientX, e.clientY)
  }, [isFrameSelecting, isDragging, updateFrameSelect, endFrameSelect])

  const handleMainPointerUp = useCallback((e: React.PointerEvent) => {
    if (!isFrameSelecting) return
    const canvasRect = mainRef.current?.getBoundingClientRect()
    if (canvasRect && frameSelectStart) {
      const dx = Math.abs(e.clientX - frameSelectStart.x)
      const dy = Math.abs(e.clientY - frameSelectStart.y)
      if (dx > 5 || dy > 5) {
        useToolStore.getState().setFrameSelectRect({
          x1: Math.min(frameSelectStart.x, e.clientX) - canvasRect.left,
          y1: Math.min(frameSelectStart.y, e.clientY) - canvasRect.top,
          x2: Math.max(frameSelectStart.x, e.clientX) - canvasRect.left,
          y2: Math.max(frameSelectStart.y, e.clientY) - canvasRect.top,
        })
      }
    }
    endFrameSelect(e.clientX, e.clientY)
  }, [isFrameSelecting, frameSelectStart, endFrameSelect])

  // What a press would do right now, so the pointer stops looking inert
  const viewportCursor = isDragging
    ? (dragConflict ? 'alias' : 'grabbing')
    : viewMode === 'draw' ? 'crosshair'
    : selectMode ? 'crosshair'
    : hoverProfileId ? 'grab'
    : 'default'

  const guide = selectMode ? t.guideSelect : viewMode === 'draw' ? t.guideDraw : t.guideNavigate
  const toolBtn = (active: boolean, activeCls: string) =>
    `flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all ${active ? activeCls : 'text-slate-400 hover:bg-slate-700/60 hover:text-white'}`

  return (
    <div className="w-full h-full bg-[#0f172a] flex flex-col overflow-hidden">
      <header className="h-14 bg-slate-800 border-b border-white/10 flex items-center px-6 text-white shadow-2xl z-20 shrink-0">
        <h1 className="text-lg font-black tracking-tighter flex items-center gap-3 uppercase">
          <div className="w-6 h-6 bg-blue-500 rounded-sm rotate-45 flex items-center justify-center text-[10px] text-white font-bold">AL</div>
          {t.title}
        </h1>

        <div className="ml-auto flex items-center gap-3">
          {/* what the drag has locked onto right now */}
          {isDragging && snapGuides.length > 0 && (
            <div data-testid="snap-hud"
              className="absolute top-[88px] left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-slate-900/90 border border-cyan-400/50 text-[11px] font-bold text-cyan-200 shadow-lg pointer-events-none z-10">
              {[...new Set(snapGuides.map((g) => t.snapAlign[g.kind] ?? g.kind))].join(' · ')}
            </div>
          )}

          {isDrawing && (
            <div className="flex items-center gap-2" data-testid="draw-hud" data-keep-draw>
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-mono font-bold border"
                style={drawAxis
                  ? { color: AXIS_COLORS[drawAxis], borderColor: AXIS_COLORS[drawAxis] + '66', background: AXIS_COLORS[drawAxis] + '15' }
                  : { color: '#94a3b8', borderColor: '#94a3b855', background: '#94a3b815' }}>
                <span>{drawAxis ? `${t.axisNames[drawAxis]}${lockedAxis ? ' 🔒 (X/Y/Z)' : ''}` : t.pickDirection}</span>
                <span className="opacity-60">|</span>
                <span data-testid="draw-length">{drawDist.toFixed(0)} mm</span>
                {snapKind && snapKind !== 'grid' && (<><span className="opacity-60">|</span><span data-testid="snap-kind" className="text-cyan-300">{t.snapNames[snapKind] ?? snapKind}</span></>)}
              </div>
              <div className="flex items-center gap-1 bg-slate-700/80 border border-white/10 rounded-full overflow-hidden">
                <input ref={preciseInputRef} type="number" value={preciseInput} data-testid="precise-input"
                  onChange={(e) => setPreciseInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); confirmPreciseLength() }
                    if (e.key === 'Escape') { e.preventDefault(); setPreciseInput(''); (e.target as HTMLInputElement).blur() }
                    e.stopPropagation()
                  }}
                  placeholder={t.exactMm}
                  className="w-28 bg-transparent px-3 py-1.5 text-xs font-mono text-white outline-none placeholder:text-slate-500" />
                <button onClick={confirmPreciseLength} disabled={!preciseInput}
                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-[11px] font-bold text-white">↵</button>
              </div>
            </div>
          )}
          <button onClick={() => setLanguage(language === 'en' ? 'zh' : 'en')}
            className="flex items-center gap-2 px-4 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-full text-xs font-bold shadow-lg active:scale-95">
            <Languages size={14} />{language === 'en' ? '中文' : 'English'}
          </button>
        </div>
      </header>

      <div className="flex-grow flex overflow-hidden">
        <Sidebar />
        <main
          ref={mainRef}
          className="flex-grow relative min-w-0"
          style={{ cursor: viewportCursor }}
          data-testid="viewport"
          onPointerDown={handleMainPointerDown}
          onPointerMove={handleMainPointerMove}
          onPointerUp={handleMainPointerUp}
        >
          <Viewport />

          {frameRect && frameRect.width > 3 && frameRect.height > 3 && (
            <div className="absolute pointer-events-none border border-blue-400/70 bg-blue-400/10 rounded-sm" style={{
              left: frameRect.left - (mainRef.current?.getBoundingClientRect().left ?? 0),
              top: frameRect.top - (mainRef.current?.getBoundingClientRect().top ?? 0),
              width: frameRect.width, height: frameRect.height,
            }} />
          )}

          {/* Toolbar */}
          <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-slate-900/90 backdrop-blur-md border border-white/10 rounded-xl p-1 shadow-2xl z-10">
            <button data-testid="mode-toggle" onClick={() => setViewMode(viewMode === 'draw' ? 'navigate' : 'draw')} title="Esc"
              className={toolBtn(viewMode === 'draw', 'bg-blue-600/20 text-blue-400 hover:bg-blue-600/40')}>
              {viewMode === 'draw' ? <><Pencil size={13} />{t.draw}</> : <><Hand size={13} />{t.navigate}</>}
            </button>
            <div className="w-px h-5 bg-white/10 mx-0.5" />
            <button data-testid="select-toggle" onClick={() => { if (viewMode === 'draw') setViewMode('navigate'); setSelectMode(!selectMode) }}
              className={toolBtn(selectMode, 'bg-violet-600/30 text-violet-400 border border-violet-500/30')}>
              <MousePointer2 size={13} />{t.selectMode}
            </button>
            <div className="w-px h-5 bg-white/10 mx-0.5" />
            <button onClick={toggleDimensionLabels} className={toolBtn(showDimensionLabels, 'bg-emerald-600/20 text-emerald-400')}>
              <Ruler size={13} />{t.labels}
            </button>
            <div className="w-px h-5 bg-white/10 mx-0.5" />
            <button data-testid="gizmo-toggle" onClick={toggleGizmo} title={t.gizmoHint}
              className={toolBtn(showGizmo, 'bg-amber-600/20 text-amber-400')}>
              <Rotate3d size={13} />{t.rotate3d}
            </button>
            <div className="w-px h-5 bg-white/10 mx-0.5" />
            <button data-testid="fit-view" onClick={triggerCameraReset} title="F" className={toolBtn(false, '')}>
              <Home size={13} />{t.home}
            </button>
          </div>

          {/* Guide */}
          <div className="absolute bottom-6 left-6 pointer-events-none bg-slate-900/80 backdrop-blur-xl px-4 py-3 rounded-xl border border-white/10 text-[10px] text-slate-400 space-y-1 shadow-2xl max-w-xs">
            <p className={`font-bold ${selectMode ? 'text-violet-400' : viewMode === 'draw' ? 'text-blue-400' : 'text-slate-200'}`}>
              {selectMode ? t.selectMode : viewMode === 'draw' ? `${t.draw} · ${activeSpec}` : t.navigate}
            </p>
            {guide.map((line, i) => <p key={i}>{line}</p>)}
          </div>

          {/* Toasts */}
          <div className="absolute top-20 right-6 flex flex-col gap-2 items-end pointer-events-none z-20" data-testid="toasts">
            {toasts.map((toast) => (
              <div key={toast.id} className={`px-4 py-2 rounded-lg text-xs font-bold shadow-2xl border backdrop-blur-md ${
                toast.kind === 'error' ? 'bg-red-600/80 border-red-400/40 text-white'
                : toast.kind === 'success' ? 'bg-emerald-600/80 border-emerald-400/40 text-white'
                : 'bg-slate-800/90 border-white/10 text-slate-200'}`}>
                {toast.message}
              </div>
            ))}
          </div>
        </main>
      </div>
    </div>
  )
}

export default App
