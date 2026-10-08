import { useEffect, useMemo, useState } from 'react'
import { nearbyConnectorSeats, sameConnectorModel } from '../utils/connectorRecovery'
import { placementObstacles } from '../utils/placementObstacles'
import * as THREE from 'three'
import { useInspectionStore } from '../store/useInspectionStore'
import { useToolStore } from '../store/useToolStore'
import { useConnectorEditStore } from '../store/useConnectorEditStore'
import { useStore } from '../store/useStore'
import { validateConnectorPlacement, type ConnectorPlacementReason } from '../utils/connectorPlacement'
import { connectorLabel } from '../utils/connectorCatalog'
import { partNumber } from '../utils/partNumbers'
import { nextId } from '../utils/profileFactory'
import { reportEditResult } from '../utils/editFeedback'
import { translations } from '../utils/translations'

export default function AutoConnectReport() {
  const report = useInspectionStore(s => s.report)
  const doc = useStore()
  const { language, viewMode, held } = useToolStore(), zh = language === 'zh', t = translations[language]
  const [active, setActive] = useState(-1), [choice, setChoice] = useState(-1)
  useEffect(() => { setActive(-1); setChoice(-1) }, [report])
  const issue = report?.issues[active]
  const options = useMemo(() => ({ panels: doc.panels, equipment: doc.equipment, fittings: doc.fittings,
    excludeConnectorId: issue?.connectorId }), [doc.panels, doc.equipment, doc.fittings, issue?.connectorId])
  const candidates = useMemo(() => !report || !issue ? [] : nearbyConnectorSeats(report.type, new THREE.Vector3(...issue.position), doc.profiles, doc.connectors, options)
    .filter(c => (!issue.candidate || sameConnectorModel(issue.candidate, c.seat))
      && (!issue.hosts.length || issue.hosts.every(id => c.legs.includes(id)))
      && new THREE.Vector3(...c.seat.position).distanceTo(new THREE.Vector3(...issue.position)) <= 100)
    .sort((a, b) => Number(b.allowed) - Number(a.allowed)), [report, issue, doc.profiles, doc.connectors, doc.throughRule, options])
  const selected = candidates[choice]
  const setPreview = useConnectorEditStore(s => s.setPreview)
  useEffect(() => {
    if (!report || !selected || viewMode || held) return
    setPreview({ type: report.type, ...selected.seat, legs: selected.legs, allowed: selected.allowed, conflicts: selected.allowed ? [] : placementObstacles({ id: issue?.connectorId ?? '__report__', type: report.type, ...selected.seat }, doc).map(o => o.id) })
    return () => setPreview(null)
  }, [report, selected, viewMode, held, setPreview, issue, doc.profiles, doc.connectors, doc.panels, doc.equipment, doc.fittings, doc.throughRule])
  if (!report) return null
  const reason = (r?: ConnectorPlacementReason) => r === 'equipment' ? t.connectorReasonEquipment : r === 'collision' ? t.connectorReasonCollision
    : r === 'occupied' ? t.connectorOccupied : r === 'unverified' ? t.connectorReasonUnverified : t.connectorNoSeat
  const locate = (index: number) => {
    const item = report.issues[index], tools = useToolStore.getState()
    tools.putDown()
    tools.cancelDraw()
    doc.selectItems(item.connectorId ? [item.connectorId, ...item.hosts] : item.hosts)
    useInspectionStore.getState().focusAt(item.position)
    setActive(index); setChoice(-1)
  }
  const apply = () => {
    if (!selected || !issue || viewMode) return
    const store = useStore.getState()
    const existing = issue.connectorId ? store.connectors.find(c => c.id === issue.connectorId) : null
    if (issue.connectorId && (!existing || existing.locked)) return
    const part = { id: existing?.id ?? nextId('c'), type: report.type, ...selected.seat }
    if (!validateConnectorPlacement(part, store.profiles, store.connectors, { ...options, panels: store.panels, equipment: store.equipment, fittings: store.fittings }).allowed) return
    reportEditResult(existing ? store.commitTransform({ connectors: [{ id: existing.id, updates: { ...part, supportBinding: undefined, panelMount: undefined } }] })
      : store.commitDocument({ connectors: [...store.connectors, part] }))
  }
  return <section data-testid="auto-connect-report" className="mt-2 rounded-lg bg-slate-950 p-2 space-y-2 text-[11px]">
    <div className="flex justify-between"><span>{zh ? '自动连接结果' : 'Auto-connect results'} · {connectorLabel(report.type, language)}</span>
      <button aria-label={zh ? '关闭结果' : 'Close results'} onClick={() => useInspectionStore.getState().setReport(null)}>×</button></div>
    <p>{zh ? `新增 ${report.placed} · 已安装 ${report.skipped} · 校正 ${report.repaired} · 待处理 ${report.issues.length}` : `Added ${report.placed} · Installed ${report.skipped} · Repaired ${report.repaired} · Issues ${report.issues.length}`}</p>
    <div className="max-h-48 overflow-auto space-y-1">
      {report.issues.map((item, index) => <button key={index} data-testid="connection-issue" aria-pressed={index === active} onClick={() => locate(index)}
        className={`block w-full rounded text-left p-1.5 ${index === active ? 'bg-cyan-950' : 'bg-slate-800'}`}>
        {index + 1}. {reason(item.reason)}<span className="block text-slate-400">{item.position.map(n => n.toFixed(1)).join(' / ')} mm</span>
        <span className="block text-slate-400">{[...(item.connectorId ? [partNumber('connector', item.connectorId)] : []), ...item.hosts.map(id => partNumber('profile', id))].join(' + ')}</span>
      </button>)}
    </div>
    {issue && <div className="space-y-1">
      <p>{zh ? '安装位置候选' : 'Installation candidates'}</p>
      {!candidates.length && <p className="text-amber-400">{zh ? '此处没有适配此型号的安装位，请更换型号或调整型材。' : 'No compatible seat for this model; choose another model or adjust the profiles.'}</p>}
      <div className="max-h-36 overflow-auto">
        {candidates.map((c, i) => <button key={c.key} data-testid="report-seat" aria-pressed={choice === i} className={`block text-left w-full p-1 ${choice === i ? 'bg-cyan-950' : ''}`} onClick={() => setChoice(i)}>
          {c.seat.position.map(n => n.toFixed(1)).join(' / ')} mm · {c.allowed ? (zh ? '可安装' : 'Available') : reason(c.reason)}
        </button>)}
      </div>
      <button data-testid="report-seat-apply" disabled={!selected?.allowed || viewMode || !!doc.connectors.find(c => c.id === issue.connectorId)?.locked} onClick={apply}
        className="bg-emerald-700 rounded px-2 py-1 disabled:opacity-40">{zh ? '应用此安装位' : 'Apply seat'}</button>
    </div>}
  </section>
}
