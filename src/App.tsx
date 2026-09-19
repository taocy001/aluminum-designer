import React, { useEffect, useRef, useState, useCallback } from 'react'
import Viewport from './components/Viewport'
import Sidebar from './components/Sidebar'
import { useStore } from './store/useStore'
import { useToolStore } from './store/useToolStore'
import { useDrawTool } from './hooks/useDrawTool'
import { translations } from './utils/translations'
import { Languages, Home, Ruler, MousePointer2 } from 'lucide-react'

const AXIS_COLORS: Record<string, string> = { x: '#ef4444', y: '#22c55e', z: '#3b82f6' }
const AXIS_NAMES_ZH: Record<string, string> = { x: 'X轴', y: 'Y轴（垂直）', z: 'Z轴' }
const AXIS_NAMES_EN: Record<string, string> = { x: 'X axis', y: 'Y axis (vertical)', z: 'Z axis' }

function getAxis(start: { x: number; y: number; z: number }, end: { x: number; y: number; z: number }) {
  const dx = Math.abs(end.x - start.x)
  const dy = Math.abs(end.y - start.y)
  const dz = Math.abs(end.z - start.z)
  if (dx >= dy && dx >= dz) return 'x'
  if (dy >= dx && dy >= dz) return 'y'
  return 'z'
}

