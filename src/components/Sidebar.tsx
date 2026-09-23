import React, { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Trash2, Download, Box, Eraser, Bug, Undo2, Redo2, Upload, Save, Copy, ArrowLeftRight, AlertTriangle, ChevronRight, PanelLeftClose, PanelLeftOpen, Lock, LockOpen, FlipHorizontal2, Rows3, Square, SquareDashed, Zap, Archive, DoorOpen, Scissors, FileCode } from 'lucide-react'
import { useStore, ProfileSpec, type ProfileData, type ConnectorData, type PanelData, type FittingData, type PanelMaterial, type HingeSide, type HingeType, type Overlay } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { translations } from '../utils/translations'
import { computeFrameBounds } from '../utils/jointUtils'
import { getProfileEndpoints } from '../utils/geometryCore'
import { CONNECTOR_CATALOG, boltLabel, connectorEntry, connectorLabel, nutLabel } from '../utils/connectorCatalog'
import { buildBom, bomToCsv } from '../utils/bom'
import { analyzeFrame } from '../utils/analysis'
import { autoConnect } from '../utils/autoConnect'
import { ALL_SPECS, specDims } from '../utils/specUtils'
import { addPanelFromSelection, materialLabel, PANEL_MATERIALS, setPanelMaterial, setPanelSize } from '../utils/panelOps'
import { rollProfile, sectionFacing } from '../utils/faceAlign'
import { addFittingFromSelection } from '../utils/fittingOps'
import { downloadText, openProject, saveProject, savedFileName } from '../utils/projectFile'
import { clearOpLog, opLog, opLogText, subscribeOpLog } from '../utils/opLog'
import { nestProfiles, nestingCsv } from '../utils/nesting'
import { buildDxf } from '../utils/dxf'
import { auditBrackets } from '../utils/bracketSeat'
import { arraySelected, directionLabel, duplicateSelected, flipProfile, mirrorSelected, orientationDegrees, rotateSelected, setProfileEnd, setConnectorSeries, setProfileLength, setProfilePosition, setProfileSpec, type RotAxis } from '../utils/editOps'

/** "40 side faces ↑" and the like, so the roll is something you can read off the panel */
function facingLabel(p: ProfileData): string {
  const v = sectionFacing(p)
  const axes: Array<[string, number]> = [['X', v.x], ['Y', v.y], ['Z', v.z]]
  const [name, value] = axes.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0]
  const long = Math.max(specDims(p.spec).w, specDims(p.spec).h)
  return `${long} → ${value >= 0 ? '+' : '−'}${name}`
}

export const CONNECTOR_LIST: { type: string; labelZh: string; labelEn: string }[] = CONNECTOR_CATALOG



type SectionKey = 'components' | 'properties' | 'bom' | 'log'

/** Collapsible sidebar section with a sticky header */
const Section: React.FC<{
  id: SectionKey
  title: string
  badge?: React.ReactNode
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}> = ({ id, title, badge, open, onToggle, children }) => {
  const t = translations[useToolStore.getState().language]
  return (
  <div className="flex flex-col border-b border-white/5">
    <button
      onClick={onToggle}
      data-testid={`section-${id}`}
      aria-expanded={open}
      title={t.hintSection(title)}
      className="flex items-center gap-2 px-4 py-2.5 text-[11px] font-black uppercase tracking-[0.15em] text-slate-400 hover:text-white hover:bg-white/5 shrink-0"
    >
      <ChevronRight size={13} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
      <span className="flex-1 text-left">{title}</span>
      {badge}
    </button>
    {open && <div className="px-4 pb-4" data-testid={`section-${id}-body`}>{children}</div>}
  </div>
  )
}

