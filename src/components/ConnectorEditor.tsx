import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { useStore, type ConnectorData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { useConnectorEditStore } from '../store/useConnectorEditStore'
import { connectorEntry, connectorLabel } from '../utils/connectorCatalog'
import { connectorInstallationKey, connectorPlacementCandidates, validateConnectorPlacement, type ConnectorPlacementReason } from '../utils/connectorPlacement'
import { reseatConnector, setConnectorAngles, setConnectorPose } from '../utils/connectorEdits'
import { orientationDegrees, setConnectorSeries } from '../utils/editOps'
import { hardwareReference } from '../utils/connectorHardware'
import { accessoryCapReference } from '../utils/connectorAccessoryReferences'
import { hardwareFastenerLabel } from '../utils/connectorFasteners'
import { partNumber } from '../utils/partNumbers'
import { translations } from '../utils/translations'
import { SupportBindingEditor } from './OpeningBindingEditor'

const AXES = ['X', 'Y', 'Z'] as const
const COLORS = ['#ef4444', '#22c55e', '#3b82f6']
const display = (value: number) => String(Math.round(value * 1000) / 1000)

function PoseField({ value, axis, name, step, onCommit }: {
  value: number; axis: number; name: string; step: number; onCommit: (value: number) => void
}) {
  const [text, setText] = useState(display(value))
  const [focused, setFocused] = useState(false)
  const cancelled = useRef(false)
  useEffect(() => { if (!focused) setText(display(value)) }, [value, focused])
  return <label className="flex items-center gap-1 bg-slate-950 border border-white/5 rounded-lg px-2 focus-within:border-blue-500">
    <span className="text-[9px] font-bold" style={{ color: COLORS[axis] }}>{AXES[axis]}</span>
    <input type="number" step={step} value={text} aria-label={`${name} ${AXES[axis]}`}
      className="w-full min-w-0 bg-transparent py-1.5 text-xs font-mono outline-none disabled:opacity-40"
      onFocus={() => { cancelled.current = false; setFocused(true) }}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        const next = text.trim() ? Number(text) : NaN
        if (!cancelled.current && Number.isFinite(next) && next !== Number(display(value))) onCommit(next)
        cancelled.current = false
        setFocused(false)
        setText(display(value))
      }}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape') {
          event.preventDefault()
          cancelled.current = true
          event.currentTarget.blur()
        } else if (event.key === 'Enter') event.currentTarget.blur()
        else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault()
          const draft = text.trim() ? Number(text) : NaN
          const next = (Number.isFinite(draft) ? draft : value) + (event.key === 'ArrowUp' ? 1 : -1) * step * (event.shiftKey ? 10 : 1)
          setText(display(next))
          onCommit(next)
        }
      }} />
  </label>
}