function App() {
  const {
    clearSelection, removeSelected, undo, redo,
  } = useStore()
  const {
    language, setLanguage, isDrawing, startPoint, currentPoint,
    viewMode, setViewMode, triggerCameraReset, setDrawing, setPoints, setSnapPoint,
    isDragging, showDimensionLabels, toggleDimensionLabels,
    selectMode, setSelectMode,
    isFrameSelecting, frameSelectStart, frameSelectCurrent,
    startFrameSelect, updateFrameSelect, endFrameSelect,
  } = useToolStore()
  const { handlePointerDown } = useDrawTool()
  const t = translations[language]

  // Precise length input local state
  const [preciseInput, setPreciseInput] = useState('')
  const preciseInputRef = useRef<HTMLInputElement>(null)

  // Reset precise input when drawing ends
  useEffect(() => {
    if (!isDrawing) setPreciseInput('')
  }, [isDrawing])

  // Live drawing distance
  const drawDist = isDrawing && startPoint && currentPoint
    ? startPoint.distanceTo(currentPoint)
    : 0
  const drawAxis = isDrawing && startPoint && currentPoint && drawDist > 5
    ? getAxis(startPoint, currentPoint)
    : null

  // Confirm precise length placement
  const confirmPreciseLength = useCallback(() => {
    const len = parseFloat(preciseInput)
    if (isNaN(len) || len <= 5) return
    if (!startPoint || !currentPoint) return
    const dist = startPoint.distanceTo(currentPoint)
    if (dist < 1) return
    const dir = currentPoint.clone().sub(startPoint).normalize()
    const endPoint = startPoint.clone().addScaledVector(dir, len)
    handlePointerDown(endPoint)
    setPreciseInput('')
  }, [preciseInput, startPoint, currentPoint, handlePointerDown])

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't handle shortcuts while typing in inputs (except precise length input)
      const tag = (e.target as HTMLElement)?.tagName
      const isInInput = tag === 'INPUT' || tag === 'TEXTAREA'

      // Ctrl+Z: undo
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
        return
      }
      // Ctrl+Y or Ctrl+Shift+Z: redo
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault()
        redo()
        return
      }

      if (isInInput) return

      // Escape: cancel drawing or exit mode
      if (e.key === 'Escape') {
        if (isDrawing) {
          setDrawing(false)
          setPoints(null, null)
          setSnapPoint(null)
        } else if (selectMode) {
          setSelectMode(false)
        } else if (viewMode === 'draw') {
          setViewMode('navigate')
        }
      }
      // Delete/Backspace: remove selected
      if ((e.key === 'Delete' || e.key === 'Backspace') && !isDrawing) {
        removeSelected()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isDrawing, viewMode, selectMode, setDrawing, setPoints, setSnapPoint, setViewMode, setSelectMode, removeSelected, undo, redo])

  // Frame selection state (local, for the overlay rect)
  const mainRef = useRef<HTMLDivElement>(null)
  const frameSelectActive = isFrameSelecting && frameSelectStart && frameSelectCurrent

  // Compute frame rect in client coords for the overlay
  const frameRect = frameSelectActive ? {
    left: Math.min(frameSelectStart!.x, frameSelectCurrent!.x),
    top: Math.min(frameSelectStart!.y, frameSelectCurrent!.y),
    width: Math.abs(frameSelectCurrent!.x - frameSelectStart!.x),
    height: Math.abs(frameSelectCurrent!.y - frameSelectStart!.y),
  } : null

  const handleMainPointerDown = useCallback((e: React.PointerEvent) => {
    if (viewMode !== 'navigate') return
    if (selectMode) {
      // Frame select mode: start selection rect
      startFrameSelect(e.clientX, e.clientY)
    } else if (!isDrawing) {
      // Clicking empty canvas (profiles stop propagation so this only fires for empty space)
      clearSelection()
    }
  }, [selectMode, viewMode, isDrawing, startFrameSelect, clearSelection])

  const handleMainPointerMove = useCallback((e: React.PointerEvent) => {
    if (!isFrameSelecting) return
    if (isDragging) {
      // Profile drag started, cancel frame select
      endFrameSelect(e.clientX, e.clientY)
      return
    }
    updateFrameSelect(e.clientX, e.clientY)
  }, [isFrameSelecting, isDragging, updateFrameSelect, endFrameSelect])

  const handleMainPointerUp = useCallback((e: React.PointerEvent) => {
    if (!isFrameSelecting) return
    const canvasRect = mainRef.current?.getBoundingClientRect()
    if (canvasRect && frameSelectStart) {
      const dx = Math.abs(e.clientX - frameSelectStart.x)
      const dy = Math.abs(e.clientY - frameSelectStart.y)
      if (dx > 5 || dy > 5) {
        // Convert to canvas-relative coords for FrameSelector
        const rect = {
          x1: Math.min(frameSelectStart.x, e.clientX) - canvasRect.left,
          y1: Math.min(frameSelectStart.y, e.clientY) - canvasRect.top,
          x2: Math.max(frameSelectStart.x, e.clientX) - canvasRect.left,
          y2: Math.max(frameSelectStart.y, e.clientY) - canvasRect.top,
        }
        useToolStore.getState().setFrameSelectRect(rect)
      }
    }
    endFrameSelect(e.clientX, e.clientY)
  }, [isFrameSelecting, frameSelectStart, endFrameSelect])

  const handleMainClick = useCallback((_e: React.MouseEvent) => {
    // Selection/deselection handled in onPointerDown (which respects R3F stopPropagation)
  }, [])

  return (
    <div className="w-full h-full bg-[#0f172a] flex flex-col overflow-hidden">
      <header className="h-14 bg-slate-800 border-b border-white/10 flex items-center px-6 text-white shadow-2xl z-20">
        <h1 className="text-xl font-black tracking-tighter flex items-center gap-3 uppercase">
          <div className="w-6 h-6 bg-blue-500 rounded-sm rotate-45 flex items-center justify-center text-[10px] text-white font-bold">AL</div>
          {t.title}
        </h1>

        <div className="ml-auto flex items-center gap-3">
          {/* Precise length input — shown while drawing with a direction established */}
          {isDrawing && drawAxis && drawDist > 5 && (
            <div className="flex items-center gap-2">
              <div
                className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-mono font-bold border"
                style={{ color: AXIS_COLORS[drawAxis], borderColor: AXIS_COLORS[drawAxis] + '66', background: AXIS_COLORS[drawAxis] + '15' }}
              >
                <span>{language === 'zh' ? AXIS_NAMES_ZH[drawAxis] : AXIS_NAMES_EN[drawAxis]}</span>
                <span className="opacity-60">|</span>
                <span>{drawDist.toFixed(0)} mm</span>
              </div>
              <div className="flex items-center gap-1 bg-slate-700/80 border border-white/10 rounded-full overflow-hidden">
                <input
                  ref={preciseInputRef}
                  type="number"
                  value={preciseInput}
                  onChange={(e) => setPreciseInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); confirmPreciseLength() }
                    if (e.key === 'Escape') { e.preventDefault(); setPreciseInput('') }
                    e.stopPropagation()
                  }}
                  placeholder={language === 'zh' ? '精确长度' : 'exact mm'}
                  className="w-28 bg-transparent px-3 py-1.5 text-xs font-mono text-white outline-none placeholder:text-slate-500"
                />
                <button
                  onClick={confirmPreciseLength}
                  disabled={!preciseInput}
                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-[11px] font-bold text-white transition-all"
                >
                  ↵
                </button>
              </div>
            </div>
          )}

          <button
            onClick={() => setLanguage(language === 'en' ? 'zh' : 'en')}
            className="flex items-center gap-2 px-4 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-full text-xs font-bold transition-all shadow-lg active:scale-95"
          >
            <Languages size={14} />
            {language === 'en' ? '中文' : 'English'}
          </button>
        </div>
      </header>

      <div className="flex-grow flex overflow-hidden">
        <Sidebar />
        <main
          ref={mainRef}
          className="flex-grow relative"
          onClick={handleMainClick}
          onPointerDown={handleMainPointerDown}
          onPointerMove={handleMainPointerMove}
          onPointerUp={handleMainPointerUp}
        >
          <Viewport />

          {/* Frame selection overlay rect */}
          {frameRect && frameRect.width > 3 && frameRect.height > 3 && (
            <div
              className="absolute pointer-events-none border border-blue-400/70 bg-blue-400/10 rounded-sm"
              style={{
                left: frameRect.left - (mainRef.current?.getBoundingClientRect().left ?? 0),
                top: frameRect.top - (mainRef.current?.getBoundingClientRect().top ?? 0),
                width: frameRect.width,
                height: frameRect.height,
              }}
            />
          )}

          {/* Toolbar */}
          <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-slate-900/90 backdrop-blur-md border border-white/10 rounded-xl p-1 shadow-2xl z-10">
            <button
              onClick={(e) => {
                e.stopPropagation()
                setViewMode(viewMode === 'draw' ? 'navigate' : 'draw')
              }}
              title={language === 'zh' ? '点击切换绘制/导航模式 (Esc)' : 'Toggle draw/navigate (Esc)'}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all ${
                viewMode === 'draw'
                  ? 'bg-blue-600/20 text-blue-400 hover:bg-blue-600/40'
                  : 'text-slate-400 hover:bg-slate-700/60 hover:text-white'
              }`}
            >
              {viewMode === 'draw'
                ? (language === 'zh' ? '✏️ 绘制' : '✏️ Draw')
                : (language === 'zh' ? '🖐 导航' : '🖐 Navigate')}
            </button>

            <div className="w-px h-5 bg-white/10 mx-0.5" />

            {/* Select mode */}
            <button
              onClick={(e) => {
                e.stopPropagation()
                if (viewMode === 'draw') setViewMode('navigate')
                setSelectMode(!selectMode)
              }}
              title={language === 'zh' ? '框选模式：拖动选择多个型材' : 'Select mode: drag to multi-select'}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all ${
                selectMode
                  ? 'bg-violet-600/30 text-violet-400 border border-violet-500/30'
                  : 'text-slate-400 hover:bg-slate-700/60 hover:text-white'
              }`}
            >
              <MousePointer2 size={13} />
              {language === 'zh' ? '框选' : 'Select'}
            </button>

            <div className="w-px h-5 bg-white/10 mx-0.5" />

            {/* Dimension labels toggle */}
            <button
              onClick={(e) => { e.stopPropagation(); toggleDimensionLabels() }}
              title={language === 'zh' ? '切换尺寸标注显示' : 'Toggle dimension labels'}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all ${
                showDimensionLabels
                  ? 'bg-emerald-600/20 text-emerald-400'
                  : 'text-slate-400 hover:bg-slate-700/60 hover:text-white'
              }`}
            >
              <Ruler size={13} />
              {language === 'zh' ? '标注' : 'Labels'}
            </button>

            <div className="w-px h-5 bg-white/10 mx-0.5" />

            <button
              onClick={(e) => { e.stopPropagation(); triggerCameraReset() }}
              title={language === 'zh' ? '归位视角' : 'Reset camera'}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold text-slate-400 hover:bg-slate-700/60 hover:text-white transition-all"
            >
              <Home size={13} />
              {language === 'zh' ? '归位' : 'Home'}
            </button>
          </div>

          {/* Drawing / select mode guide */}
          <div className="absolute bottom-6 left-6 pointer-events-none bg-slate-900/80 backdrop-blur-xl px-4 py-3 rounded-xl border border-white/10 text-[10px] text-slate-400 space-y-1 shadow-2xl">
            {selectMode ? (
              <>
                <p className="text-violet-400 font-bold">{language === 'zh' ? '框选模式' : 'Select Mode'}</p>
                <p>{language === 'zh' ? '拖动 — 框选型材' : 'Drag — frame select profiles'}</p>
                <p>{language === 'zh' ? 'Ctrl+点击 — 多选' : 'Ctrl+Click — multi-select'}</p>
                <p className="text-slate-500">{language === 'zh' ? 'Delete 删除选中 · Esc 退出' : 'Delete — remove selected · Esc — exit'}</p>
              </>
            ) : (
              <>
                <p><span className="text-red-400 font-bold">X</span> / <span className="text-blue-400 font-bold">Z</span> {language === 'zh' ? '鼠标左右 — 水平型材' : 'Mouse left/right — horizontal'}</p>
                <p><span className="text-green-400 font-bold">Y</span> {language === 'zh' ? '鼠标斜向 — 垂直型材' : 'Mouse diagonal — vertical'}</p>
                <p className="text-slate-500">{language === 'zh' ? 'Delete 删除 · Esc 取消 · Ctrl+Z 撤销' : 'Delete · Esc cancel · Ctrl+Z undo'}</p>
                <p className="text-slate-500">{language === 'zh' ? '导航模式下可拖动型材' : 'Drag profiles in navigate mode'}</p>
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}

export default App