/** Numeric field that commits on Enter / blur and re-syncs from props otherwise */
/** the same red / green / blue the gizmo arrows use, so a field and an axis read as one thing */
const AXIS_COLOR: Record<string, string> = { X: '#ef4444', Y: '#22c55e', Z: '#3b82f6' }

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
      {label && (
        <span className="text-[9px] font-bold w-3" style={{ color: AXIS_COLOR[label] ?? '#64748b' }}>{label}</span>
      )}
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
  const { profiles, connectors, panels, fittings, selectedIds, removeSelected, toggleLockSelected, clearAll, undo, redo, past, future, loadDocument } = useStore()
  const { activeSpec, setActiveSpec, activeConnectorType, setActiveConnector, held, putDown, language, showToast,
    workPlaneY, setWorkPlaneY, throughRule, setThroughRule, viewMode, setViewMode } = useToolStore()
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
  const [workPlaneText, setWorkPlaneText] = useState('0')
  const [drawerHeightText, setDrawerHeightText] = useState('200')
  const [drawerCountText, setDrawerCountText] = useState('1')
  const [hingeSide, setHingeSide] = useState<HingeSide>('left')
  const [hingeType, setHingeType] = useState<HingeType>('cup')
  const [overlay, setOverlay] = useState<Overlay>('full')
  const [savedName, setSavedName] = useState<string | null>(savedFileName())
  // the log lives outside React, so the panel listens for it rather than owning it
  const [stockText, setStockText] = useState('6000')
  const [log, setLog] = useState(opLog())
  useEffect(() => subscribeOpLog(() => setLog([...opLog()])), [])
  // the highest point of whatever is selected, so the work plane can be put on top of it
  const selectionTopY = useMemo(() => {
    const ids = new Set(selectedIds)
    if (ids.size === 0) return null
    let top = -Infinity
    for (const p of profiles) {
      if (!ids.has(p.id)) continue
      const { start, end } = getProfileEndpoints(p)
      top = Math.max(top, start.y, end.y)
    }
    for (const c of connectors) if (ids.has(c.id)) top = Math.max(top, c.position[1])
    for (const b of panels) if (ids.has(b.id)) top = Math.max(top, b.position[1] + b.height / 2)
    return isFinite(top) ? Math.round(top) : null
  }, [selectedIds, profiles, connectors, panels])
  const [collapsed, setCollapsed] = useState(false)
  // section state is remembered per browser, and selecting something opens the properties
  const [open, setOpen] = useState<Record<SectionKey, boolean>>(() => {
    try {
      const saved = localStorage.getItem('aluminum-designer-sections')
      if (saved) return { components: true, properties: true, bom: true, log: false, ...JSON.parse(saved) }
    } catch { /* private mode or blocked storage */ }
    return { components: true, properties: true, bom: true, log: false }
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

  const bracketFaults = useMemo(() => auditBrackets(profiles, connectors), [profiles, connectors])
  const edgeMismatches = mismatches.filter((m) => m.kind === 'face')
  const seriesMismatches = mismatches.filter((m) => m.kind === 'series')

  const bom = useMemo(() => buildBom(profiles, connectors, trims, language, panels, fittings), [profiles, connectors, trims, language, panels, fittings])
  const stockMm = Math.max(500, parseFloat(stockText) || 6000)
  const nesting = useMemo(() => nestProfiles(bom.profiles, stockMm), [bom.profiles, stockMm])
  const totalCut = bom.totalCutLength
  const buttEnds = bom.buttEnds
  // how many of the joints that want a bracket actually have one, so the headline stops
  // reading "98 needed" after 48 have been fitted
  const placedBrackets = connectors.filter((c) => connectorEntry(c.type)?.isCornerBracket).length
  const bounds = useMemo(() => computeFrameBounds(profiles, trims), [profiles, trims])
  const overall = bounds ? bounds.getSize(new THREE.Vector3()) : null

  // Picking a part up is building, so it goes back to building rather than quietly doing
  // nothing — pressing a profile while looking can only have meant "I want to draw one".
  const handleSpecClick = (spec: ProfileSpec) => {
    if (viewMode) setViewMode(false)
    if (held === 'profile' && activeSpec === spec) putDown()
    else setActiveSpec(spec)
  }
  const handleConnectorClick = (type: string) => {
    if (viewMode) setViewMode(false)
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
  // Save to a file you pick, and save over it next time. A download is not a save: it drops
  // a numbered copy in Downloads that can never be written over, and after a few edits
  // nobody knows which of the five files is the drawing.
  const handleExportCutting = () => {
    downloadText(`aluframe-cutting-${new Date().toISOString().slice(0, 10)}.csv`,
      '\ufeff' + nestingCsv(nesting, stockMm), 'text/csv;charset=utf-8')
  }
  // A screenshot is not a drawing: it cannot be measured and it cannot go on a machine.
  const handleExportDxf = () => {
    downloadText(`aluframe-${new Date().toISOString().slice(0, 10)}.dxf`,
      buildDxf({ profiles, panels, fittings }), 'application/dxf')
  }
  const handleSaveProject = async (asNew = false) => {
    const doc = { version: 3, savedAt: new Date().toISOString(), profiles, connectors, panels, fittings }
    const suggested = savedFileName() ?? `aluframe-${new Date().toISOString().slice(0, 10)}.json`
    const r = await saveProject(JSON.stringify(doc, null, 2), suggested, asNew)
    if (r.outcome === 'cancelled') return
    setSavedName(savedFileName())
    showToast(
      r.outcome === 'overwritten' ? t.toastSavedOver(r.name ?? '')
      : r.outcome === 'saved' ? t.toastSavedAs(r.name ?? '')
      : t.toastDownloaded(r.name ?? ''),
      'success',
    )
  }
  const handleOpenProject = async () => {
    const picked = await openProject()
    if (!picked) { fileRef.current?.click(); return }
    try {
      applyDocument(JSON.parse(picked.text))
      setSavedName(savedFileName())
      showToast(t.toastImported, 'success')
    } catch { showToast(t.toastImportFailed, 'error') }
  }
  /** A saved drawing, checked before it replaces the one on screen. Throws if it is not one. */
  const applyDocument = (doc: {
    profiles?: ProfileData[]; connectors?: ConnectorData[]; panels?: PanelData[]; fittings?: FittingData[]
  }) => {
    const ok = Array.isArray(doc.profiles) && doc.profiles.every((p: ProfileData) =>
      typeof p.id === 'string' && ALL_SPECS.includes(p.spec) && isFinite(p.length) &&
      Array.isArray(p.position) && p.position.length === 3 && Array.isArray(p.quaternion) && p.quaternion.length === 4)
    if (!ok) throw new Error('bad doc')
    loadDocument({
      profiles: doc.profiles!.map((p: ProfileData) => ({ ...p, miterCuts: p.miterCuts ?? [], holes: p.holes ?? [] })),
      connectors: Array.isArray(doc.connectors) ? doc.connectors : [],
      panels: Array.isArray(doc.panels) ? doc.panels : [],
      fittings: Array.isArray(doc.fittings) ? doc.fittings : [],
    })
  }
  const handleImportJSON = (file: File) => {
    file.text().then((txt) => {
      applyDocument(JSON.parse(txt))
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
                  title={t.hintSpec(spec)}
                  className={`px-1 py-2 rounded-lg text-[11px] font-bold transition-all ${
                    held === 'profile' && activeSpec === spec
                      ? 'bg-blue-600 text-white shadow-lg' : 'bg-slate-700/50 hover:bg-slate-700 text-slate-400'}`}>
                  {spec}
                </button>
              ))}
            </div>
          </div>
          {/* How the frame is put together, which decides every trim in it */}
          <div>
            <label className="text-[9px] text-slate-500 font-black mb-2 block uppercase tracking-widest">{t.throughRule}</label>
            <div className="grid grid-cols-2 gap-1" title={t.throughRuleHint}>
              {([['rails', t.throughRails], ['posts', t.throughPosts]] as const).map(([rule, label]) => (
                <button key={rule} onClick={() => setThroughRule(rule)} data-testid={`through-${rule}`}
                  title={t.throughRuleHint}
                  className={`px-2 py-1.5 rounded-lg text-[10px] font-bold transition-all ${
                    throughRule === rule ? 'bg-blue-600 text-white shadow-lg' : 'bg-slate-700/50 hover:bg-slate-700 text-slate-400'}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* A drawing setting, so it lives with the parts rather than among the view
              toggles: it decides where a click lands when there is nothing to attach to. */}
          <div>
            <label className="text-[9px] text-slate-500 font-black mb-2 block uppercase tracking-widest">{t.workPlane}</label>
            <div className="flex items-center gap-1">
              <label className="flex items-center gap-1 bg-slate-950 border border-white/5 rounded-lg px-2 flex-1 focus-within:border-blue-500">
                <span className="text-[9px] text-slate-500 font-bold">Y</span>
                <input type="number" step={10} min={0} value={workPlaneText} data-testid="work-plane"
                  onChange={(e) => { setWorkPlaneText(e.target.value); setWorkPlaneY(parseFloat(e.target.value)) }}
                  onKeyDown={(e) => e.stopPropagation()}
                  className={`w-full bg-transparent py-1.5 text-xs font-mono outline-none ${workPlaneY > 0 ? 'text-amber-300' : ''}`} />
                <span className="text-[9px] text-slate-500">mm</span>
              </label>
              <button data-testid="work-plane-from-selection" title={t.workPlaneFromSelection}
                disabled={selectionTopY === null}
                onClick={() => { if (selectionTopY !== null) { setWorkPlaneY(selectionTopY); setWorkPlaneText(String(selectionTopY)) } }}
                className="px-2 py-1.5 rounded-lg bg-slate-700/50 hover:bg-slate-700 disabled:opacity-30 text-[10px] font-bold whitespace-nowrap">
                {t.workPlaneFromSelection}
              </button>
            </div>
            <p className="text-[9px] text-slate-500 mt-1 leading-snug">{t.workPlaneHint}</p>
          </div>

          <div>
            <label className="text-[9px] text-slate-500 font-black mb-2 block uppercase tracking-widest">{t.connectors}</label>
            <div className="grid grid-cols-2 gap-1">
              {CONNECTOR_LIST.map(({ type, labelZh, labelEn }) => (
                <button key={type} onClick={() => handleConnectorClick(type)} data-testid={`connector-${type}`}
                  title={t.hintConnectorPick(language === 'zh' ? labelZh : labelEn)}
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
                {/* A 2040 on edge and one lying flat are different parts: which way the long
                    side of the section faces is a real property, and it decides whether a
                    bracket can lie flat on the joints at either end. */}
                {specDims(selectedProfile.spec).w !== specDims(selectedProfile.spec).h && (
                  <div className="flex justify-between items-center text-xs" data-testid="section-roll">
                    <span className="text-slate-500" title={t.sectionRollHint}>{t.sectionRoll}</span>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-slate-300 text-[11px]">{facingLabel(selectedProfile)}</span>
                      <button onClick={() => rollProfile(selectedProfile.id)} data-testid="roll-section"
                        title={t.hintRoll}
                        className="px-2 py-1 rounded-lg bg-slate-700/50 hover:bg-slate-700 text-[10px] font-bold">
                        {t.rollQuarter}
                      </button>
                    </div>
                  </div>
                )}

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
                {/* Read-only: a bracket's place is decided by the joint, not by typing into
                    a box. Where it is, is still worth seeing. */}
                <div className="space-y-1" title={t.hintConnectorFixed}>
                  <span className="text-[10px] text-slate-500 uppercase font-bold">{t.position}</span>
                  <div className="grid grid-cols-3 gap-1" data-testid="connector-position">
                    {(['X', 'Y', 'Z'] as const).map((ax, i) => (
                      <div key={ax} className="flex items-center gap-1 bg-slate-950/60 border border-white/5 rounded-lg px-2 py-1">
                        <span className="text-[9px] font-black" style={{ color: AXIS_COLOR[ax] }}>{ax}</span>
                        <span className="text-xs font-mono text-slate-400">{Math.round(selectedConnector.position[i])}</span>
                      </div>
                    ))}
                  </div>
                  <p className="text-[9px] text-slate-600 leading-snug pt-0.5">{t.hintConnectorFixed}</p>
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

            {/* A drawer and a door are components, not piles of board. A drawer is a box that
                slides — the runner takes 12.5 mm a side, so the box is 25 mm narrower than the
                opening and needs a rail each side to screw to. A door hangs on hinges, and
                which hinge decides how far it opens and whether anything has to be bored. */}
            {selectedProfileCount >= 2 && (
              <div className="space-y-1 pt-1 border-t border-white/5" data-testid="fitting-block">
                <span className="text-[10px] text-slate-500 uppercase font-bold">{t.fittings}</span>
                <div className="flex items-center gap-1">
                  <label className="flex items-center gap-1 bg-slate-950 border border-white/5 rounded-lg px-2 flex-1 focus-within:border-blue-500">
                    <span className="text-[9px] text-slate-500 font-bold">{t.drawerHeight}</span>
                    <input type="number" step={10} value={drawerHeightText} data-testid="drawer-height"
                      onChange={(e) => setDrawerHeightText(e.target.value)} onKeyDown={(e) => e.stopPropagation()}
                      className="w-full bg-transparent py-1.5 text-xs font-mono outline-none" />
                  </label>
                  <label className="flex items-center gap-1 bg-slate-950 border border-white/5 rounded-lg px-2 w-20 focus-within:border-blue-500">
                    <span className="text-[9px] text-slate-500 font-bold">{t.drawerCount}</span>
                    <input type="number" min={1} max={8} step={1} value={drawerCountText} data-testid="drawer-count"
                      onChange={(e) => setDrawerCountText(e.target.value)} onKeyDown={(e) => e.stopPropagation()}
                      className="w-full bg-transparent py-1.5 text-xs font-mono outline-none" />
                  </label>
                </div>
                <button
                  onClick={() => addFittingFromSelection({ kind: 'drawer', frontHeight: parseFloat(drawerHeightText), count: parseFloat(drawerCountText) })}
                  data-testid="add-drawer" title={t.drawerHint}
                  className="w-full flex items-center justify-center gap-1 py-1.5 bg-sky-600/80 hover:bg-sky-600 rounded-lg text-[10px] font-bold">
                  <Archive size={12} />{t.drawer}
                </button>

                <div className="grid grid-cols-4 gap-1 pt-0.5">
                  {(['left', 'right', 'top', 'bottom'] as const).map((side) => (
                    <button key={side} data-testid={`hinge-${side}`} onClick={() => setHingeSide(side)}
                      title={`${t.hingeSide} ${({ left: t.hingeLeft, right: t.hingeRight, top: t.hingeTop, bottom: t.hingeBottom })[side]}`}
                      className={`py-1 rounded-lg text-[10px] font-bold ${hingeSide === side ? 'bg-blue-600 text-white' : 'bg-slate-700/50 hover:bg-slate-700 text-slate-400'}`}>
                      {({ left: t.hingeLeft, right: t.hingeRight, top: t.hingeTop, bottom: t.hingeBottom })[side]}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-3 gap-1">
                  {([['cup', t.hingeCup, t.hintHingeCup], ['slot', t.hingeSlot, t.hintHingeSlot], ['continuous', t.hingeContinuous, t.hintHingeContinuous]] as const).map(([k, label, tip]) => (
                    <button key={k} data-testid={`hingetype-${k}`} onClick={() => setHingeType(k)} title={tip}
                      className={`py-1 rounded-lg text-[9px] font-bold ${hingeType === k ? 'bg-blue-600 text-white' : 'bg-slate-700/50 hover:bg-slate-700 text-slate-400'}`}>
                      {label}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-3 gap-1">
                  {([['full', t.overlayFull], ['half', t.overlayHalf], ['inset', t.overlayInset]] as const).map(([k, label]) => (
                    <button key={k} data-testid={`overlay-${k}`} onClick={() => setOverlay(k)} title={t.hintOverlay}
                      className={`py-1 rounded-lg text-[9px] font-bold ${overlay === k ? 'bg-blue-600 text-white' : 'bg-slate-700/50 hover:bg-slate-700 text-slate-400'}`}>
                      {label}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => addFittingFromSelection({ kind: 'door', hinge: hingeSide, hingeType, overlay })}
                  data-testid="add-door" title={t.hintAddDoor}
                  className="w-full flex items-center justify-center gap-1 py-1.5 bg-amber-600/80 hover:bg-amber-600 rounded-lg text-[10px] font-bold">
                  <DoorOpen size={12} />{t.addDoor}
                </button>
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
                    title={t.hintRotateFwd(ax.toUpperCase())}
                    style={{ color: AXIS_COLOR[ax.toUpperCase()] }}
                    className="py-1.5 bg-slate-700/50 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-[10px] font-bold font-mono">{ax.toUpperCase()}+</button>,
                  <button key={`${ax}-`} data-testid={`rot-${ax}-minus`} disabled={!rotAngleValid} onClick={() => rotateSelected(ax, -rotAngle)}
                    title={t.hintRotateBack(ax.toUpperCase())}
                    style={{ color: AXIS_COLOR[ax.toUpperCase()] }}
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
                    title={t.hintMirror(ax.toUpperCase())}
                    style={{ color: AXIS_COLOR[ax.toUpperCase()] }}
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
                    title={t.hintArray(ax.toUpperCase())}
                    style={{ color: AXIS_COLOR[ax.toUpperCase()] }}
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
            title={t.hintConflicts}
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
            title={t.hintMismatches}
            disabled={edgeMismatches.length === 0}
            className={`w-full text-[10px] flex justify-between items-center ${edgeMismatches.length ? 'text-amber-400 hover:text-amber-300' : 'text-slate-500 cursor-default'}`}
          >
            <span className="flex items-center gap-1">{edgeMismatches.length > 0 && <AlertTriangle size={11} />}{t.specMismatch}</span>
            <span className="font-mono" data-testid="bom-mismatches">
              {edgeMismatches.length ? t.specMismatchCount(edgeMismatches.length) : t.specMismatchOk}
            </span>
          </button>
        )}
        {/* A bracket beside a joint renders exactly like one bolted to it, and the cut list
            counts it either way — so the only way to know is to ask. */}
        {connectors.length > 0 && (
          <button
            onClick={() => { if (bracketFaults.length) useStore.getState().selectItems(bracketFaults.map((f) => f.id)) }}
            title={t.hintBracketSeating}
            disabled={bracketFaults.length === 0}
            className={`w-full text-[10px] flex justify-between items-center ${bracketFaults.length ? 'text-amber-400 hover:text-amber-300' : 'text-slate-500 cursor-default'}`}
          >
            <span className="flex items-center gap-1">{bracketFaults.length > 0 && <AlertTriangle size={11} />}{t.bracketSeating}</span>
            <span className="font-mono" data-testid="bom-bracket-seating">
              {bracketFaults.length ? t.bracketSeatingBad(bracketFaults.length) : t.bracketSeatingOk}
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

        {/* A cut list says you need forty-two pieces. It does not say how many six-metre
            lengths to order, which is the number that goes on the purchase order — so
            everyone works it out on paper, badly, and buys one too few. */}
        {bom.profiles.length > 0 && (
          <div className="space-y-1 pt-2 border-t border-white/5" data-testid="nesting-block">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-slate-500 uppercase font-bold" title={t.hintNesting}>{t.nesting}</span>
              <label className="flex items-center gap-1 bg-slate-950 border border-white/5 rounded-lg px-2 focus-within:border-blue-500">
                <span className="text-[9px] text-slate-500 font-bold">{t.stockLength}</span>
                <input type="number" step={500} min={500} value={stockText} data-testid="stock-length"
                  onChange={(e) => setStockText(e.target.value)} onKeyDown={(e) => e.stopPropagation()}
                  className="w-16 bg-transparent py-1 text-xs font-mono outline-none" />
              </label>
            </div>
            <div className="text-[10px] font-mono rounded-lg border border-white/5 overflow-hidden" data-testid="nesting-summary">
              {nesting.bySpec.map((r) => (
                <div key={r.spec} className="flex justify-between px-2 py-1 odd:bg-white/5">
                  <span className="text-slate-400">{r.spec}</span>
                  <span className="text-blue-400 font-bold">{t.barsNeeded(r.bars)}</span>
                  <span className="text-slate-500">{t.longestOffcut} {Math.round(r.longestOffcut)}</span>
                </div>
              ))}
              <div className="flex justify-between px-2 py-1 bg-white/5 border-t border-white/5">
                <span className="text-slate-500">{t.nestYield}</span>
                <span className="font-bold text-emerald-400" data-testid="nesting-yield">{(nesting.yield * 100).toFixed(1)}%</span>
              </div>
            </div>
            <button onClick={handleExportCutting} data-testid="export-cutting" title={t.hintExportCutting}
              className="w-full flex items-center justify-center gap-1.5 py-1.5 bg-slate-700/50 hover:bg-slate-700 text-slate-300 rounded-lg text-[10px] font-bold">
              <Scissors size={12} /> {t.exportCutting}
            </button>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <button onClick={handleExportBOM} disabled={profiles.length === 0} data-testid="export-bom" title={t.hintExportBOM}
            className="flex items-center justify-center gap-2 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded-lg text-[11px] font-bold shadow-lg active:scale-95">
            <Download size={14} /> {t.exportBOM}
          </button>
          <button onClick={handleExportDxf} disabled={profiles.length + panels.length + fittings.length === 0}
            data-testid="export-dxf" title={t.hintExportDxf}
            className="flex items-center justify-center gap-2 py-2 bg-blue-600/70 hover:bg-blue-500 disabled:opacity-40 rounded-lg text-[11px] font-bold shadow-lg active:scale-95">
            <FileCode size={14} /> {t.exportDxf}
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button onClick={() => handleSaveProject(false)} data-testid="export-project" title={t.hintSave}
            className="flex items-center justify-center gap-1.5 py-2 bg-slate-700/50 hover:bg-slate-700 text-slate-300 rounded-lg text-[10px] font-bold">
            <Save size={13} /> {savedName ?? t.exportJSON}
          </button>
          <button onClick={handleOpenProject} title={t.hintImport} data-testid="import-project"
            className="flex items-center justify-center gap-1.5 py-2 bg-slate-700/50 hover:bg-slate-700 text-slate-300 rounded-lg text-[10px] font-bold">
            <Upload size={13} /> {t.importJSON}
          </button>
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImportJSON(f); e.target.value = '' }} />
        </div>
        {savedName && (
          <button onClick={() => handleSaveProject(true)} data-testid="save-as" title={t.hintSaveAs}
            className="w-full py-1.5 text-[10px] font-bold text-slate-500 hover:text-slate-300">{t.saveAs}</button>
        )}
        <div className="grid grid-cols-2 gap-2">
          <button onClick={handleLogDebug} className="flex items-center justify-center gap-2 py-2 bg-amber-600/20 hover:bg-amber-600/40 text-amber-500 border border-amber-600/30 rounded-lg text-[10px] font-bold"><Bug size={14} /> LOG</button>
          <button onClick={handleClearAll} data-testid="clear-all" title={t.hintClearAll}
            className={`flex items-center justify-center gap-2 py-2 border rounded-lg text-[10px] font-bold transition-all ${confirmClear ? 'bg-red-600 text-white border-red-500' : 'bg-slate-800 hover:bg-red-600/20 text-slate-500 hover:text-red-400 border-white/5'}`}>
            <Eraser size={14} /> {confirmClear ? t.clearConfirm : t.clear}
          </button>
        </div>
        </div>
      </Section>

      {/* Undo remembers the last few states and forgets them when the page reloads, so
          "why would this rail not move" had no answer the next morning. This has one. */}
      <Section id="log" title={t.opLog} open={open.log} onToggle={() => toggle('log')}
        badge={<span className="text-[9px] font-mono text-slate-600">{log.length || ''}</span>}>
        <div className="space-y-2">
          <div className="max-h-64 overflow-auto text-[10px] font-mono rounded-lg border border-white/5" data-testid="op-log">
            {log.length === 0
              ? <div className="px-2 py-3 text-slate-600 text-center">{t.opLogEmpty}</div>
              : [...log].reverse().slice(0, 120).map((e, i) => (
                <div key={log.length - i} className="flex gap-2 px-2 py-1 odd:bg-white/5 items-baseline">
                  <span className="text-slate-600 shrink-0">{new Date(e.at).toTimeString().slice(0, 8)}</span>
                  <span className="text-slate-300 shrink-0 font-bold">{e.label}</span>
                  <span className="text-slate-500 truncate" title={e.detail}>{e.detail}</span>
                </div>
              ))}
          </div>
          <div className="grid grid-cols-2 gap-1">
            <button data-testid="op-log-copy" title={t.hintOpLog} disabled={log.length === 0}
              onClick={() => { navigator.clipboard?.writeText(opLogText()); showToast(t.toastOpLogCopied, 'success') }}
              className="py-1.5 bg-slate-700/50 hover:bg-slate-700 disabled:opacity-40 rounded-lg text-[10px] font-bold text-slate-300">
              {t.opLogCopy}
            </button>
            <button data-testid="op-log-clear" disabled={log.length === 0} onClick={() => clearOpLog()}
              className="py-1.5 bg-slate-800 hover:bg-red-600/20 hover:text-red-400 disabled:opacity-40 rounded-lg text-[10px] font-bold text-slate-500">
              {t.opLogClear}
            </button>
          </div>
        </div>
      </Section>
      </div>
    </div>
  )
}

export default Sidebar
