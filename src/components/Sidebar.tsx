import React, { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Trash2, Download, Box, Eraser, Bug, Undo2, Redo2, Upload, Save, Copy, ArrowLeftRight, AlertTriangle, ChevronRight, PanelLeftClose, PanelLeftOpen, Lock, LockOpen, FlipHorizontal2, Rows3, Square, SquareDashed, Zap } from 'lucide-react'
import { useStore, ProfileSpec, type ProfileData, type ConnectorData, type PanelData, type PanelMaterial } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { translations } from '../utils/translations'
import { computeFrameBounds } from '../utils/jointUtils'
import { getProfileEndpoints } from '../utils/geometryCore'
import { CONNECTOR_CATALOG, boltLabel, connectorEntry, connectorLabel, nutLabel } from '../utils/connectorCatalog'
import { buildBom, bomToCsv } from '../utils/bom'
import { analyzeFrame } from '../utils/analysis'
import { autoConnect } from '../utils/autoConnect'
import { ALL_SPECS } from '../utils/specUtils'
import { addPanelFromSelection, materialLabel, PANEL_MATERIALS, setPanelMaterial, setPanelSize } from '../utils/panelOps'
import { arraySelected, directionLabel, duplicateSelected, flipProfile, mirrorSelected, orientationDegrees, rotateSelected, setProfileEnd, setConnectorPosition, setConnectorSeries, setProfileLength, setProfilePosition, setProfileSpec, type RotAxis } from '../utils/editOps'

export const CONNECTOR_LIST: { type: string; labelZh: string; labelEn: string }[] = CONNECTOR_CATALOG

