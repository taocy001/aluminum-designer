import React from 'react'
import { Plus, Trash2, Download, Box, FileText, Eraser, Bug, Undo2, Redo2 } from 'lucide-react'
import { useStore, ProfileSpec } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { translations } from '../utils/translations'

const CONNECTOR_LIST: { type: string; labelZh: string; labelEn: string }[] = [
  { type: 'bracket',       labelZh: 'L型角码',   labelEn: 'L-Bracket' },
  { type: 'inside-corner', labelZh: '内角码',     labelEn: 'Inside Corner' },
  { type: 'gusset',        labelZh: '加强筋',     labelEn: 'Gusset' },
  { type: 'flat-plate',    labelZh: '直连板',     labelEn: 'Flat Plate' },
  { type: 't-bracket',     labelZh: 'T型角码',    labelEn: 'T-Bracket' },
  { type: 'cross-bracket', labelZh: '十字连接板', labelEn: 'Cross Plate' },
  { type: 'corner-3way',   labelZh: '三维角码',   labelEn: '3-Way Corner' },
  { type: 'joining-plate', labelZh: '对接板',     labelEn: 'Joining Plate' },
  { type: 'end-cap',       labelZh: '端盖',       labelEn: 'End Cap' },
  { type: 't-nut',         labelZh: '滑块螺母',   labelEn: 'T-Nut' },
  { type: 'hinge',         labelZh: '合页',       labelEn: 'Hinge' },
  { type: 'pivot',         labelZh: '轴承座',     labelEn: 'Pivot' },
  { type: 'caster-mount',  labelZh: '脚轮座',     labelEn: 'Caster Mount' },
  { type: 'foot',          labelZh: '调节脚',     labelEn: 'Leveling Foot' },
]

