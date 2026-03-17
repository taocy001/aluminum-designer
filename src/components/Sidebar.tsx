import React from 'react'
import { Plus, Trash2, Scissors, CircleDot, Download, Box, FileText, Eraser, Bug } from 'lucide-react'
import { useStore, ProfileSpec } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { translations } from '../utils/translations'

const Sidebar: React.FC = () => {
  const { profiles, connectors, selectedId, removeProfile, removeConnector, updateProfile, clearAll } = useStore()
  const { activeSpec, setActiveSpec, activeConnectorType, setActiveConnector, placementMode, language } = useToolStore()
  const t = translations[language]

  const selectedProfile = profiles.find((p) => p.id === selectedId)
  const selectedConnector = connectors.find((c) => c.id === selectedId)

  const handleSpecSelect = (spec: ProfileSpec) => setActiveSpec(spec)
  const handleConnectorSelect = (type: string) => setActiveConnector(type)
  const handleDelete = () => {
    if (selectedProfile) removeProfile(selectedId!)
    if (selectedConnector) removeConnector(selectedId!)
  }

  const handleClearAll = () => {
    if (window.confirm(language === 'zh' ? '确定要清空所有组件吗？' : 'Are you sure to clear all components?')) {
      clearAll()
    }
  }

  const handleLogDebug = () => {
    console.log("%c=== ENGINE DEBUG LOG ===", "color: #fbbf24; font-size: 14px; font-weight: bold;")
    console.log("PROFILES:", profiles)
    console.log("CONNECTORS:", connectors)
    alert(language === 'zh' ? '调试数据已打印至控制台 (F12)' : 'Debug data logged to console (F12)')
  }

  const handleExportBOM = () => {
    let csv = language === 'zh' ? '类别,规格,长度(mm),数量\n' : 'Category,Spec,Length(mm),Quantity\n'
    profiles.forEach(p => csv += `Profile,${p.spec},${p.length.toFixed(0)},1\n`)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.setAttribute('download', 'BOM.csv')
    link.click()
  }

  const totalLength = profiles.reduce((sum, p) => sum + p.length, 0)

  return (
    <div className="w-72 bg-slate-800 border-r border-white/5 flex flex-col text-slate-200">
      <div className="p-5 border-b border-white/5">
        <h2 className="text-xs font-black mb-5 flex items-center gap-2 uppercase tracking-[0.2em] text-blue-400">
          <Plus size={14} strokeWidth={3} /> {t.components}
        </h2>
        
        <div className="space-y-6">
          <div>
            <label className="text-[9px] text-slate-500 font-black mb-3 block uppercase tracking-widest">{t.profiles}</label>
            <div className="grid grid-cols-2 gap-2">
              {(['2020', '2040', '3030', '3040', '4040'] as ProfileSpec[]).map((spec) => (
                <button
                  key={spec}
                  onClick={() => handleSpecSelect(spec)}
                  className={`px-3 py-2 rounded-lg text-[11px] font-bold transition-all ${
                    placementMode === 'profile' && activeSpec === spec 
                      ? 'bg-blue-600 text-white shadow-lg' 
                      : 'bg-slate-700/50 hover:bg-slate-700 text-slate-400'
                  }`}
                >
                  {spec}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-[9px] text-slate-500 font-black mb-3 block uppercase tracking-widest">{t.connectors}</label>
            <div className="grid grid-cols-2 gap-2">
              {['bracket', 'gusset'].map((type) => (
                <button
                  key={type}
                  onClick={() => handleConnectorSelect(type)}
                  className={`px-3 py-2 rounded-lg text-[11px] font-bold transition-all capitalize ${
                    placementMode === 'connector' && activeConnectorType === type 
                      ? 'bg-emerald-600 text-white shadow-lg' 
                      : 'bg-slate-700/50 hover:bg-slate-700 text-slate-400'
                  }`}
                >
                  {language === 'zh' ? (type === 'bracket' ? 'L型角码' : '加强筋') : type}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="flex-grow overflow-y-auto p-5">
        {selectedProfile || selectedConnector ? (
          <div className="bg-slate-900/50 rounded-xl p-4 border border-white/5 space-y-4 shadow-xl">
            <div className="flex items-center justify-between border-b border-white/5 pb-3">
              <span className="text-[10px] font-black uppercase text-slate-400">{t.properties}</span>
              <button onClick={handleDelete} className="text-red-400 hover:bg-red-400/10 p-1.5 rounded-lg"><Trash2 size={14} /></button>
            </div>
            {selectedProfile && (
              <div className="space-y-3">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-500">{t.spec}</span>
                  <span className="font-mono text-blue-400">{selectedProfile.spec}</span>
                </div>
                <div className="space-y-1">
                  <span className="text-[10px] text-slate-500 uppercase font-bold">{t.length}</span>
                  <input
                    type="number"
                    value={selectedProfile.length.toFixed(0)}
                    onChange={(e) => updateProfile(selectedId!, { length: Number(e.target.value) })}
                    className="w-full bg-slate-950 border border-white/5 rounded-lg px-3 py-2 text-xs font-mono outline-none focus:border-blue-500"
                  />
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-slate-600 opacity-30 space-y-2">
            <Box size={32} />
            <span className="text-[10px] font-bold uppercase">{t.selectToEdit}</span>
          </div>
        )}
      </div>

      <div className="p-5 bg-slate-900 border-t border-white/5 space-y-3">
        <h2 className="text-[10px] font-black uppercase tracking-widest text-slate-500 flex items-center gap-2 mb-2">
          <FileText size={12} /> {t.bomSummary}
        </h2>
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-white/5 p-2 rounded-lg border border-white/5 flex flex-col">
            <span className="text-[8px] text-slate-500 uppercase">{t.totalProfiles}</span>
            <span className="text-sm font-mono font-bold text-blue-400">{profiles.length}</span>
          </div>
          <div className="bg-white/5 p-2 rounded-lg border border-white/5 flex flex-col">
            <span className="text-[8px] text-slate-500 uppercase">LEN(mm)</span>
            <span className="text-sm font-mono font-bold text-blue-400">{totalLength.toFixed(0)}</span>
          </div>
        </div>

        <button onClick={handleExportBOM} className="w-full flex items-center justify-center gap-2 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-[11px] font-bold transition-all shadow-lg active:scale-95">
          <Download size={14} /> {t.exportBOM}
        </button>
        
        <div className="grid grid-cols-2 gap-2">
          <button onClick={handleLogDebug} className="flex items-center justify-center gap-2 py-2 bg-amber-600/20 hover:bg-amber-600/40 text-amber-500 border border-amber-600/30 rounded-lg text-[10px] font-bold transition-all">
            <Bug size={14} /> {language === 'zh' ? '日志导出' : 'LOG DATA'}
          </button>
          <button onClick={handleClearAll} className="flex items-center justify-center gap-2 py-2 bg-slate-800 hover:bg-red-600/20 text-slate-500 hover:text-red-400 border border-white/5 rounded-lg text-[10px] font-bold transition-all">
            <Eraser size={14} /> {language === 'zh' ? '清空' : 'CLEAR'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default Sidebar
