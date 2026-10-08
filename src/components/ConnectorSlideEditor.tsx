import { useEffect, useMemo, useState } from 'react'
import { useStore, type ConnectorData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { useConnectorEditStore } from '../store/useConnectorEditStore'
import { connectorSlide, moveConnectorAlongSlot } from '../utils/connectorSlide'

export default function ConnectorSlideEditor({ connector }: { connector: ConnectorData }) {
  const doc = useStore()
  const language = useToolStore(s => s.language), held = useToolStore(s => s.held), viewMode = useToolStore(s => s.viewMode)
  const zh = language === 'zh'
  const [step, setStep] = useState(1), [draft, setDraft] = useState('0')
  const amount = draft.trim() ? Number(draft) : NaN
  const result = useMemo(() => connectorSlide(connector, amount, doc), [connector, amount, doc.profiles, doc.connectors, doc.panels, doc.fittings, doc.equipment, doc.throughRule])
  const setPreview = useConnectorEditStore(s => s.setPreview)
  useEffect(() => { setDraft('0') }, [connector])
  useEffect(() => {
    if (!amount || !Number.isFinite(amount) || result.reason === 'fixed' || held || viewMode || connector.locked) return
    setPreview({ ...result.part, legs: result.legs, allowed: result.allowed, conflicts: result.conflicts })
    return () => setPreview(null)
  }, [result, amount, held, viewMode, connector.locked, setPreview])
  const alternatives = useMemo(() => !result.allowed && Number.isFinite(amount) ? [...new Set([0.1, 1, 5, 10].flatMap(n => [amount - n, amount + n]))]
    .filter(n => n !== 0 && connectorSlide(connector, n, doc, false).allowed).slice(0, 4) : [], [result, amount, doc.profiles, doc.connectors, doc.panels, doc.fittings, doc.equipment, doc.throughRule, connector])
  if (result.reason === 'fixed') return <p className="text-[10px] text-slate-400">{zh ? '此安装位不能连续沿槽移动。角接件请使用“重新安装”选择孔位。' : 'This installation cannot slide along a slot. Use reseating for corner joints.'}</p>
  return <div className="space-y-2 text-xs" data-testid="connector-slide">
    <span>{zh ? '沿槽细调' : 'Slide along slot'}</span>
    <div className="flex gap-1">
      <select aria-label={zh ? '细调步长' : 'Slide step'} value={step} onChange={e => setStep(Number(e.target.value))} className="bg-slate-950 rounded">
        {[0.1, 1, 5].map(n => <option key={n} value={n}>{n} mm</option>)}
      </select>
      <button type="button" onClick={() => setDraft(String(Math.round(((Number.isFinite(amount) ? amount : 0) - step) * 1000) / 1000))}>−</button>
      <input aria-label={zh ? '沿槽距离' : 'Slot distance'} type="number" step={step} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setDraft('0') } else if (e.key === 'Enter') { e.preventDefault(); moveConnectorAlongSlot(connector.id, amount) } }} className="w-20 bg-slate-950 rounded px-2" />
      <button type="button" onClick={() => setDraft(String(Math.round(((Number.isFinite(amount) ? amount : 0) + step) * 1000) / 1000))}>+</button>
    </div>
    <p className="text-[10px] text-slate-400">{zh ? '相对当前位置（mm）；正向沿型材起点至终点。保持安装面和朝向。' : 'Relative millimetres; positive follows the host from start to end. Mounting face and orientation stay fixed.'}</p>
    {!result.allowed && <p role="status" className="text-amber-400">{zh ? (result.reason === 'invalid-distance' ? '请输入有效距离' : result.reason === 'no-joint' ? '超出原安装范围' : '此位置与其他零件干涉或已占用') : 'Outside the original mount or obstructed'}</p>}
    {!!result.conflicts?.length && <p className="text-amber-400 break-all">{zh ? '干涉零件（红框）' : 'Obstructions (red)'}: {result.conflicts.join(' · ')}</p>}
    {alternatives.map(n => <button key={n} type="button" onClick={() => setDraft(String(n))} className="mr-2 text-cyan-400">{n.toFixed(1)} mm</button>)}
    <div className="flex gap-2">
      <button data-testid="connector-slide-apply" type="button" disabled={!result.allowed || !amount || !Number.isFinite(amount)} onClick={() => moveConnectorAlongSlot(connector.id, amount)} className="bg-emerald-700 px-2 py-1 rounded disabled:opacity-40">{zh ? '应用' : 'Apply'}</button>
      <button type="button" onClick={() => setDraft('0')}>{zh ? '取消' : 'Cancel'}</button>
    </div>
  </div>
}
