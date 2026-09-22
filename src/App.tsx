import React, { useEffect, useRef, useState, useCallback } from 'react'
import Viewport from './components/Viewport'
import Sidebar from './components/Sidebar'
import QuickMenu from './components/QuickMenu'
import { useStore } from './store/useStore'
import { useToolStore } from './store/useToolStore'
import { translations } from './utils/translations'
import { tryAddProfile } from './utils/profileFactory'
import { duplicateSelected, nudgeSelected, rotateSelected, commitExactMove, commitExactLength, selectAll } from './utils/editOps'
import { connectorLabel } from './utils/connectorCatalog'
import { Languages, Home, Ruler, MousePointer2, Pencil, Hand, Rotate3d, X, Crosshair, Layers, Move3d, Maximize, Minimize } from 'lucide-react'
import type { Axis } from './utils/jointUtils'

const AXIS_COLORS: Record<string, string> = { x: '#ef4444', y: '#22c55e', z: '#3b82f6' }

function App() {
  const { clearSelection, removeSelected, undo, redo, toggleLockSelected } = useStore()
  const {
    language, setLanguage, isDrawing, startPoint, currentPoint, drawAxis, lockedAxis, setLockedAxis, snapKind,
    held, putDown, triggerCameraReset, cancelDraw, activeSpec, activeConnectorType,
    isDragging, showDimensionLabels, toggleDimensionLabels, showOverallDims, toggleOverallDims, showGizmo, toggleGizmo,
    pivotMode, cyclePivotMode, quickMenuAt, openQuickMenu, closeQuickMenu,
    workPlaneY, setWorkPlaneY,
    selectMode, setSelectMode,
    isFrameSelecting, frameSelectStart, frameSelectCurrent,
    startFrameSelect, updateFrameSelect, endFrameSelect,
    toasts, showToast, dragConflict, hoverProfileId, snapGuides, gizmoHover,
    dragMoved, resize, hoverCandidates,
  } = useToolStore()
  const t = translations[language]

  // Exact-length input while drawing
  const [workPlaneText, setWorkPlaneText] = useState('0')
  const [isFullscreen, setIsFullscreen] = useState(false)
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement !== null)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  const toggleFullscreen = useCallback(() => {
    // the whole app goes full screen, panel included: the panel is where the numbers are
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    else document.documentElement.requestFullscreen().catch(() => showToast(t.toastFullscreenBlocked, 'error'))
  }, [showToast, t])
  // the highest point of whatever is selected, so the work plane can be put on top of it
  const selectionTopY = useStore((st) => {
    const ids = new Set(st.selectedIds)
    if (ids.size === 0) return null
    let top = -Infinity
    for (const p of st.profiles) {
      if (!ids.has(p.id)) continue
      const [x, y, z, w] = p.quaternion
      const dy = 2 * (y * z - w * x)
      top = Math.max(top, p.position[1], p.position[1] + dy * p.length)
    }
    for (const c of st.connectors) if (ids.has(c.id)) top = Math.max(top, c.position[1])
    for (const b of st.panels) if (ids.has(b.id)) top = Math.max(top, b.position[1] + b.height / 2)
    return isFinite(top) ? Math.round(top) : null
  })

  const [preciseInput, setPreciseInput] = useState('')
  const preciseInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (!isDrawing) setPreciseInput('') }, [isDrawing])

  const drawDist = isDrawing && startPoint && currentPoint ? startPoint.distanceTo(currentPoint) : 0

  // Exact value for a gesture already under way: a move that has travelled, or a stretch
  const [exactInput, setExactInput] = useState('')
  const exactInputRef = useRef<HTMLInputElement>(null)
  const exactGesture: 'move' | 'resize' | null = resize ? 'resize' : (isDragging && dragMoved ? 'move' : null)
  // read from the key handler, which must not be rebuilt on every frame of a drag
  const exactGestureRef = useRef(exactGesture)
  exactGestureRef.current = exactGesture
  const quickMenuOpenRef = useRef(false)
  quickMenuOpenRef.current = quickMenuAt !== null
  useEffect(() => { if (!exactGesture) setExactInput('') }, [exactGesture])

  const confirmExact = useCallback(() => {
    const value = parseFloat(exactInput)
    if (!isFinite(value)) { showToast(t.toastNeedLength, 'info'); return }
    const done = exactGesture === 'resize' ? commitExactLength(value) : commitExactMove(value)
    if (done) setExactInput('')
  }, [exactInput, exactGesture, showToast, t])

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

      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        if (e.shiftKey) clearSelection()
        else selectAll()
        return
      }
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return }
      if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return }
      if (isInInput) return

      // Space always opens the menu; with nothing selected it carries the whole-document
      // actions instead. One key that always does something beats one that sometimes does.
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault()
        if (quickMenuOpenRef.current) closeQuickMenu()
        else openQuickMenu(cursorRef.current.x, cursorRef.current.y)
        return
      }

      if (e.key === 'Escape') {
        if (quickMenuOpenRef.current) { closeQuickMenu(); return }
        if (isDrawing) cancelDraw()
        else if (selectMode) setSelectMode(false)
        else if (held !== null) putDown()
        else clearSelection()
        return
      }

      // A gesture under way takes digits the same way drawing does
      if (exactGestureRef.current && /^[0-9.]$/.test(e.key)) {
        e.preventDefault()
        setExactInput(e.key)
        requestAnimationFrame(() => exactInputRef.current?.focus())
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
      if (e.key.toLowerCase() === 'f' && !mod) {
        if (e.shiftKey) toggleFullscreen(); else triggerCameraReset()
        return
      }
      if (e.key.toLowerCase() === 'p' && !mod) { cyclePivotMode(); return }
      if (e.key.toLowerCase() === 'l' && !mod) { toggleLockSelected(); return }

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
  }, [isDrawing, held, selectMode, lockedAxis, cancelDraw, putDown, setSelectMode, setLockedAxis, removeSelected, undo, redo, clearSelection, triggerCameraReset, cyclePivotMode, toggleLockSelected, openQuickMenu, closeQuickMenu, toggleFullscreen])

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
    if (held !== null || e.button !== 0) return
    // Plain selection and clearing are handled by PointerRouter (on release, so orbiting keeps it)
    if (selectMode) startFrameSelect(e.clientX, e.clientY)
  }, [selectMode, held, startFrameSelect])

  // the last pointer position on the canvas, so Space opens the menu under the cursor
  const cursorRef = useRef({ x: 0, y: 0 })

  const handleMainPointerMove = useCallback((e: React.PointerEvent) => {
    cursorRef.current = { x: e.clientX, y: e.clientY }
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
    : held !== null ? 'crosshair'
    : selectMode ? 'crosshair'
    : hoverProfileId ? 'grab'
    : 'default'

  const guide = selectMode ? t.guideSelect : held !== null ? t.guideDraw : t.guideNavigate
  // the part in hand, named the way the sidebar names it
  const heldName = held === 'connector'
    ? (activeConnectorType ? connectorLabel(activeConnectorType, language) : '')
    : activeSpec
  const toolBtn = (active: boolean, activeCls: string) =>
    `flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold whitespace-nowrap shrink-0 transition-all ${active ? activeCls : 'text-slate-400 hover:bg-slate-700/60 hover:text-white'}`
  /** the toggles: an icon and a tooltip, so nine of them still fit on one row */
  const iconBtn = (active: boolean, activeCls: string) =>
    `flex items-center justify-center w-8 h-8 rounded-lg shrink-0 transition-all ${active ? activeCls : 'text-slate-400 hover:bg-slate-700/60 hover:text-white'}`

  return (
    <div className="w-full h-full bg-[#0f172a] flex flex-col overflow-hidden">
      <header className="h-14 bg-slate-800 border-b border-white/10 flex items-center px-6 text-white shadow-2xl z-20 shrink-0">
        <h1 className="text-lg font-black tracking-tighter flex items-center gap-3 uppercase">
          <div className="w-6 h-6 bg-blue-500 rounded-sm rotate-45 flex items-center justify-center text-[10px] text-white font-bold">AL</div>
          {t.title}
        </h1>

        <div className="ml-auto flex items-center gap-3">
          {/* which gizmo handle the pointer is on */}
          {gizmoHover && !isDragging && (
            <div data-testid="gizmo-hint"
              className="absolute top-[88px] left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-slate-900/90 border border-white/15 text-[11px] font-bold text-slate-200 shadow-lg pointer-events-none z-10">
              {gizmoHover.kind === 'move' ? t.gizmoMove(gizmoHover.axis.toUpperCase()) : t.gizmoRotate(gizmoHover.axis.toUpperCase())}
            </div>
          )}

          {/* how many parts share these pixels, and which one is highlighted */}
          {!isDragging && !isDrawing && hoverCandidates.count > 1 && (
            <div data-testid="stacked-hud"
              className="absolute top-[124px] left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-slate-900/90 border border-white/15 text-[10px] font-bold text-slate-300 shadow-lg pointer-events-none z-10">
              {t.stacked(hoverCandidates.index + 1, hoverCandidates.count)}
            </div>
          )}

          {/* what the drag has locked onto right now */}
          {isDragging && snapGuides.length > 0 && (
            <div data-testid="snap-hud"
              className="absolute top-[88px] left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-slate-900/90 border border-cyan-400/50 text-[11px] font-bold text-cyan-200 shadow-lg pointer-events-none z-10">
              {[...new Set(snapGuides.map((g) => t.snapAlign[g.kind] ?? g.kind))].join(' · ')}
            </div>
          )}

          {/* Before the first click: what the start point would attach to. A click that finds
              nothing lands on the work plane, and that used to be invisible until the member
              appeared somewhere else entirely. */}
          {held !== null && !isDrawing && !isDragging && (
            <div data-testid="start-hud"
              className={`absolute top-[88px] left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full border text-[11px] font-bold shadow-lg pointer-events-none z-10 ${
                snapKind ? 'bg-slate-900/90 border-cyan-400/50 text-cyan-200' : 'bg-slate-900/90 border-white/15 text-slate-400'}`}>
              {t.startsOn}：{snapKind ? (t.snapNames[snapKind] ?? snapKind) : t.startsOnPlane(workPlaneY)}
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

          {/* Typing a number mid-gesture finishes it exactly: how far to move, or how long
              the member should be. The mouse gets the direction, the keyboard the size. */}
          {exactGesture && (
            <div className="flex items-center gap-2" data-testid="exact-hud" data-keep-draw>
              <div className="px-3 py-1.5 rounded-full text-xs font-mono font-bold border text-amber-200 border-amber-400/50 bg-amber-500/10">
                {exactGesture === 'move' ? t.exactMove : t.exactLength}
              </div>
              <div className="flex items-center gap-1 bg-slate-700/80 border border-white/10 rounded-full overflow-hidden">
                <input ref={exactInputRef} type="number" value={exactInput} data-testid="exact-input"
                  onChange={(e) => setExactInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); confirmExact() }
                    if (e.key === 'Escape') { e.preventDefault(); setExactInput('') }
                    e.stopPropagation()
                  }}
                  placeholder={t.exactMm}
                  className="w-28 bg-transparent px-3 py-1.5 text-xs font-mono text-white outline-none placeholder:text-slate-500" />
                <button onClick={confirmExact} disabled={!exactInput} data-testid="exact-confirm"
                  className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-[11px] font-bold text-white">↵</button>
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
          {/* One row, never wrapped: the toggles carry an icon and a tooltip, and only the
              two things that change constantly — what is in hand and the work plane — keep
              their words. A toolbar that wraps into a column is worse than a short label. */}
          <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-0.5 flex-nowrap whitespace-nowrap max-w-[calc(100%-2rem)] overflow-x-auto bg-slate-900/90 backdrop-blur-md border border-white/10 rounded-xl p-1 shadow-2xl z-10">
            {/* What is in hand, and the way to put it down. Not a mode switch: it only ever
                empties the hand, because filling it is the sidebar's job. */}
            {/* the label is the part's name, but the accessible name says what the button does,
                so it is never confused with the sidebar button carrying the same name */}
            <button data-testid="held-chip" onClick={() => { if (held !== null) putDown() }}
              disabled={held === null} title={held !== null ? t.holdingHint : t.emptyHand}
              aria-label={held !== null ? `${t.putDown} ${heldName}` : t.emptyHand}
              className={toolBtn(held !== null, 'bg-blue-600/20 text-blue-400 hover:bg-blue-600/40')}>
              {held !== null
                ? <><Pencil size={13} />{heldName}<X size={11} className="opacity-60" /></>
                : <><Hand size={13} />{t.emptyHand}</>}
            </button>
            {/* The height a click falls to when nothing is under it. It used to be the floor,
                silently; a member aimed at a post top then landed metres away. */}
            <div className="flex items-center gap-1 px-1.5 py-1 rounded-lg shrink-0" title={t.workPlaneHint}>
              <Layers size={13} className={workPlaneY > 0 ? 'text-amber-400' : 'text-slate-400'} />
              <input type="number" step={10} min={0} value={workPlaneText} data-testid="work-plane"
                onChange={(e) => { setWorkPlaneText(e.target.value); setWorkPlaneY(parseFloat(e.target.value)) }}
                className={`w-14 bg-slate-950 border rounded px-1.5 py-0.5 text-[11px] font-mono outline-none ${
                  workPlaneY > 0 ? 'border-amber-500/40 text-amber-300' : 'border-white/10 text-slate-300'}`} />
              <button data-testid="work-plane-from-selection" title={t.workPlaneFromSelection}
                disabled={selectionTopY === null}
                onClick={() => { if (selectionTopY !== null) { setWorkPlaneY(selectionTopY); setWorkPlaneText(String(selectionTopY)) } }}
                className="px-1.5 py-0.5 rounded text-[10px] font-bold text-slate-400 hover:bg-white/10 disabled:opacity-30">↥</button>
            </div>
            <div className="w-px h-5 bg-white/10 mx-0.5 shrink-0" />
            <button data-testid="select-toggle" onClick={() => { putDown(); setSelectMode(!selectMode) }}
              title={t.selectMode} aria-label={t.selectMode}
              className={iconBtn(selectMode, 'bg-violet-600/30 text-violet-400')}>
              <MousePointer2 size={14} />
            </button>
            <div className="w-px h-5 bg-white/10 mx-0.5 shrink-0" />
            <button onClick={toggleDimensionLabels} data-testid="labels-toggle" title={t.labels} aria-label={t.labels}
              className={iconBtn(showDimensionLabels, 'bg-emerald-600/20 text-emerald-400')}>
              <Ruler size={14} />
            </button>
            <button onClick={toggleOverallDims} data-testid="overall-dims-toggle" title={t.overallDimsHint} aria-label={t.overallDims}
              className={iconBtn(showOverallDims, 'bg-emerald-600/20 text-emerald-400')}>
              <Move3d size={14} />
            </button>
            <div className="w-px h-5 bg-white/10 mx-0.5 shrink-0" />
            <button data-testid="gizmo-toggle" onClick={toggleGizmo} title={t.gizmoHint} aria-label={t.rotate3d}
              className={iconBtn(showGizmo, 'bg-amber-600/20 text-amber-400')}>
              <Rotate3d size={14} />
            </button>
            {/* Where the selection turns about. The gizmo moves onto it, so the choice is visible. */}
            <button data-testid="pivot-toggle" onClick={cyclePivotMode} title={t.pivotHint}
              aria-label={t.pivotHint}
              className={toolBtn(pivotMode !== 'center', 'bg-amber-600/20 text-amber-400')}>
              <Crosshair size={13} />{pivotMode === 'center' ? t.pivotCenter : pivotMode === 'start' ? t.pivotStart : t.pivotEnd}
            </button>
            <div className="w-px h-5 bg-white/10 mx-0.5 shrink-0" />
            <button data-testid="fullscreen-toggle" onClick={toggleFullscreen} title={`${t.fullscreen} (Shift+F)`}
              aria-label={t.fullscreen} className={iconBtn(isFullscreen, 'bg-slate-600/40 text-slate-100')}>
              {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
            </button>
            <div className="w-px h-5 bg-white/10 mx-0.5 shrink-0" />
            <button data-testid="fit-view" onClick={triggerCameraReset} title={`${t.fitView} (F)`} aria-label={t.fitView}
              className={iconBtn(false, '')}>
              <Home size={14} />
            </button>
          </div>

          {/* Guide */}
          <div className="absolute bottom-6 left-6 pointer-events-none bg-slate-900/80 backdrop-blur-xl px-4 py-3 rounded-xl border border-white/10 text-[10px] text-slate-400 space-y-1 shadow-2xl max-w-xs">
            <p className={`font-bold ${selectMode ? 'text-violet-400' : held !== null ? 'text-blue-400' : 'text-slate-200'}`}>
              {selectMode ? t.selectMode : held !== null ? `${t.draw} · ${heldName}` : t.emptyHand}
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
      <QuickMenu />
    </div>
  )
}

export default App
