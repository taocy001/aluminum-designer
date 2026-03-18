import React, { useEffect } from 'react'
import Viewport from './components/Viewport'
import Sidebar from './components/Sidebar'
import { useStore } from './store/useStore'
import { useToolStore } from './store/useToolStore'
import { translations } from './utils/translations'
import { Languages, Home } from 'lucide-react'

const AXIS_COLORS: Record<string, string> = { x: '#ef4444', y: '#22c55e', z: '#3b82f6' }
const AXIS_NAMES_ZH: Record<string, string> = { x: 'X轴', y: 'Y轴（垂直）', z: 'Z轴' }
const AXIS_NAMES_EN: Record<string, string> = { x: 'X axis', y: 'Y axis (vertical)', z: 'Z axis' }

function getAxis(start: {x:number,y:number,z:number}, end: {x:number,y:number,z:number}) {
  const dx = Math.abs(end.x - start.x)
  const dy = Math.abs(end.y - start.y)
  const dz = Math.abs(end.z - start.z)
  if (dx >= dy && dx >= dz) return 'x'
  if (dy >= dx && dy >= dz) return 'y'
  return 'z'
}

function App() {
  const { selectProfile, profiles, selectedId, removeProfile, connectors, removeConnector } = useStore()
  const { language, setLanguage, isDrawing, startPoint, currentPoint, viewMode, setViewMode, triggerCameraReset, setDrawing, setPoints, setSnapPoint } = useToolStore()
  const t = translations[language]

  // Live drawing distance
  const drawDist = isDrawing && startPoint && currentPoint
    ? startPoint.distanceTo(currentPoint)
    : 0
  const drawAxis = isDrawing && startPoint && currentPoint && drawDist > 5
    ? getAxis(startPoint, currentPoint)
    : null

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape: cancel drawing
      if (e.key === 'Escape') {
        if (isDrawing) {
          setDrawing(false)
          setPoints(null, null)
          setSnapPoint(null)
        } else if (viewMode === 'draw') {
          setViewMode('navigate')
        }
      }
      // Delete/Backspace: remove selected
      if ((e.key === 'Delete' || e.key === 'Backspace') && !isDrawing) {
        if (selectedId) {
          removeProfile(selectedId)
          removeConnector(selectedId)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isDrawing, selectedId, viewMode, setDrawing, setPoints, setSnapPoint, setViewMode, removeProfile, removeConnector])

  return (
    <div className="w-full h-full bg-[#0f172a] flex flex-col overflow-hidden">
      <header className="h-14 bg-slate-800 border-b border-white/10 flex items-center px-6 text-white shadow-2xl z-20">
        <h1 className="text-xl font-black tracking-tighter flex items-center gap-3 uppercase">
          <div className="w-6 h-6 bg-blue-500 rounded-sm rotate-45 flex items-center justify-center text-[10px] text-white font-bold">AL</div>
          {t.title}
        </h1>

        <div className="ml-auto flex items-center gap-3">
          {/* Axis + length indicator while drawing */}
          {isDrawing && drawDist > 5 && drawAxis && (
            <div
              className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-mono font-bold border"
              style={{ color: AXIS_COLORS[drawAxis], borderColor: AXIS_COLORS[drawAxis] + '66', background: AXIS_COLORS[drawAxis] + '15' }}
            >
              <span>{language === 'zh' ? AXIS_NAMES_ZH[drawAxis] : AXIS_NAMES_EN[drawAxis]}</span>
              <span className="opacity-60">|</span>
              <span>{drawDist.toFixed(0)} mm</span>
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
        <main className="flex-grow relative" onClick={() => selectProfile(null)}>
          <Viewport />

          {/* Toolbar */}
          <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-slate-900/90 backdrop-blur-md border border-white/10 rounded-xl p-1 shadow-2xl z-10">
            <button
              onClick={(e) => { e.stopPropagation(); setViewMode(viewMode === 'draw' ? 'navigate' : 'draw') }}
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

            <button
              onClick={(e) => { e.stopPropagation(); triggerCameraReset() }}
              title={language === 'zh' ? '归位视角' : 'Reset camera'}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold text-slate-400 hover:bg-slate-700/60 hover:text-white transition-all"
            >
              <Home size={13} />
              {language === 'zh' ? '归位' : 'Home'}
            </button>
          </div>

          {/* Drawing guide */}
          <div className="absolute bottom-6 left-6 pointer-events-none bg-slate-900/80 backdrop-blur-xl px-4 py-3 rounded-xl border border-white/10 text-[10px] text-slate-400 space-y-1 shadow-2xl">
            <p><span className="text-red-400 font-bold">X</span> / <span className="text-blue-400 font-bold">Z</span> {language === 'zh' ? '鼠标左右 — 水平型材' : 'Mouse left/right — horizontal'}</p>
            <p><span className="text-green-400 font-bold">Y</span> {language === 'zh' ? '鼠标斜向 — 垂直型材' : 'Mouse diagonal — vertical'}</p>
            <p className="text-slate-500">{language === 'zh' ? 'Delete 删除 · Esc 取消' : 'Delete — remove · Esc — cancel'}</p>
            <p className="text-slate-500">{language === 'zh' ? '导航模式下可拖动型材' : 'Drag profiles in navigate mode'}</p>
          </div>
        </main>
      </div>
    </div>
  )
}

export default App