export default function ConnectorEditor({ connector }: { connector: ConnectorData }) {
  const { profiles, connectors, equipment, panels, fittings } = useStore()
  const { language, viewMode, held } = useToolStore()
  const t = translations[language]
  const entry = connectorEntry(connector.type)
  const series = connector.series ?? 20
  const reference = connector.type === 'end-cap' ? accessoryCapReference(connector.profileSpec ?? `${series}${series}` as '2020' | '3030' | '4040') : hardwareReference(connector.type, series)
  const disabled = viewMode || connector.locked
  const euler = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...connector.quaternion).normalize(), 'YXZ')
  const angles = [euler.x, euler.y, euler.z].map(THREE.MathUtils.radToDeg) as [number, number, number]
  const [anchor, setAnchor] = useState<ConnectorData['position'] | null>(null)
  const [pair, setPair] = useState('')
  const [key, setKey] = useState('')
  useEffect(() => { if (held) setAnchor(null) }, [held])
  const options = useMemo(() => ({ excludeConnectorId: connector.id, equipment, panels, fittings }), [connector.id, equipment, panels, fittings])
  const status = useMemo(() => validateConnectorPlacement(connector, profiles, connectors, options), [connector, profiles, connectors, options])
  const candidates = useMemo(() => anchor ? connectorPlacementCandidates(connector.type, new THREE.Vector3(...anchor),
    profiles, connectors, undefined, undefined, options) : [], [anchor, connector.type, profiles, connectors, options])
  const pairs = [...new Set(candidates.map((candidate) => [...candidate.legs].sort().join('\n')))]
  const keyedPair = candidates.find((candidate) => candidate.key === key)?.legs
  const activePair = pairs.includes(pair) ? pair : keyedPair ? [...keyedPair].sort().join('\n') : pairs[0]
  const visible = candidates.filter((candidate) => [...candidate.legs].sort().join('\n') === activePair)
  const chosen = visible.find((candidate) => candidate.key === key) ?? visible[0]
  const setPreview = useConnectorEditStore((state) => state.setPreview)
  useEffect(() => {
    setPreview(anchor && chosen && !disabled && !held ? { type: connector.type, ...chosen.seat, allowed: chosen.allowed } : null)
    return () => setPreview(null)
  }, [anchor, chosen, connector.type, disabled, held, setPreview])
  const reason = (value?: ConnectorPlacementReason) => value === 'occupied' ? t.connectorOccupied
    : value === 'unverified' ? t.connectorReasonUnverified
    : value === 'collision' ? t.connectorReasonCollision : value === 'equipment' ? t.connectorReasonEquipment : t.connectorNoSeat
  const openSeats = () => {
    setAnchor([...connector.position])
    setPair('')
    setKey(connectorInstallationKey(connector))
  }
  return <fieldset disabled={disabled} className="space-y-3" data-testid="connector-editor">
    <SupportBindingEditor part={connector} />
    <div className="flex justify-between items-center text-xs">
      <span className="text-slate-500">{t.connectorProps}</span>
      <span className="text-emerald-400 font-mono">{connectorLabel(connector.type, language)}</span>
    </div>
    <div className="flex justify-between items-center text-xs">
      <span className="text-slate-500">{t.series}</span>
      <select value={series} data-testid="connector-series" aria-label={t.series}
        onChange={(event) => setConnectorSeries(connector.id, Number(event.target.value) as 20 | 30 | 40)}
        className="bg-slate-950 border border-white/5 rounded-lg px-2 py-1 text-xs font-mono text-emerald-400">
        {[20, 30, 40].map((value) => <option key={value} value={value}>{value}</option>)}
      </select>
    </div>
    <div className="flex justify-between items-center text-[11px]">
      <span className="text-slate-500">{t.fasteners}</span>
      <span className="font-mono text-slate-300" data-testid="connector-fasteners">
        {!reference?.verified || !reference.fasteners.length ? '—' : reference.fasteners.map((fastener) => `${fastener.count}× ${hardwareFastenerLabel(fastener, language)}`).join(' · ')}
      </span>
    </div>
    {reference && <div className="space-y-1 text-[10px] text-slate-400" data-testid="connector-reference">
      <a href={reference.sourceUrl} target="_blank" rel="noreferrer" className="text-cyan-400 underline">{reference.sku}</a>
      <p>{language === 'zh' ? reference.descriptionZh : reference.descriptionEn}</p>
      {!reference.verified && <p className="text-amber-400">{language === 'zh' ? '当前型号未核定适配安装，不提供自动安装。' : 'Installation compatibility is unverified; automatic placement is unavailable.'}</p>}
      {reference.machining?.map((item) => <p key={item}>{item}</p>)}
      {reference.limitations?.map((item) => <p key={item}>{item}</p>)}
      {connector.type === 'end-cap' && <p>{language === 'zh' ? '端盖截面' : 'Cap section'}: {connector.profileSpec ?? `${series}${series}`}</p>}
    </div>}
    <div className="space-y-1">
      <span className="text-[10px] text-slate-500">{t.position}</span>
      <div className="grid grid-cols-3 gap-1" data-testid="connector-position">
        {AXES.map((axis, index) => <PoseField key={axis} axis={index} name={t.position} value={connector.position[index]} step={5}
          onCommit={(value) => { const position = [...connector.position] as ConnectorData['position']; position[index] = value; setConnectorPose(connector.id, { position }) }} />)}
      </div>
    </div>
    <div className="space-y-1">
      <span className="text-[10px] text-slate-500">{t.orientation}</span>
      <div className="grid grid-cols-3 gap-1" data-testid="connector-orientation">
        {AXES.map((axis, index) => <PoseField key={axis} axis={index} name={t.orientation} value={angles[index]} step={15}
          onCommit={(value) => { const next = [...angles] as [number, number, number]; next[index] = value; setConnectorAngles(connector.id, next) }} />)}
      </div>
      <p className="text-[10px] text-slate-400">{t.connectorManualEditHint}</p>
    </div>
    {(entry?.fit === 'corner' || !status.allowed) && <p data-testid="connector-installation-status"
      className={`text-[10px] ${status.allowed ? 'text-emerald-400' : 'text-amber-400'}`}>
      {status.allowed ? t.bracketSeatingOk : reason(status.reason)}
    </p>}
    {entry?.fit === 'corner' && <div className="space-y-2">
      <button type="button" data-testid="connector-reseat" aria-expanded={!!anchor}
        onClick={() => anchor ? setAnchor(null) : openSeats()}
        className="w-full py-1.5 text-xs bg-slate-700/60 hover:bg-slate-700 rounded-lg">{t.connectorReseat}</button>
      {anchor && <div className="space-y-2">
        <label className="block space-y-1 text-[10px] text-slate-400">{t.connectorSeatPair}
          <select data-testid="connector-seat-pair" value={activePair ?? ''} aria-label={t.connectorSeatPair}
            onChange={(event) => { setPair(event.target.value); setKey('') }} className="w-full bg-slate-900 rounded px-2 py-1">
            {pairs.map((ids) => <option key={ids} value={ids}>{ids.split('\n').map((id) =>
              `${partNumber('profile', id)} (${profiles.find((p) => p.id === id)?.spec})`).join(' + ')}</option>)}
          </select>
        </label>
        <div className="max-h-52 overflow-y-auto space-y-1" aria-label={t.connectorSeatPosition}>
          {visible.map((candidate, index) => <button type="button" key={candidate.key} data-testid="connector-seat-option"
            data-allowed={candidate.allowed} aria-pressed={chosen?.key === candidate.key} onClick={() => setKey(candidate.key)}
            className={`w-full text-left rounded border px-2 py-1.5 text-[10px] ${chosen?.key === candidate.key ? 'border-cyan-500 bg-cyan-950/50' : 'border-white/10 bg-slate-900'}`}>
            <span className="block">{index + 1}. <span className="font-mono">{candidate.seat.position.map(display).join(' / ')} mm</span></span>
            <span className="font-mono text-slate-400">{orientationDegrees(candidate.seat.quaternion).join(' / ')}°</span>
            {!candidate.allowed && <span className="block text-amber-400">{reason(candidate.reason)}</span>}
          </button>)}
          {!visible.length && <p className="text-xs text-slate-400">{t.connectorNoSeats}</p>}
        </div>
        <button type="button" data-testid="connector-seat-apply" disabled={!chosen?.allowed}
          onClick={() => { if (chosen && reseatConnector(connector.id, chosen.key, anchor)) setAnchor(null) }}
          className="w-full py-1.5 text-xs rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40">{t.connectorSeatApply}</button>
      </div>}
    </div>}
  </fieldset>
}