const Sidebar: React.FC = () => {
  const {
    profiles, connectors, selectedIds, removeSelected, removeConnector,
    updateProfile, commitProfileEdit, clearAll, undo, redo, past, future,
  } = useStore()
  const { activeSpec, setActiveSpec, activeConnectorType, setActiveConnector, placementMode, viewMode, setViewMode, language } = useToolStore()
  const t = translations[language]

  const selectedProfile = profiles.find((p) => selectedIds.includes(p.id))
  const selectedConnector = connectors.find((c) => selectedIds.includes(c.id))

  const handleSpecClick = (spec: ProfileSpec) => {
    if (placementMode === 'profile' && activeSpec === spec && viewMode === 'draw') {
      setViewMode('navigate')
    } else {
      setActiveSpec(spec)
    }
  }

  const handleConnectorClick = (type: string) => {
    if (placementMode === 'connector' && activeConnectorType === type && viewMode === 'draw') {
      setViewMode('navigate')
    } else {
      setActiveConnector(type)
    }
  }

  const handleClearAll = () => {
    if (window.confirm(language === 'zh' ? '确定要清空所有组件吗？' : 'Are you sure to clear all components?')) {
      clearAll()
    }
  }

  const handleLogDebug = () => {
    console.log('%c=== ENGINE DEBUG LOG ===', 'color: #fbbf24; font-size: 14px; font-weight: bold;')
    console.log('PROFILES:', profiles)
    console.log('CONNECTORS:', connectors)
    alert(language === 'zh' ? '调试数据已打印至控制台 (F12)' : 'Debug data logged to console (F12)')
  }

  const handleExportBOM = () => {
    let csv = language === 'zh' ? '类别,规格,长度(mm),数量\n' : 'Category,Spec,Length(mm),Quantity\n'
    profiles.forEach((p) => csv += `Profile,${p.spec},${p.length.toFixed(0)},1\n`)
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

        <div className="space-y-5">
          {/* Profile specs */}
          <div>
            <label className="text-[9px] text-slate-500 font-black mb-2 block uppercase tracking-widest">{t.profiles}</label>
            <div className="grid grid-cols-3 gap-1.5">
              {(['2020', '2040', '3030', '3040', '4040'] as ProfileSpec[]).map((spec) => (
                <button
                  key={spec}
                  onClick={() => handleSpecClick(spec)}
                  className={`px-2 py-2 rounded-lg text-[11px] font-bold transition-all ${
                    placementMode === 'profile' && activeSpec === spec && viewMode === 'draw'
                      ? 'bg-blue-600 text-white shadow-lg'
                      : 'bg-slate-700/50 hover:bg-slate-700 text-slate-400'
                  }`}
                >
                  {spec}
                </button>
              ))}
            </div>
          </div>

          {/* Connectors */}
          <div>
            <label className="text-[9px] text-slate-500 font-black mb-2 block uppercase tracking-widest">{t.connectors}</label>
            <div className="grid grid-cols-2 gap-1.5">
              {CONNECTOR_LIST.map(({ type, labelZh, labelEn }) => (
                <button
                  key={type}
                  onClick={() => handleConnectorClick(type)}
                  className={`px-2 py-1.5 rounded-lg text-[10px] font-bold transition-all text-left ${
                    placementMode === 'connector' && activeConnectorType === type && viewMode === 'draw'
                      ? 'bg-emerald-600 text-white shadow-lg'
                      : 'bg-slate-700/50 hover:bg-slate-700 text-slate-400'
                  }`}
                >
                  {language === 'zh' ? labelZh : labelEn}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Properties panel */}
      <div className="flex-grow overflow-y-auto p-5">
        {selectedProfile || selectedConnector ? (
          <div className="bg-slate-900/50 rounded-xl p-4 border border-white/5 space-y-4 shadow-xl">
            <div className="flex items-center justify-between border-b border-white/5 pb-3">
              <span className="text-[10px] font-black uppercase text-slate-400">{t.properties}</span>
              <button onClick={removeSelected} className="text-red-400 hover:bg-red-400/10 p-1.5 rounded-lg">
                <Trash2 size={14} />
              </button>
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
                    onChange={(e) => updateProfile(selectedProfile.id, { length: Number(e.target.value) })}
                    onBlur={(e) => commitProfileEdit(selectedProfile.id, { length: Number(e.target.value) })}
                    className="w-full bg-slate-950 border border-white/5 rounded-lg px-3 py-2 text-xs font-mono outline-none focus:border-blue-500"
                  />
                </div>
              </div>
            )}
            {selectedConnector && (
              <div className="text-xs text-slate-400">
                <span className="text-slate-500">{language === 'zh' ? '类型' : 'Type'}: </span>
                <span className="text-emerald-400 font-mono">{selectedConnector.type}</span>
              </div>
            )}
            {selectedIds.length > 1 && (
              <div className="text-[10px] text-slate-500 pt-1 border-t border-white/5">
                {language === 'zh' ? `已选中 ${selectedIds.length} 个元素` : `${selectedIds.length} items selected`}
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

      {/* BOM + actions */}
      <div className="p-5 bg-slate-900 border-t border-white/5 space-y-3">
        {/* Undo / Redo */}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={undo}
            disabled={past.length === 0}
            title={language === 'zh' ? '撤销 (Ctrl+Z)' : 'Undo (Ctrl+Z)'}
            className="flex items-center justify-center gap-1.5 py-2 bg-slate-700/50 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed text-slate-300 rounded-lg text-[10px] font-bold transition-all"
          >
            <Undo2 size={13} /> {language === 'zh' ? '撤销' : 'Undo'}
          </button>
          <button
            onClick={redo}
            disabled={future.length === 0}
            title={language === 'zh' ? '重做 (Ctrl+Y)' : 'Redo (Ctrl+Y)'}
            className="flex items-center justify-center gap-1.5 py-2 bg-slate-700/50 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed text-slate-300 rounded-lg text-[10px] font-bold transition-all"
          >
            <Redo2 size={13} /> {language === 'zh' ? '重做' : 'Redo'}
          </button>
        </div>

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

        <button
          onClick={handleExportBOM}
          className="w-full flex items-center justify-center gap-2 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-[11px] font-bold transition-all shadow-lg active:scale-95"
        >
          <Download size={14} /> {t.exportBOM}
        </button>

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={handleLogDebug}
            className="flex items-center justify-center gap-2 py-2 bg-amber-600/20 hover:bg-amber-600/40 text-amber-500 border border-amber-600/30 rounded-lg text-[10px] font-bold transition-all"
          >
            <Bug size={14} /> {language === 'zh' ? '日志导出' : 'LOG DATA'}
          </button>
          <button
            onClick={handleClearAll}
            className="flex items-center justify-center gap-2 py-2 bg-slate-800 hover:bg-red-600/20 text-slate-500 hover:text-red-400 border border-white/5 rounded-lg text-[10px] font-bold transition-all"
          >
            <Eraser size={14} /> {language === 'zh' ? '清空' : 'CLEAR'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default Sidebar
