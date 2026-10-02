import React, { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react'
import Viewport from './components/Viewport'
import Sidebar from './components/Sidebar'
import QuickMenu from './components/QuickMenu'
import Tooltip from './components/Tooltip'
import RecoveryNotice from './components/RecoveryNotice'
import AutoSaveStatus from './components/AutoSaveStatus'
import { useStore } from './store/useStore'
import { useToolStore } from './store/useToolStore'
import { translations } from './utils/translations'
import { tryAddProfile } from './utils/profileFactory'
import { drawingInput, prepareDrawingPreview } from './utils/drawPreview'
import { duplicateSelected, nudgeSelected, rotateSelected, commitExactMove, commitExactLength, selectAll } from './utils/editOps'
import { connectorLabel } from './utils/connectorCatalog'
import { nextSuggestion, dismissSuggestion } from './utils/suggestOps'
import { computeTrims } from './utils/jointUtils'
import { getProfileEndpoints } from './utils/geometryCore'
import { profileFace, type ProfileFaceRef } from './utils/profileFaces'
import { Languages, Home, Ruler, MousePointer2, Pencil, Hand, Rotate3d, RotateCw, X, Crosshair, Maximize, Minimize, Plus, Minus, Eye, PencilRuler, HelpCircle, DoorOpen, DoorClosed, Lightbulb } from 'lucide-react'
import type { Axis } from './utils/jointUtils'

const AXIS_COLORS: Record<string, string> = { x: '#ef4444', y: '#22c55e', z: '#3b82f6' }

function App() {
  const { profiles, throughRule, clearSelection, removeSelected, undo, redo, toggleLockSelected } = useStore()
  const {
    language, setLanguage, isDrawing, startPoint, currentPoint, drawAxis, lockedAxis, setLockedAxis, snapKind, drawStartFace, drawSnapFace, drawStartAlignmentFace, drawSnapAlignmentFace,
    drawLengthInput: preciseInput, setDrawLengthInput: setPreciseInput,
    held, putDown, triggerCameraReset, setCameraView, zoomBy, cancelDraw, activeSpec, activeConnectorType,
    isDragging, showDimensionLabels, toggleDimensionLabels, showGizmo, toggleGizmo,
    pivotMode, cyclePivotMode, quickMenuAt, openQuickMenu, closeQuickMenu,
    selectMode, setSelectMode,
    isFrameSelecting, frameSelectStart, frameSelectCurrent,
    startFrameSelect, updateFrameSelect, endFrameSelect,
    toasts, showToast, dragConflict, hoverPartId, snapGuides, gizmoHover,
    dragMoved, resize, hoverCandidates, workPlaneY,
    pendingRotate, setPendingRotate, viewMode, setViewMode, helpOpen, toggleHelp, showFittings, toggleFittings,
    measuring, startMeasuring, stopMeasuring, suggestion,
  } = useToolStore()
  const t = translations[language]
  const faceName = (ref: ProfileFaceRef) => {
    if (ref.axis === 2) return t.faceNames[`2:${ref.side}`]
    const member = profiles.find((p) => p.id === ref.profileId)
    if (!member) return t.faceNames[`${ref.axis}:${ref.side}`]
    const { normal } = profileFace(member, ref)
    const worldAxis = normal.findIndex((v) => Math.abs(v) > 1 - 1e-6)
    return worldAxis < 0 ? t.obliqueFace : t.faceDirection('XYZ'[worldAxis], normal[worldAxis])
  }

  // Exact-length input while drawing
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false)
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
  const preciseInputRef = useRef<HTMLInputElement>(null)
  const drawingPreview = useMemo(() => isDrawing && startPoint && currentPoint
    ? prepareDrawingPreview(startPoint, currentPoint, activeSpec, profiles, { startFace: drawStartFace, endFace: drawSnapFace, startAlignmentFace: drawStartAlignmentFace }, preciseInput)
    : null, [isDrawing, startPoint, currentPoint, activeSpec, profiles, throughRule, drawStartFace, drawSnapFace, drawStartAlignmentFace, preciseInput])
  const endContact = drawingPreview?.contacts.find((contact) => contact.end === 'end')
  const invalidLengthInput = preciseInput.trim() !== '' && (!Number.isFinite(Number(preciseInput)) || Number(preciseInput) < 10)

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
    const input = drawingInput(startPoint, currentPoint, { startFace: drawStartFace, endFace: drawSnapFace, startAlignmentFace: drawStartAlignmentFace }, preciseInput)
    if (!input) { showToast(t.toastTooShort, 'error'); return }
    if (!tryAddProfile(startPoint, input.end, activeSpec, input.faces)) return
    cancelDraw()
    setPreciseInput('')
  }, [preciseInput, startPoint, currentPoint, activeSpec, drawStartFace, drawSnapFace, drawStartAlignmentFace, cancelDraw, showToast, t])

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      const isInInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
        || (e.target as HTMLElement)?.isContentEditable
      const mod = e.ctrlKey || e.metaKey

      // Text editing and native button activation belong to the focused control.
      const nativeButtonKey = tag === 'BUTTON' && !mod && (
        [' ', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)
        || e.code === 'Space'
      )
      if (isInInput || nativeButtonKey) return
      if (viewMode && mod && ['z', 'y'].includes(e.key.toLowerCase())) { e.preventDefault(); return }

      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        if (e.shiftKey) clearSelection()
        else selectAll()
        return
      }
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return }
      if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return }

      // Looking, not building: the view keys still work, the ones that change things do not.
      if (viewMode && !['Escape', 'f', 'F', 'F11', ' '].includes(e.key) && e.code !== 'Space') {
        if (e.key.toLowerCase() === 'v') { setViewMode(false); return }
        return
      }
      if (e.key.toLowerCase() === 'v' && !mod) { setViewMode(!viewMode); return }

      // Space opens selection actions or whole-document actions when nothing is selected.
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault()
        if (quickMenuOpenRef.current) closeQuickMenu()
        else openQuickMenu(cursorRef.current.x, cursorRef.current.y)
        return
      }

      if (e.key === 'Escape') {
        if (mobileToolsOpen) { setMobileToolsOpen(false); return }
        if (helpOpen) { toggleHelp(); return }
        // the suggestion is the lightest thing on screen, so it goes first
        if (useToolStore.getState().suggestion) { dismissSuggestion(); return }
        // a turn waiting for its axis is the innermost thing Escape can back out of
        if (pendingRotate) { setPendingRotate(null); return }
        if (measuring) { stopMeasuring(); return }
        if (quickMenuOpenRef.current) { closeQuickMenu(); return }
        if (isDrawing) cancelDraw()
        else if (selectMode) setSelectMode(false)
        else if (held !== null) putDown()
        else clearSelection()
        return
      }

      // A gesture under way takes digits the same way drawing does
      if (exactGestureRef.current && (/^[0-9.]$/.test(e.key) || (exactGestureRef.current === 'move' && e.key === '-'))) {
        e.preventDefault()
        setExactInput(e.key)
        exactInputRef.current?.focus()
        return
      }

      if (e.key.toLowerCase() === 'f' && !mod) {
        triggerCameraReset(useStore.getState().selectedIds.length > 0 ? 'selection' : 'all')
        return
      }

      // N: suggest the next member. A half-drawn line is given up first — the suggestion
      // is a member of its own, not the end of that one.
      if (e.key.toLowerCase() === 'n' && !mod && !measuring) {
        e.preventDefault()
        if (isDrawing) cancelDraw()
        nextSuggestion()
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
      // R requests a rotation axis; X/Y/Z supplies it.
      if (pendingRotate) {
        const k = e.key.toLowerCase()
        if (k === 'x' || k === 'y' || k === 'z') {
          e.preventDefault()
          rotateSelected(k as 'x' | 'y' | 'z', pendingRotate.degrees)
          setPendingRotate(null)
          return
        }
        setPendingRotate(null)
      }
      if (e.key.toLowerCase() === 'r' && !mod) {
        if (useStore.getState().selectedIds.length === 0) { showToast(t.toastRotateNeedsSelection, 'info'); return }
        setPendingRotate({ degrees: e.shiftKey ? -90 : 90 })
        return
      }
      if (e.key === 'F11') { e.preventDefault(); toggleFullscreen(); return }
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
  }, [isDrawing, held, selectMode, lockedAxis, pendingRotate, setPendingRotate, viewMode, setViewMode, measuring, stopMeasuring, showToast, t, cancelDraw, putDown, setSelectMode, setLockedAxis, removeSelected, undo, redo, clearSelection, triggerCameraReset, cyclePivotMode, toggleLockSelected, openQuickMenu, closeQuickMenu, toggleFullscreen, mobileToolsOpen, helpOpen, toggleHelp])

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
  const toolbarRef = useRef<HTMLDivElement>(null)
  const [hudTop, setHudTop] = useState(124)
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current
    const viewport = mainRef.current
    if (!toolbar || !viewport) return
    const update = () => setHudTop(Math.ceil(toolbar.getBoundingClientRect().bottom) + 8)
    const observer = new ResizeObserver(update)
    observer.observe(toolbar)
    observer.observe(viewport)
    window.addEventListener('resize', update)
    update()
    return () => { observer.disconnect(); window.removeEventListener('resize', update) }
  }, [])
  const frameRect = isFrameSelecting && frameSelectStart && frameSelectCurrent ? {
    left: Math.min(frameSelectStart.x, frameSelectCurrent.x),
    top: Math.min(frameSelectStart.y, frameSelectCurrent.y),
    width: Math.abs(frameSelectCurrent.x - frameSelectStart.x),
    height: Math.abs(frameSelectCurrent.y - frameSelectStart.y),
  } : null

  const handleMainPointerDown = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).tagName !== 'CANVAS') return // toolbar / overlays
    mainRef.current?.focus({ preventScroll: true })
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
    : gizmoHover?.kind === 'rotate' ? 'pointer'
    : gizmoHover?.kind === 'move' ? 'grab'
    : held !== null ? 'crosshair'
    : selectMode ? 'crosshair'
    : hoverPartId ? 'grab'
    : 'default'

  // the part in hand, named the way the sidebar names it
  const heldName = held === 'connector'
    ? (activeConnectorType ? connectorLabel(activeConnectorType, language) : '')
    : activeSpec
  const pivotName = pivotMode === 'center' ? t.pivotCenter : pivotMode === 'start' ? t.pivotStart : t.pivotEnd
  /** the toolbar is icons: the name lives in the tooltip and the accessible name */
  const iconBtn = (active: boolean, activeCls: string) =>
    `flex items-center justify-center gap-1 min-w-11 h-11 px-1 md:px-0 md:min-w-0 md:w-8 md:h-8 rounded-lg shrink-0 transition-all ${active ? activeCls : 'text-slate-400 hover:bg-slate-700/60 hover:text-white'}`
  const toolBtn = (active: boolean, activeCls: string) =>
    `flex items-center gap-1.5 min-h-11 md:min-h-0 px-2.5 py-1.5 rounded-lg text-[11px] font-bold whitespace-nowrap shrink-0 transition-all ${active ? activeCls : 'text-slate-400 hover:bg-slate-700/60 hover:text-white'}`
  const advancedTools = `${mobileToolsOpen ? 'flex' : 'hidden'} md:flex flex-wrap md:flex-nowrap justify-center items-center gap-0.5 max-w-full order-2 md:order-none`
  const mobileLabel = (label: string) => <span className="md:hidden text-[10px] font-bold">{label}</span>

  return (
    <div className="w-full h-full bg-[#0f172a] flex flex-col overflow-hidden">
      <header className="h-14 bg-slate-800 border-b border-white/10 flex items-center px-3 md:px-6 gap-2 text-white shadow-2xl z-20 shrink-0">
        <h1 className="min-w-0 text-sm md:text-lg font-black tracking-tighter flex items-center gap-2 md:gap-3 uppercase">
          <div className="w-6 h-6 bg-blue-500 rounded-sm rotate-45 flex items-center justify-center text-[10px] text-white font-bold">AL</div>
          <span className="truncate">{t.title}</span>
        </h1>

        <div className="ml-auto flex items-center gap-3">
          {/* which gizmo handle the pointer is on */}
          {gizmoHover && !isDragging && (
            <div data-testid="gizmo-hint"
              style={{ top: hudTop }} className="absolute left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-slate-900/90 border border-white/15 text-[11px] font-bold text-slate-200 shadow-lg pointer-events-none z-10">
              {gizmoHover.kind === 'move' ? t.gizmoMove(gizmoHover.axis.toUpperCase()) : t.gizmoRotateHint(gizmoHover.axis.toUpperCase())}
            </div>
          )}

          {/* how many parts share these pixels, and which one is highlighted */}
          {!isDragging && !isDrawing && hoverCandidates.count > 1 && (
            <div data-testid="stacked-hud"
              style={{ top: hudTop + 36 }} className="absolute left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-slate-900/90 border border-white/15 text-[10px] font-bold text-slate-300 shadow-lg pointer-events-none z-10">
              {t.stacked(hoverCandidates.index + 1, hoverCandidates.count)}
            </div>
          )}

          {/* what the drag has locked onto right now */}
          {isDragging && snapGuides.length > 0 && (
            <div data-testid="snap-hud"
              style={{ top: hudTop }} className="absolute left-1/2 -translate-x-1/2 w-max max-w-[calc(100vw-1rem)] text-center px-3 py-1.5 rounded-full bg-slate-900/90 border border-cyan-400/50 text-[11px] font-bold text-cyan-200 shadow-lg pointer-events-none z-10">
              {snapGuides.map((g) => `${t.snapAlign[g.kind] ?? g.kind}${g.kind === 'endpoint' ? '' : ` · ${'XYZ'[g.axis]}=${Number(g.coord.toFixed(3))} mm`}`).join(' / ')}
            </div>
          )}

          {/* Suggested member dimensions. */}
          {suggestion && (() => {
            const m = suggestion.cand.member
            const cut = Math.round(computeTrims(m, [...useStore.getState().profiles, m]).cutLength)
            const ends = getProfileEndpoints(m)
            const lo = Math.round(Math.min(ends.start.y, ends.end.y))
            return (
              <div data-testid="suggest-card"
                className="absolute bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded-2xl border border-emerald-400/50 bg-slate-900/90 text-[11px] shadow-lg pointer-events-none z-10 text-center space-y-0.5">
                <div className="font-mono font-bold text-emerald-300">
                  {t.suggestNo(suggestion.index)} · {m.spec} · {t.suggestCut} {cut} mm · {t.suggestAt} y={lo}
                </div>
                <div className="text-slate-200">{suggestion.cand.reasons.map((r) => t.suggestReason[r] ?? r).join(' · ')}</div>
                <div className="text-[10px] text-slate-400">{t.suggestHow}</div>
              </div>
            )
          })()}

          {held !== null && !isDrawing && !isDragging && !suggestion && (
            <div data-testid="start-hud"
              className={`absolute bottom-6 left-1/2 -translate-x-1/2 w-max max-w-[calc(100vw-1rem)] text-center px-3 py-1.5 rounded-full border text-[11px] font-bold shadow-lg pointer-events-none z-10 ${
                snapKind ? 'bg-slate-900/90 border-cyan-400/50 text-cyan-200' : 'bg-slate-900/90 border-white/15 text-slate-400'}`}>
              {t.startsOn}：{snapKind ? (t.snapNames[snapKind] ?? snapKind) : t.startsOnPlane(workPlaneY)}
              {drawSnapFace && <span data-testid="start-face-kind"> · {faceName(drawSnapFace)}</span>}
              {drawSnapAlignmentFace && <span data-testid="start-edge-kind"> · {drawSnapAlignmentFace.axis === 2 ? t.drawEdgeAlignment : t.drawJointAlignment}：{faceName(drawSnapAlignmentFace)}</span>}
            </div>
          )}

          {/* R asked for an axis: say so, and colour the three letters the way the gizmo does */}
          {pendingRotate && (
            <div data-testid="rotate-axis-hud"
              className="absolute bottom-6 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full border border-amber-400/50 bg-slate-900/90 text-[11px] font-bold shadow-lg pointer-events-none z-10 text-amber-200 flex items-center gap-1.5">
              <RotateCw size={12} />
              {pendingRotate.degrees > 0 ? '+90°' : '−90°'} ·
              {(['x', 'y', 'z'] as const).map((a) => (
                <kbd key={a} className="px-1.5 py-0.5 rounded bg-white/10 uppercase" style={{ color: AXIS_COLORS[a] }}>{a}</kbd>
              ))}
            </div>
          )}

          {isDrawing && (
            <div style={{ top: hudTop }} className="absolute left-2 right-2 md:static flex flex-wrap justify-center items-center gap-2 bg-slate-900/95 md:bg-transparent rounded-xl p-2 md:p-0" data-testid="draw-hud" data-keep-draw>
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-mono font-bold border"
                style={drawAxis
                  ? { color: AXIS_COLORS[drawAxis], borderColor: AXIS_COLORS[drawAxis] + '66', background: AXIS_COLORS[drawAxis] + '15' }
                  : { color: '#94a3b8', borderColor: '#94a3b855', background: '#94a3b815' }}>
                <span>{drawAxis ? `${t.axisNames[drawAxis]}${lockedAxis ? ' 🔒 (X/Y/Z)' : ''}` : t.pickDirection}</span>
                <span className="opacity-60">|</span>
                <span data-testid="draw-length">{invalidLengthInput ? '—' : (drawingPreview?.cutLength ?? 0).toFixed(0)} mm</span>
                {snapKind && snapKind !== 'grid' && (<><span className="opacity-60">|</span><span data-testid="snap-kind" className="text-cyan-300">{endContact ? t.drawContactKinds[endContact.kind] : t.snapNames[snapKind] ?? snapKind}</span></>)}
              </div>
              <div className="flex items-center gap-1 bg-slate-700/80 border border-white/10 rounded-full overflow-hidden">
                <input ref={preciseInputRef} type="text" inputMode="decimal" value={preciseInput} data-testid="precise-input" aria-label={t.exactLength} aria-invalid={invalidLengthInput}
                  onChange={(e) => setPreciseInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); confirmPreciseLength() }
                    if (e.key === 'Escape') { e.preventDefault(); setPreciseInput(''); (e.target as HTMLInputElement).blur() }
                    e.stopPropagation()
                  }}
                  placeholder={t.exactMm}
                  className="w-28 bg-transparent px-3 py-1.5 text-xs font-mono text-white outline-none placeholder:text-slate-500" />
                <button onClick={confirmPreciseLength} disabled={!preciseInput || invalidLengthInput || !drawingPreview || drawingPreview.blocked} title={t.hintConfirmLength}
                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-[11px] font-bold text-white">↵</button>
              </div>
              {!!drawingPreview?.contacts.length && <div data-testid="draw-face-hud" className="basis-full flex flex-wrap justify-center gap-x-4 gap-y-1 text-[10px] md:text-[11px] leading-tight">
                {drawingPreview.contacts.map((contact) => <span key={`${contact.end}-${contact.purpose ?? 'contact'}`} data-testid={`draw-${contact.end}-${contact.purpose ?? 'contact'}`}
                  className={contact.kind === 'rejected' ? 'text-rose-300' : 'text-cyan-300'}>
                  {contact.purpose === 'alignment' ? (contact.referenceFace.axis === 2 ? t.drawEdgeAlignment : t.drawJointAlignment) : `${t.drawEnds[contact.end]} · ${t.drawContactKinds[contact.kind]}`} · {faceName(contact.referenceFace)}
                  <span className="ml-1 font-mono opacity-80">({contact.referenceAnchor.map((v) => Math.round(v)).join(', ')}) mm</span>
                </span>)}
                <span className="text-slate-400"><span className="text-amber-300">{t.drawNewFace}</span> · <span className="text-cyan-300">{t.drawReferenceFace}</span></span>
              </div>}
            </div>
          )}

          {/* Typing a number mid-gesture finishes it exactly: how far to move, or how long
              the member should be. The mouse gets the direction, the keyboard the size. */}
          {exactGesture && (
            <div style={{ top: hudTop }} className="absolute left-2 right-2 md:static flex flex-wrap justify-center items-center gap-2 bg-slate-900/95 md:bg-transparent rounded-xl p-2 md:p-0" data-testid="exact-hud" data-keep-draw>
              <div className="px-3 py-1.5 rounded-full text-xs font-mono font-bold border text-amber-200 border-amber-400/50 bg-amber-500/10">
                {exactGesture === 'move' ? t.exactMove : t.exactLength}
              </div>
              <div className="flex items-center gap-1 bg-slate-700/80 border border-white/10 rounded-full overflow-hidden">
                <input ref={exactInputRef} type="number" value={exactInput} data-testid="exact-input" aria-label={exactGesture === 'move' ? t.exactMove : t.exactLength}
                  onChange={(e) => setExactInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); confirmExact() }
                    if (e.key === 'Escape') { e.preventDefault(); setExactInput(''); (e.target as HTMLInputElement).blur() }
                    e.stopPropagation()
                  }}
                  placeholder={t.exactMm}
                  className="w-28 bg-transparent px-3 py-1.5 text-xs font-mono text-white outline-none placeholder:text-slate-500" />
                <button onClick={confirmExact} disabled={!exactInput} data-testid="exact-confirm" title={t.hintConfirmMove}
                  className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-[11px] font-bold text-white">↵</button>
              </div>
            </div>
          )}
          <button data-keep-draw onClick={() => setLanguage(language === 'en' ? 'zh' : 'en')} title={t.hintLanguage}
            className="flex items-center gap-2 px-4 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-full text-xs font-bold shadow-lg active:scale-95">
            <Languages size={14} />{language === 'en' ? '中文' : 'English'}
          </button>
        </div>
      </header>
      <RecoveryNotice />
      <AutoSaveStatus />

      {/* Side by side where there is room, stacked where there is not: on a phone the
          drawing takes the screen and the panel is a sheet along the bottom edge. */}
      <div className="flex-grow min-h-0 flex overflow-hidden flex-col md:flex-row">
        <Sidebar />
        <main
          ref={mainRef}
          className="flex-grow relative min-w-0 min-h-0"
          style={{ cursor: viewportCursor }}
          data-testid="viewport"
          tabIndex={0} role="region" aria-label={t.title}
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
          {/* Keep related controls together and wrap whole groups when the viewport is
              narrow. Every action stays visible, including when the held part or pivot
              label makes the toolbar wider. The drawing HUD follows its measured height. */}
          <div ref={toolbarRef} data-testid="viewport-toolbar" className="absolute top-2 md:top-4 left-1/2 -translate-x-1/2 flex items-center justify-center gap-0.5 flex-wrap whitespace-nowrap w-[calc(100%-1rem)] md:w-auto max-w-[calc(100%-1rem)] bg-slate-900/90 backdrop-blur-md border border-white/10 rounded-xl p-1 shadow-2xl z-10">
            {/* What is in hand, and the way to put it down. Not a mode switch: it only ever
                empties the hand, because filling it is the sidebar's job. */}
            {/* the label is the part's name, but the accessible name says what the button does,
                so it is never confused with the sidebar button carrying the same name */}
            <button data-testid="held-chip" onClick={() => { if (held !== null) putDown() }}
              disabled={held === null} title={held !== null ? t.holdingHint : t.emptyHand}
              aria-label={held !== null ? `${t.putDown} ${heldName}` : t.emptyHand}
              className={held !== null
                ? toolBtn(true, 'bg-blue-600/20 text-blue-400 hover:bg-blue-600/40')
                : 'flex items-center justify-center min-w-11 h-11 md:w-8 md:h-8 rounded-lg shrink-0 text-slate-400'}>
              {held !== null
                ? <><Pencil size={13} />{heldName}<X size={11} className="opacity-60" /></>
                : <Hand size={14} />}
            </button>
            <div className="hidden md:block w-px h-5 bg-white/10 mx-0.5 shrink-0" />
            <button data-testid="select-toggle" onClick={() => { putDown(); setSelectMode(!selectMode) }}
              title={t.selectMode} aria-label={t.selectMode}
              aria-pressed={selectMode}
              className={iconBtn(selectMode, 'bg-violet-600/30 text-violet-400')}>
              <MousePointer2 size={14} />{mobileLabel(t.selectMode)}
            </button>
            <div className="hidden md:block w-px h-5 bg-white/10 mx-0.5 shrink-0" />
            <div className={advancedTools}>
            {/* One switch for every measurement on the drawing: the cut length on each member
                and the overall size around it are the same question asked at two scales. */}
            <button data-keep-draw onClick={toggleFittings} data-testid="fittings-toggle" title={t.hintShowFittings}
              aria-pressed={showFittings}
              aria-label={t.showFittings} className={iconBtn(!showFittings, 'bg-slate-600/40 text-slate-100')}>
              {showFittings ? <DoorOpen size={14} /> : <DoorClosed size={14} />}{mobileLabel(t.showFittings)}
            </button>
            <button data-keep-draw onClick={toggleDimensionLabels} data-testid="labels-toggle" title={t.labelsHint}
              aria-pressed={showDimensionLabels}
              aria-label={t.labels} className={iconBtn(showDimensionLabels, 'bg-emerald-600/20 text-emerald-400')}>
              <Ruler size={14} />{mobileLabel(t.labels)}
            </button>
            <div className="w-px h-5 bg-white/10 mx-0.5 shrink-0" />
            <button data-keep-draw data-testid="gizmo-toggle" onClick={toggleGizmo} title={t.gizmoHint}
              aria-pressed={showGizmo}
              aria-label={t.rotate3d} className={iconBtn(showGizmo, 'bg-amber-600/20 text-amber-400')}>
              <Rotate3d size={14} />{mobileLabel(t.rotate3d)}
            </button>
            {/* Where the selection turns about. The gizmo moves onto it, so the choice is visible. */}
            <button data-keep-draw data-testid="pivot-toggle" onClick={cyclePivotMode} title={`${t.pivot}: ${pivotName} · ${t.pivotHint}`}
              aria-label={`${t.pivot}: ${pivotName} (P)`}
              className={toolBtn(pivotMode !== 'center', 'bg-amber-600/20 text-amber-400')}>
              <Crosshair size={14} /><span>{pivotName}</span>
            </button>
            <div className="w-px h-5 bg-white/10 mx-0.5 shrink-0" />
            <button data-keep-draw data-testid="fullscreen-toggle" onClick={toggleFullscreen} title={`${t.fullscreen} (F11)`}
              aria-pressed={isFullscreen}
              aria-label={t.fullscreen} className={iconBtn(isFullscreen, 'bg-slate-600/40 text-slate-100')}>
              {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}{mobileLabel(t.fullscreen)}
            </button>
            </div>
            <div className="hidden md:block w-px h-5 bg-white/10 mx-0.5 shrink-0" />
            {/* Building or looking: two states, so one switch. It shows the state it is in,
                not the one it would take you to — a button that lies about where you are is
                worse than one more click. */}
            <button data-testid="measure-toggle" onClick={() => measuring ? stopMeasuring() : startMeasuring()}
              aria-pressed={!!measuring}
              title={t.hintMeasure} aria-label={t.measure}
              className={iconBtn(!!measuring, 'bg-amber-500 text-white shadow-lg')}>
              <Ruler size={14} />{mobileLabel(t.measure)}
            </button>
            {/* The next member the drawing most likely needs, offered as a ghost to click */}
            <div className={advancedTools}><button data-testid="suggest-next" onClick={() => { if (isDrawing) cancelDraw(); nextSuggestion() }}
              disabled={viewMode || !!measuring}
              title={t.hintSuggest} aria-label={t.suggest}
              className={`${iconBtn(!!suggestion, 'bg-emerald-600/30 text-emerald-300')} disabled:opacity-30 disabled:pointer-events-none`}>
              <Lightbulb size={14} />{mobileLabel(t.suggest)}
            </button></div>
            <button data-testid="mode-toggle" onClick={() => setViewMode(!viewMode)}
              aria-pressed={viewMode}
              title={viewMode ? t.hintLook : t.hintBuild} aria-label={viewMode ? t.look : t.build}
              className={iconBtn(true, viewMode ? 'bg-emerald-600 text-white shadow-lg' : 'bg-blue-600 text-white shadow-lg')}>
              {viewMode ? <Eye size={14} /> : <PencilRuler size={14} />}{mobileLabel(viewMode ? t.look : t.build)}
            </button>
            <div className="hidden md:block w-px h-5 bg-white/10 mx-0.5 shrink-0" />
            {/* The wheel already does this; the buttons are for trackpads and for anyone who
                would rather press something than learn a gesture. */}
            <div className={advancedTools}><button data-keep-draw data-testid="zoom-out" onClick={() => zoomBy(-1)} title={t.zoomOut} aria-label={t.zoomOut}
              className={iconBtn(false, '')}><Minus size={14} />{mobileLabel(t.zoomOut)}</button>
            <button data-keep-draw data-testid="zoom-in" onClick={() => zoomBy(1)} title={t.zoomIn} aria-label={t.zoomIn}
              className={iconBtn(false, '')}><Plus size={14} />{mobileLabel(t.zoomIn)}</button></div>
            <button data-keep-draw data-testid="fit-view" onClick={() => triggerCameraReset('all')} title={`${t.fitView} (F)`}
              aria-label={t.fitView} className={iconBtn(false, '')}>
              <Home size={14} />{mobileLabel(t.home)}
            </button>
            <button data-testid="mobile-tools-toggle" data-keep-draw onClick={() => setMobileToolsOpen(!mobileToolsOpen)}
              aria-expanded={mobileToolsOpen} aria-label={t.toolbarMore}
              className="md:hidden flex items-center justify-center min-h-11 px-2 text-[10px] font-bold text-slate-300 rounded-lg bg-slate-700/50">
              {t.toolbarMore}
            </button>
          </div>

          <div data-testid="standard-views" data-keep-draw role="group" aria-label={t.standardViews}
            className="absolute bottom-6 right-3 z-10 flex flex-col gap-0.5 p-1 rounded-xl bg-slate-900/90 border border-white/10 shadow-lg">
            {(['top', 'front', 'right', 'iso'] as const).map((view) => <button key={view}
              data-testid={`view-${view}`} onClick={() => setCameraView(view)} title={t.viewNames[view]}
              className="min-w-11 min-h-11 md:min-h-8 px-2 rounded-lg text-[11px] font-bold text-slate-300 hover:text-white hover:bg-slate-700/70">
              {t.viewNames[view]}
            </button>)}
          </div>

          {/* Current interaction mode and help access. */}
          <div className="absolute bottom-6 left-6 flex items-center gap-2 z-10">
            <div className={`pointer-events-none bg-slate-900/80 backdrop-blur-xl px-3 py-1.5 rounded-full border border-white/10 text-[10px] font-bold shadow-2xl ${
              measuring ? 'text-amber-400' : viewMode ? 'text-emerald-400' : selectMode ? 'text-violet-400' : held !== null ? 'text-blue-400' : 'text-slate-300'}`}
              data-testid="mode-line">
              {measuring ? (t.measureHint) : viewMode ? t.look : selectMode ? t.selectMode : held !== null ? `${t.draw} · ${heldName}` : t.emptyHand}
            </div>
            <button data-keep-draw data-testid="help-toggle" onClick={toggleHelp} title={t.hintHelp} aria-label={t.help}
              aria-expanded={helpOpen}
              className="flex items-center justify-center w-11 h-11 md:w-7 md:h-7 rounded-full bg-slate-900/80 backdrop-blur-xl border border-white/10 text-slate-400 hover:text-white hover:border-white/25 shadow-2xl">
              <HelpCircle size={13} />
            </button>
          </div>

          {helpOpen && (
            <div data-keep-draw data-testid="help-panel"
              className="absolute bottom-16 left-6 z-20 bg-slate-900/95 backdrop-blur-xl px-4 py-3 rounded-xl border border-white/10 shadow-2xl max-w-sm text-[10px] text-slate-400 space-y-1">
              <div className="flex items-center justify-between pb-1.5 mb-1 border-b border-white/10">
                <span className="text-[9px] font-black uppercase tracking-widest text-slate-500">{t.help}</span>
                <button onClick={toggleHelp} aria-label={t.help} className="text-slate-500 hover:text-white"><X size={12} /></button>
              </div>
              {[...t.guideNavigate, ...t.guideDraw, ...t.guideSelect].map((line, i) => <p key={i}>{line}</p>)}
            </div>
          )}

          {/* Toasts */}
          <div className="absolute top-20 right-6 flex flex-col gap-2 items-end pointer-events-none z-20" data-testid="toasts" role="status" aria-live="polite" aria-atomic="false">
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
      <Tooltip />
    </div>
  )
}

export default App
