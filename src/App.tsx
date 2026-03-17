import React from 'react'
import Viewport from './components/Viewport'
import Sidebar from './components/Sidebar'
import { useStore } from './store/useStore'
import { useToolStore } from './store/useToolStore'
import { translations } from './utils/translations'
import { Languages, ShieldAlert, Activity } from 'lucide-react'

function App() {
  const { selectProfile, profiles } = useStore()
  const { language, setLanguage, isDrawing, startPoint, currentPoint } = useToolStore()
  const t = translations[language]

  return (
    <div className="w-full h-full bg-[#0f172a] flex flex-col overflow-hidden">
      <header className="h-14 bg-slate-800 border-b border-white/10 flex items-center px-6 text-white shadow-2xl z-20">
        <h1 className="text-xl font-black tracking-tighter flex items-center gap-3 uppercase">
          <div className="w-6 h-6 bg-blue-500 rounded-sm rotate-45 flex items-center justify-center text-[10px] text-white font-bold">AL</div>
          {t.title}
        </h1>
        
        <div className="ml-auto flex items-center gap-4">
          {/* ADVANCED DEBUG PANEL */}
          <div className="hidden lg:flex items-center gap-4 px-4 py-1.5 bg-black/40 border border-white/10 rounded-full text-[10px] font-mono">
            <div className="flex items-center gap-1 text-amber-500">
              <ShieldAlert size={12} />
              STATUS: <span className={isDrawing ? 'text-green-400' : 'text-slate-500'}>{isDrawing ? 'DRAWING' : 'IDLE'}</span>
            </div>
            <div className="w-[1px] h-3 bg-white/10"></div>
            <div className="text-blue-400">
              COUNT: {profiles.length}
            </div>
            <div className="w-[1px] h-3 bg-white/10"></div>
            <div className="text-slate-400 truncate max-w-[200px]">
              POS: {currentPoint ? `${currentPoint.x.toFixed(0)},${currentPoint.y.toFixed(0)},${currentPoint.z.toFixed(0)}` : 'N/A'}
            </div>
          </div>

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
          
          {/* TELEMETRY OVERLAY */}
          <div className="absolute top-6 left-6 pointer-events-none space-y-2">
             <div className="bg-black/60 backdrop-blur-md p-3 rounded-lg border border-white/10 text-[9px] text-slate-300 font-mono shadow-xl">
                <p className="text-blue-400 font-bold mb-1 flex items-center gap-1"><Activity size={10}/> LIVE TELEMETRY</p>
                <p>DRAWING_MODE: {isDrawing ? 'ACTIVE' : 'READY'}</p>
                <p>START_PT: {startPoint ? `[${startPoint.x}, ${startPoint.y}, ${startPoint.z}]` : 'NONE'}</p>
                <p>PROFILE_QTY: {profiles.length}</p>
             </div>
          </div>

          <div className="absolute bottom-6 left-6 pointer-events-none bg-slate-900/80 backdrop-blur-xl p-5 rounded-2xl border border-white/10 text-[11px] text-white/80 space-y-2 shadow-2xl">
            <h3 className="text-blue-400 font-bold uppercase mb-2 border-b border-white/10 pb-1">Operations / 操作指南</h3>
            {t.controls.map((line, idx) => (
              <p key={idx} className="flex items-center gap-2">
                <span className="w-1 h-1 bg-blue-500 rounded-full"></span>
                {line}
              </p>
            ))}
          </div>
        </main>
      </div>
    </div>
  )
}

export default App