function downloadText(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

type SectionKey = 'components' | 'properties' | 'bom'

/** Collapsible sidebar section with a sticky header */
const Section: React.FC<{
  id: SectionKey
  title: string
  badge?: React.ReactNode
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}> = ({ id, title, badge, open, onToggle, children }) => (
  <div className="flex flex-col border-b border-white/5">
    <button
      onClick={onToggle}
      data-testid={`section-${id}`}
      aria-expanded={open}
      className="flex items-center gap-2 px-4 py-2.5 text-[11px] font-black uppercase tracking-[0.15em] text-slate-400 hover:text-white hover:bg-white/5 shrink-0"
    >
      <ChevronRight size={13} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
      <span className="flex-1 text-left">{title}</span>
      {badge}
    </button>
    {open && <div className="px-4 pb-4" data-testid={`section-${id}-body`}>{children}</div>}
  </div>
)

/** Numeric field that commits on Enter / blur and re-syncs from props otherwise */
const NumField: React.FC<{ value: number; onCommit: (v: number) => void; step?: number; className?: string; label?: string }> = ({ value, onCommit, step = 5, className = '', label }) => {
  const [text, setText] = useState(String(Math.round(value * 100) / 100))
  const [focused, setFocused] = useState(false)
  useEffect(() => { if (!focused) setText(String(Math.round(value * 100) / 100)) }, [value, focused])
  const commit = () => {
    const v = parseFloat(text)
    if (isFinite(v) && Math.abs(v - value) > 1e-6) onCommit(v)
    else setText(String(Math.round(value * 100) / 100))
  }
  return (
    <label className={`flex items-center gap-1 bg-slate-950 border border-white/5 rounded-lg px-2 focus-within:border-blue-500 ${className}`}>
      {label && <span className="text-[9px] text-slate-500 font-bold w-3">{label}</span>}
      <input
        type="number" step={step} value={text}
        onFocus={() => setFocused(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { setFocused(false); commit() }}
        onKeyDown={(e) => { if (e.key === 'Enter') { (e.target as HTMLInputElement).blur() } e.stopPropagation() }}
        className="w-full bg-transparent py-1.5 text-xs font-mono outline-none"
      />
    </label>
  )
}

const Sidebar: React.FC = () => {
  const { profiles, connectors, panels, selectedIds, removeSelected, toggleLockSelected, clearAll, undo, redo, past, future, loadDocument } = useStore()
  const { activeSpec, setActiveSpec, activeConnectorType, setActiveConnector, held, putDown, language, showToast } = useToolStore()
  const t = translations[language]
  const [confirmClear, setConfirmClear] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!confirmClear) return
    const id = setTimeout(() => setConfirmClear(false), 3000)
    return () => clearTimeout(id)
  }, [confirmClear])

  const { trims, conflicts, conflictIds, mismatches, mismatchIds } = useMemo(() => analyzeFrame(profiles), [profiles])
  const selectedIdsSignature = selectedIds.join(',')
  const selectedIdsRef = useRef(selectedIds)
  selectedIdsRef.current = selectedIds
  const [rotAngleText, setRotAngleText] = useState('90')
  const [arrayCountText, setArrayCountText] = useState('1')
  const [arraySpacingText, setArraySpacingText] = useState('300')
  const [collapsed, setCollapsed] = useState(false)
  // section state is remembered per browser, and selecting something opens the properties
  const [open, setOpen] = useState<Record<SectionKey, boolean>>(() => {
    try {
      const saved = localStorage.getItem('aluminum-designer-sections')
      if (saved) return { components: true, properties: true, bom: true, ...JSON.parse(saved) }
    } catch { /* private mode or blocked storage */ }
    return { components: true, properties: true, bom: true }
  })
  useEffect(() => {
    if (selectedIdsRef.current.length === 0) return
    setOpen((prev) => {
      if (prev.properties) return prev
      const next = { ...prev, properties: true }
      try { localStorage.setItem('aluminum-designer-sections', JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }, [selectedIdsSignature])

  const toggle = (key: SectionKey) => setOpen((prev) => {
    const next = { ...prev, [key]: !prev[key] }
    try { localStorage.setItem('aluminum-designer-sections', JSON.stringify(next)) } catch { /* ignore */ }
    return next
  })
  const rotAngle = parseFloat(rotAngleText)
  const rotAngleValid = isFinite(rotAngle) && rotAngle % 360 !== 0
  const arrayValid = isFinite(parseFloat(arrayCountText)) && parseFloat(arrayCountText) >= 1
    && isFinite(parseFloat(arraySpacingText)) && Math.abs(parseFloat(arraySpacingText)) >= 1
  const selectedProfile = profiles.find((p) => selectedIds.includes(p.id))
  const selectedConnector = connectors.find((c) => selectedIds.includes(c.id))
  const selectedPanel = panels.find((b) => selectedIds.includes(b.id))
  // the member's far end, derived: the model keeps a start, a direction and a length
  const selectedEnd: [number, number, number] = selectedProfile
    ? (() => { const e = getProfileEndpoints(selectedProfile).end; return [e.x, e.y, e.z] })()
    : [0, 0, 0]
  const selectedProfileCount = profiles.filter((p) => selectedIds.includes(p.id)).length
  const selTrim = selectedProfile ? trims.get(selectedProfile.id) : undefined
  // the lock button reads locked only when everything selected is locked, matching the toggle
  const selectionLocked = selectedIds.length > 0
    && profiles.filter((p) => selectedIds.includes(p.id)).every((p) => p.locked)
    && connectors.filter((c) => selectedIds.includes(c.id)).every((c) => c.locked)

  const edgeMismatches = mismatches.filter((m) => m.kind === 'edge')
  const seriesMismatches = mismatches.filter((m) => m.kind === 'series')

  const bom = useMemo(() => buildBom(profiles, connectors, trims, language, panels), [profiles, connectors, trims, language, panels])
  const totalCut = bom.totalCutLength
  const buttEnds = bom.buttEnds
  // how many of the joints that want a bracket actually have one, so the headline stops
  // reading "98 needed" after 48 have been fitted
  const placedBrackets = connectors.filter((c) => connectorEntry(c.type)?.isCornerBracket).length
  const bounds = useMemo(() => computeFrameBounds(profiles, trims), [profiles, trims])
  const overall = bounds ? bounds.getSize(new THREE.Vector3()) : null

  const handleSpecClick = (spec: ProfileSpec) => {
    if (held === 'profile' && activeSpec === spec) putDown()
    else setActiveSpec(spec)
  }
  const handleConnectorClick = (type: string) => {
    if (held === 'connector' && activeConnectorType === type) putDown()
    else setActiveConnector(type)
  }
  const handleClearAll = () => {
    if (!confirmClear) { setConfirmClear(true); return }
    setConfirmClear(false)
    clearAll()
    showToast(t.toastCleared, 'info')
  }
  const handleLogDebug = () => {
    console.log('%c=== ENGINE DEBUG LOG ===', 'color: #fbbf24; font-size: 14px; font-weight: bold;')
    console.log('PROFILES:', profiles)
    console.log('CONNECTORS:', connectors)
    console.log('TRIMS:', Object.fromEntries(trims))
    showToast(t.toastLog, 'info')
  }
  const handleExportBOM = () => {
    const dims = overall ? `${Math.round(overall.x)}x${Math.round(overall.z)}x${Math.round(overall.y)}` : ''
    downloadText('BOM.csv', '﻿' + bomToCsv(bom, dims), 'text/csv;charset=utf-8;')
  }
  const handleExportJSON = () => {
    const doc = { version: 2, savedAt: new Date().toISOString(), profiles, connectors, panels }
    downloadText(`aluframe-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(doc, null, 2), 'application/json')
  }
  const handleImportJSON = (file: File) => {
    file.text().then((txt) => {
      const doc = JSON.parse(txt)
      const ok = Array.isArray(doc.profiles) && doc.profiles.every((p: ProfileData) =>
        typeof p.id === 'string' && ALL_SPECS.includes(p.spec) && isFinite(p.length) &&
        Array.isArray(p.position) && p.position.length === 3 && Array.isArray(p.quaternion) && p.quaternion.length === 4)
      if (!ok) throw new Error('bad doc')
      const conns: ConnectorData[] = Array.isArray(doc.connectors) ? doc.connectors : []
      const boards: PanelData[] = Array.isArray(doc.panels) ? doc.panels : []
      loadDocument({ profiles: doc.profiles.map((p: ProfileData) => ({ ...p, miterCuts: p.miterCuts ?? [], holes: p.holes ?? [] })), connectors: conns, panels: boards })
      showToast(t.toastImported, 'success')
    }).catch(() => showToast(t.toastImportFailed, 'error'))
  }

  const jointText = (j?: { butt: boolean; trim: number; partners: number }) => {
    if (!j || j.partners === 0) return t.free
    if (j.butt) return `${t.butt} −${Math.round(j.trim)}`
    if (j.trim < 0) return `${t.through} +${Math.round(-j.trim)}`
    return t.through
  }

  if (collapsed) {
    return (
      <div className="w-11 bg-slate-800 border-r border-white/5 flex flex-col items-center gap-2 py-3 shrink-0" data-testid="sidebar-rail">
        <button onClick={() => setCollapsed(false)} title={t.expandPanel} data-testid="sidebar-expand"
          className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/10"><PanelLeftOpen size={16} /></button>
        <div className="w-6 h-px bg-white/10" />
        <div className="text-[9px] font-mono text-slate-500 writing-vertical" style={{ writingMode: 'vertical-rl' }}>
          {profiles.length} · {(totalCut / 1000).toFixed(2)}m{conflicts.length ? ` · ⚠${conflicts.length}` : ''}
        </div>
      </div>
    )
  }

  return (
    <div className="w-80 bg-slate-800 border-r border-white/5 flex flex-col text-slate-200 shrink-0" data-testid="sidebar">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 shrink-0">
        <span className="text-[10px] font-black uppercase tracking-[0.2em] text-blue-400">{t.components}</span>
        <button onClick={() => setCollapsed(true)} title={t.collapsePanel} data-testid="sidebar-collapse"
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10"><PanelLeftClose size={15} /></button>
      </div>

      {/* one scroll container for all sections: on a short window nothing gets squeezed away */}
      <div className="flex-1 overflow-y-auto min-h-0" data-testid="sidebar-scroll">
      <Section id="components" title={t.components} open={open.components} onToggle={() => toggle('components')}>
        <div className="space-y-4">
          <div>
            <label className="text-[9px] text-slate-500 font-black mb-2 block uppercase tracking-widest">{t.profiles}</label>
            <div className="grid grid-cols-5 gap-1">
              {ALL_SPECS.map((spec) => (
                <button key={spec} onClick={() => handleSpecClick(spec)} data-testid={`spec-${spec}`}
                  className={`px-1 py-2 rounded-lg text-[11px] font-bold transition-all ${
                    held === 'profile' && activeSpec === spec
                      ? 'bg-blue-600 text-white shadow-lg' : 'bg-slate-700/50 hover:bg-slate-700 text-slate-400'}`}>
                  {spec}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-[9px] text-slate-500 font-black mb-2 block uppercase tracking-widest">{t.connectors}</label>
            <div className="grid grid-cols-2 gap-1">
              {CONNECTOR_LIST.map(({ type, labelZh, labelEn }) => (
                <button key={type} onClick={() => handleConnectorClick(type)} data-testid={`connector-${type}`}
                  className={`px-2 py-1 rounded-lg text-[10px] font-bold transition-all text-left ${
                    held === 'connector' && activeConnectorType === type
                      ? 'bg-emerald-600 text-white shadow-lg' : 'bg-slate-700/50 hover:bg-slate-700 text-slate-400'}`}>
                  {language === 'zh' ? labelZh : labelEn}
                </button>
              ))}
            </div>
            {/* The frame already knows where its joints are; this puts the part on all of them. */}
            {held === 'connector' && activeConnectorType && (
              <button onClick={() => autoConnect(activeConnectorType)} data-testid="auto-connect"
                title={t.autoConnectHint} disabled={profiles.length === 0}
                className="mt-2 w-full flex items-center justify-center gap-1.5 py-1.5 bg-emerald-600/80 hover:bg-emerald-600 disabled:opacity-40 rounded-lg text-[10px] font-bold">
                <Zap size={12} />{t.autoConnect}
              </button>
            )}
          </div>
        </div>
      </Section>

      <Section
        id="properties"
        title={t.properties}
        open={open.properties}
        onToggle={() => toggle('properties')}
        badge={selectedIds.length > 0 ? <span className="text-[9px] font-mono text-blue-400">{selectedIds.length}</span> : undefined}
      >
        {selectedProfile || selectedConnector || selectedPanel ? (
          <div className="bg-slate-900/50 rounded-xl p-3 border border-white/5 space-y-3 shadow-xl" data-testid="properties">
            <div className="flex items-center justify-between border-b border-white/5 pb-2">
              <span className="text-[10px] font-black uppercase text-slate-400">{t.properties}</span>
              <div className="flex items-center gap-1">
                <button onClick={toggleLockSelected} title={t.lockHint} data-testid="lock-toggle"
                  className={`p-1.5 rounded-lg ${selectionLocked ? 'text-amber-400 bg-amber-400/10' : 'text-slate-400 hover:bg-white/5'}`}>
                  {selectionLocked ? <Lock size={14} /> : <LockOpen size={14} />}
                </button>
                <button onClick={removeSelected} disabled={selectionLocked} data-testid="delete-selected" title={selectionLocked ? t.toastLocked : t.delete}
                  className="text-red-400 hover:bg-red-400/10 disabled:opacity-30 p-1.5 rounded-lg"><Trash2 size={14} /></button>
              </div>
            </div>
            {selectedProfile && (
              <div className="space-y-3">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-500">{t.spec}</span>
                  <select value={selectedProfile.spec} onChange={(e) => setProfileSpec(selectedProfile.id, e.target.value as ProfileSpec)}
                    className="bg-slate-950 border border-white/5 rounded-lg px-2 py-1 text-xs font-mono text-blue-400 outline-none">
                    {ALL_SPECS.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-500">{t.direction}</span>
                  <span className="font-mono text-slate-300">{directionLabel(selectedProfile)}</span>
                </div>
                <div className="space-y-1">
                  <span className="text-[10px] text-slate-500 uppercase font-bold">{t.length}</span>
                  <NumField value={selectedProfile.length} onCommit={(v) => setProfileLength(selectedProfile.id, v)} />
                </div>
                <div className="space-y-1">
                  <span className="text-[10px] text-slate-500 uppercase font-bold">{t.position}</span>
                  <div className="grid grid-cols-3 gap-1">
                    {(['X', 'Y', 'Z'] as const).map((ax, i) => (
                      <NumField key={ax} label={ax} value={selectedProfile.position[i]} onCommit={(v) => {
                        const pos = [...selectedProfile.position] as [number, number, number]
                        pos[i] = v
                        setProfilePosition(selectedProfile.id, pos)
                      }} />
                    ))}
                  </div>
                </div>
                {/* The far end, so a span can be given as "from A to B" instead of being
                    converted into a start and a length by hand every time. */}
                <div className="space-y-1" data-testid="end-position">
                  <span className="text-[10px] text-slate-500 uppercase font-bold">{t.endPosition}</span>
                  <div className="grid grid-cols-3 gap-1">
                    {(['X', 'Y', 'Z'] as const).map((ax, i) => (
                      <NumField key={ax} label={ax} value={selectedEnd[i]} onCommit={(v) => {
                        const to = [...selectedEnd] as [number, number, number]
                        to[i] = v
                        setProfileEnd(selectedProfile.id, to)
                      }} />
                    ))}
                  </div>
                </div>
                <div className="bg-slate-950/60 rounded-lg p-2 text-[11px] space-y-1">
                  <div className="flex justify-between"><span className="text-slate-500">{t.cutLength}</span><span className="font-mono text-emerald-400 font-bold" data-testid="cut-length">{Math.round(selTrim?.cutLength ?? selectedProfile.length)} mm</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">{t.joints} A</span><span className="font-mono text-slate-300">{jointText(selTrim?.start)}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">{t.joints} B</span><span className="font-mono text-slate-300">{jointText(selTrim?.end)}</span></div>
                </div>
                <div className="grid grid-cols-2 gap-1">
                  <button onClick={() => flipProfile(selectedProfile.id)} title={t.flip} className="flex items-center justify-center gap-1 py-1.5 bg-slate-700/50 hover:bg-slate-700 rounded-lg text-[10px] font-bold"><ArrowLeftRight size={12} />{t.flip}</button>
                  <button onClick={() => duplicateSelected()} title={`${t.duplicate} (Ctrl+D)`} className="flex items-center justify-center gap-1 py-1.5 bg-slate-700/50 hover:bg-slate-700 rounded-lg text-[10px] font-bold"><Copy size={12} />{t.duplicate}</button>
                </div>
              </div>
            )}
            {selectedConnector && !selectedProfile && (
              <div className="space-y-3">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-500">{t.connectorProps}</span>
                  <span className="text-emerald-400 font-mono">{connectorLabel(selectedConnector.type, language)}</span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-500">{t.series}</span>
                  <select
                    value={selectedConnector.series ?? 20}
                    data-testid="connector-series"
                    onChange={(e) => setConnectorSeries(selectedConnector.id, Number(e.target.value) as 20 | 30 | 40)}
                    className="bg-slate-950 border border-white/5 rounded-lg px-2 py-1 text-xs font-mono text-emerald-400 outline-none"
                  >
                    {[20, 30, 40].map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div className="flex justify-between items-center text-[11px]">
                  <span className="text-slate-500">{t.fasteners}</span>
                  <span className="font-mono text-slate-300" data-testid="connector-fasteners">
                    {(() => {
                      const r = connectorEntry(selectedConnector.type)?.fasteners
                      if (!r || (!r.bolts && !r.nuts)) return '—'
                      const series = (selectedConnector.series ?? 20) as 20 | 30 | 40
                      return `${r.bolts}× ${boltLabel(series, language)} · ${r.nuts}× ${nutLabel(series, language)}`
                    })()}
                  </span>
                </div>
                <div className="space-y-1">
                  <span className="text-[10px] text-slate-500 uppercase font-bold">{t.position}</span>
                  <div className="grid grid-cols-3 gap-1">
                    {(['X', 'Y', 'Z'] as const).map((ax, i) => (
                      <NumField key={ax} label={ax} value={selectedConnector.position[i]} onCommit={(v) => {
                        const pos = [...selectedConnector.position] as [number, number, number]
                        pos[i] = v
                        setConnectorPosition(selectedConnector.id, pos)
                      }} />
                    ))}
                  </div>
                </div>
                <div className="flex justify-between items-center text-[11px]">
                  <span className="text-slate-500">{t.orientation}</span>
                  <span className="font-mono text-slate-300" data-testid="connector-orientation">{orientationDegrees(selectedConnector.quaternion).join(' / ')}</span>
                </div>
              </div>
            )}

            {selectedPanel && (
              <div className="space-y-2" data-testid="panel-props">
                <div className="grid grid-cols-3 gap-1">
                  <NumField label="W" value={selectedPanel.width} step={10} onCommit={(v) => setPanelSize(selectedPanel.id, { width: v })} />
                  <NumField label="H" value={selectedPanel.height} step={10} onCommit={(v) => setPanelSize(selectedPanel.id, { height: v })} />
                  <NumField label="T" value={selectedPanel.thickness} step={1} onCommit={(v) => setPanelSize(selectedPanel.id, { thickness: v })} />
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-500">{t.panelMaterial}</span>
                  <select value={selectedPanel.material} data-testid="panel-material"
                    onChange={(e) => setPanelMaterial(selectedPanel.id, e.target.value as PanelMaterial)}
                    className="bg-slate-950 border border-white/5 rounded-lg px-2 py-1 text-xs font-mono text-orange-400 outline-none">
                    {PANEL_MATERIALS.map((m) => <option key={m} value={m}>{materialLabel(m, language)}</option>)}
                  </select>
                </div>
              </div>
            )}

            {/* A board fitted to whatever members are selected: door, back, shelf, drawer front */}
            {selectedProfileCount >= 2 && (
              <div className="grid grid-cols-2 gap-1">
                <button onClick={() => addPanelFromSelection()} data-testid="add-panel" title={t.addPanelHint}
                  className="flex items-center justify-center gap-1 py-1.5 bg-orange-600/80 hover:bg-orange-600 rounded-lg text-[10px] font-bold">
                  <Square size={12} />{t.addPanel}
                </button>
                <button onClick={() => addPanelFromSelection('mdf', 18, 'inset')} data-testid="add-panel-inset" title={t.addPanelInsetHint}
                  className="flex items-center justify-center gap-1 py-1.5 bg-orange-600/30 hover:bg-orange-600/50 rounded-lg text-[10px] font-bold">
                  <SquareDashed size={12} />{t.addPanelInset}
                </button>
              </div>
            )}

            {/* Free rotation about any world axis — members and connectors alike */}
            <div className="space-y-1 pt-1 border-t border-white/5" data-testid="rotate-block">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-slate-500 uppercase font-bold">{t.rotate3d}</span>
                <label className="flex items-center gap-1 bg-slate-950 border border-white/5 rounded-lg px-2 focus-within:border-blue-500">
                  <span className="text-[9px] text-slate-500 font-bold">{t.rotateAngle}</span>
                  <input
                    type="number" step={15} value={rotAngleText} data-testid="rotate-angle"
                    onChange={(e) => setRotAngleText(e.target.value)}
                    onBlur={() => { if (!isFinite(parseFloat(rotAngleText))) setRotAngleText('90') }}
                    onKeyDown={(e) => e.stopPropagation()}
                    className={`w-14 bg-transparent py-1 text-xs font-mono outline-none ${rotAngleValid ? '' : 'text-red-400'}`}
                  />
                </label>
              </div>
              <div className="grid grid-cols-6 gap-1">
                {(['x', 'y', 'z'] as RotAxis[]).flatMap((ax) => [
                  <button key={`${ax}+`} data-testid={`rot-${ax}-plus`} disabled={!rotAngleValid} onClick={() => rotateSelected(ax, rotAngle)}
                    className="py-1.5 bg-slate-700/50 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-[10px] font-bold font-mono">{ax.toUpperCase()}+</button>,
                  <button key={`${ax}-`} data-testid={`rot-${ax}-minus`} disabled={!rotAngleValid} onClick={() => rotateSelected(ax, -rotAngle)}
                    className="py-1.5 bg-slate-700/50 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-[10px] font-bold font-mono">{ax.toUpperCase()}−</button>,
                ])}
              </div>
              {selectedProfile && (
                <div className="flex justify-between items-center text-[11px] pt-1">
                  <span className="text-slate-500">{t.orientation}</span>
                  <span className="font-mono text-slate-300" data-testid="profile-orientation">{orientationDegrees(selectedProfile.quaternion).join(' / ')}</span>
                </div>
              )}
            </div>

            {/* Symmetry and repetition: the two moves a cabinet is mostly made of */}
            <div className="space-y-1 pt-1 border-t border-white/5" data-testid="repeat-block">
              <span className="text-[10px] text-slate-500 uppercase font-bold">{t.mirror} / {t.array}</span>
              <div className="grid grid-cols-3 gap-1">
                {(['x', 'y', 'z'] as RotAxis[]).map((ax) => (
                  <button key={ax} data-testid={`mirror-${ax}`} onClick={() => mirrorSelected(ax)}
                    className="flex items-center justify-center gap-1 py-1.5 bg-slate-700/50 hover:bg-slate-700 rounded-lg text-[10px] font-bold font-mono">
                    <FlipHorizontal2 size={11} />{ax.toUpperCase()}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1">
                <label className="flex items-center gap-1 bg-slate-950 border border-white/5 rounded-lg px-2 flex-1 focus-within:border-blue-500">
                  <span className="text-[9px] text-slate-500 font-bold">{t.arrayCount}</span>
                  <input type="number" min={1} step={1} value={arrayCountText} data-testid="array-count"
                    onChange={(e) => setArrayCountText(e.target.value)} onKeyDown={(e) => e.stopPropagation()}
                    className="w-full bg-transparent py-1 text-xs font-mono outline-none" />
                </label>
                <label className="flex items-center gap-1 bg-slate-950 border border-white/5 rounded-lg px-2 flex-1 focus-within:border-blue-500">
                  <span className="text-[9px] text-slate-500 font-bold">{t.arraySpacing}</span>
                  <input type="number" step={10} value={arraySpacingText} data-testid="array-spacing"
                    onChange={(e) => setArraySpacingText(e.target.value)} onKeyDown={(e) => e.stopPropagation()}
                    className="w-full bg-transparent py-1 text-xs font-mono outline-none" />
                </label>
              </div>
              <div className="grid grid-cols-3 gap-1">
                {(['x', 'y', 'z'] as RotAxis[]).map((ax) => (
                  <button key={ax} data-testid={`array-${ax}`} disabled={!arrayValid}
                    onClick={() => arraySelected(ax, parseFloat(arrayCountText), parseFloat(arraySpacingText))}
                    className="flex items-center justify-center gap-1 py-1.5 bg-slate-700/50 hover:bg-slate-700 disabled:opacity-40 rounded-lg text-[10px] font-bold font-mono">
                    <Rows3 size={11} />{ax.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            {selectedIds.length > 1 && (
              <div className="text-[10px] text-slate-400 pt-1 border-t border-white/5">{t.selected(selectedIds.length)}</div>
            )}
          </div>
        ) : (
          <div className="py-8 flex flex-col items-center justify-center text-slate-600 opacity-40 space-y-2">
            <Box size={28} />
            <span className="text-[10px] font-bold uppercase text-center">{t.selectToEdit}</span>
          </div>
        )}
      </Section>

      <div className="grid grid-cols-2 gap-2 px-4 py-2 border-b border-white/5 shrink-0">
        <button onClick={undo} disabled={past.length === 0} title={`${t.undo} (Ctrl+Z)`}
          className="flex items-center justify-center gap-1.5 py-2 bg-slate-700/50 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed text-slate-300 rounded-lg text-[10px] font-bold">
          <Undo2 size={13} /> {t.undo}
        </button>
        <button onClick={redo} disabled={future.length === 0} title={`${t.redo} (Ctrl+Y)`}
          className="flex items-center justify-center gap-1.5 py-2 bg-slate-700/50 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed text-slate-300 rounded-lg text-[10px] font-bold">
          <Redo2 size={13} /> {t.redo}
        </button>
      </div>

      <Section
        id="bom"
        title={t.bomSummary}
        open={open.bom}
        onToggle={() => toggle('bom')}
        badge={<span className={`text-[9px] font-mono ${conflicts.length ? 'text-red-400' : 'text-slate-500'}`}>
          {profiles.length}{conflicts.length ? ` · ⚠${conflicts.length}` : ''}
        </span>}
      >
        <div className="space-y-3">
        <div className="grid grid-cols-3 gap-1.5 text-center">
          <div className="bg-white/5 p-1.5 rounded-lg border border-white/5"><div className="text-[8px] text-slate-500 uppercase">{t.totalProfiles}</div><div className="text-sm font-mono font-bold text-blue-400" data-testid="bom-count">{profiles.length}</div></div>
          <div className="bg-white/5 p-1.5 rounded-lg border border-white/5"><div className="text-[8px] text-slate-500 uppercase">{t.totalLength}</div><div className="text-sm font-mono font-bold text-blue-400">{(totalCut / 1000).toFixed(2)}m</div></div>
          <div className="bg-white/5 p-1.5 rounded-lg border border-white/5"><div className="text-[8px] text-slate-500 uppercase">{t.brackets}</div><div className="text-sm font-mono font-bold text-amber-400" data-testid="bom-brackets" title={t.bracketsHint}>{placedBrackets}<span className="text-slate-500">/{buttEnds}</span></div></div>
        </div>
        {overall && (
          <div className="text-[10px] text-slate-400 flex justify-between"><span>{t.overall}</span><span className="font-mono text-slate-200" data-testid="bom-overall">{Math.round(overall.x)}×{Math.round(overall.z)}×{Math.round(overall.y)}</span></div>
        )}
        {profiles.length > 1 && (
          <button
            onClick={() => { if (conflicts.length) useStore.getState().selectItems([...conflictIds]) }}
            disabled={conflicts.length === 0}
            className={`w-full text-[10px] flex justify-between items-center ${conflicts.length ? 'text-red-400 hover:text-red-300' : 'text-slate-500 cursor-default'}`}
          >
            <span className="flex items-center gap-1">{conflicts.length > 0 && <AlertTriangle size={11} />}{t.penetrations}</span>
            <span className="font-mono" data-testid="bom-penetrations">{conflicts.length ? t.penetrationsCount(conflicts.length) : t.penetrationsOk}</span>
          </button>
        )}
        {profiles.length > 1 && (
          <button
            onClick={() => { if (edgeMismatches.length) useStore.getState().selectItems(edgeMismatches.flatMap((m) => [m.a, m.b])) }}
            disabled={edgeMismatches.length === 0}
            className={`w-full text-[10px] flex justify-between items-center ${edgeMismatches.length ? 'text-amber-400 hover:text-amber-300' : 'text-slate-500 cursor-default'}`}
          >
            <span className="flex items-center gap-1">{edgeMismatches.length > 0 && <AlertTriangle size={11} />}{t.specMismatch}</span>
            <span className="font-mono" data-testid="bom-mismatches">
              {edgeMismatches.length ? t.specMismatchCount(edgeMismatches.length) : t.specMismatchOk}
            </span>
          </button>
        )}
        {seriesMismatches.length > 0 && (
          <div className="w-full text-[10px] flex justify-between items-center text-slate-500">
            <span>{t.crossSeries}</span>
            <span className="font-mono" data-testid="bom-cross-series">{t.crossSeriesCount(seriesMismatches.length)}</span>
          </div>
        )}
        {(bom.profiles.length > 0 || bom.connectors.length > 0) && (
          <div className="max-h-44 overflow-y-auto rounded-lg border border-white/5 text-[10px] font-mono" data-testid="bom-table">
            {bom.profiles.map((r) => (
              <div key={r.key} className="flex justify-between px-2 py-1 odd:bg-white/5">
                <span className="text-slate-400">{r.label}</span><span className="text-slate-200">{r.length} mm</span><span className="text-blue-400">×{r.qty}</span>
              </div>
            ))}
            {bom.connectors.map((r) => (
              <div key={r.key} className="flex justify-between px-2 py-1 odd:bg-white/5">
                <span className="text-slate-400 truncate">{r.label}</span><span className="text-slate-500">{r.spec}</span><span className="text-emerald-400">×{r.qty}</span>
              </div>
            ))}
            {bom.fasteners.length > 0 && (
              <div className="px-2 py-1 text-[9px] uppercase tracking-widest text-slate-500 bg-white/5" data-testid="bom-fasteners">{t.fasteners}</div>
            )}
            {bom.fasteners.map((r) => (
              <div key={r.key} className="flex justify-between px-2 py-1 odd:bg-white/5">
                <span className="text-slate-400 truncate">{r.label}</span><span /><span className="text-amber-400">×{r.qty}</span>
              </div>
            ))}
            {bom.panels.length > 0 && (
              <div className="px-2 py-1 text-[9px] uppercase tracking-widest text-slate-500 bg-white/5" data-testid="bom-panels">{t.boardCutList}</div>
            )}
            {bom.panels.map((r) => (
              <div key={r.key} className="flex justify-between px-2 py-1 odd:bg-white/5">
                <span className="text-slate-400 truncate">{r.label}</span><span className="text-slate-500">{r.spec}</span><span className="text-orange-400">×{r.qty}</span>
              </div>
            ))}
            {bom.suggested.length > 0 && (
              <div className="px-2 py-1 text-[9px] uppercase tracking-widest text-slate-500 bg-white/5" data-testid="bom-suggested">{t.suggested}</div>
            )}
            {bom.suggested.map((r) => (
              <div key={r.key} className="flex justify-between px-2 py-1 odd:bg-white/5">
                <span className="text-slate-500 truncate">{r.label}</span><span /><span className="text-slate-400">×{r.qty}</span>
              </div>
            ))}
          </div>
        )}

        <button onClick={handleExportBOM} disabled={profiles.length === 0} data-testid="export-bom" className="w-full flex items-center justify-center gap-2 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded-lg text-[11px] font-bold shadow-lg active:scale-95">
          <Download size={14} /> {t.exportBOM}
        </button>
        <div className="grid grid-cols-2 gap-2">
          <button onClick={handleExportJSON} data-testid="export-project" className="flex items-center justify-center gap-1.5 py-2 bg-slate-700/50 hover:bg-slate-700 text-slate-300 rounded-lg text-[10px] font-bold"><Save size={13} /> {t.exportJSON}</button>
          <button onClick={() => fileRef.current?.click()} className="flex items-center justify-center gap-1.5 py-2 bg-slate-700/50 hover:bg-slate-700 text-slate-300 rounded-lg text-[10px] font-bold"><Upload size={13} /> {t.importJSON}</button>
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImportJSON(f); e.target.value = '' }} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button onClick={handleLogDebug} className="flex items-center justify-center gap-2 py-2 bg-amber-600/20 hover:bg-amber-600/40 text-amber-500 border border-amber-600/30 rounded-lg text-[10px] font-bold"><Bug size={14} /> LOG</button>
          <button onClick={handleClearAll} data-testid="clear-all"
            className={`flex items-center justify-center gap-2 py-2 border rounded-lg text-[10px] font-bold transition-all ${confirmClear ? 'bg-red-600 text-white border-red-500' : 'bg-slate-800 hover:bg-red-600/20 text-slate-500 hover:text-red-400 border-white/5'}`}>
            <Eraser size={14} /> {confirmClear ? t.clearConfirm : t.clear}
          </button>
        </div>
        </div>
      </Section>
      </div>
    </div>
  )
}

export default Sidebar
