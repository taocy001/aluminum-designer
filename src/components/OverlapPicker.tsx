import * as THREE from 'three'
import { connectorSeatsAt } from '../utils/bracketSeat'
import { sameConnectorInstallation } from '../utils/connectorPlacement'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Box, Columns3, PanelTop, Package } from 'lucide-react'
import { useInspectionStore } from '../store/useInspectionStore'
import { useToolStore } from '../store/useToolStore'
import { useStore } from '../store/useStore'
import { connectorLabel } from '../utils/connectorCatalog'
import { partNumber } from '../utils/partNumbers'
import { slideSupports } from '../utils/connectorSlide'
import ConnectorThumbnail from './ConnectorThumbnail'

export default function OverlapPicker() {
  const overlap = useInspectionStore(s => s.overlap)
  const close = () => useInspectionStore.getState().setOverlap(null)
  const doc = useStore()
  const language = useToolStore(s => s.language), zh = language === 'zh'
  const [filter, setFilter] = useState('all'), [place, setPlace] = useState({ x: 0, y: 0 })
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!overlap || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    setPlace({ x: Math.max(8, Math.min(overlap.x, innerWidth - r.width - 8)), y: Math.max(8, Math.min(overlap.y, innerHeight - r.height - 8)) })
    setFilter('all')
    ref.current.focus()
  }, [overlap])
  useEffect(() => {
    if (!overlap) return
    const outside = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close() }
    window.addEventListener('pointerdown', outside, true)
    return () => {
      window.removeEventListener('pointerdown', outside, true)
      useToolStore.getState().setHoverPart(null)
      useToolStore.getState().setHoverProfile(null)
    }
  }, [overlap])
  if (!overlap) return null
  const names = zh ? { all: '全部', profile: '型材', connector: '连接件', panel: '板材', fitting: '门与抽屉', equipment: '设备' }
    : { all: 'All', profile: 'Profiles', connector: 'Connectors', panel: 'Panels', fitting: 'Fittings', equipment: 'Equipment' }
  const hover = (id: string, kind: string) => {
    useToolStore.getState().setHoverEnd(null)
    useToolStore.getState().setHoverPart(id)
    useToolStore.getState().setHoverProfile(kind === 'profile' ? id : null)
  }
  return <div ref={ref} tabIndex={-1} role="dialog" aria-label={zh ? '重叠零件' : 'Overlapping parts'} data-testid="overlap-picker"
    style={{ left: place.x, top: place.y, maxHeight: 'min(420px, 80vh)' }}
    className="fixed z-50 w-72 max-w-[90vw] overflow-auto rounded-xl border border-white/20 bg-slate-900 p-2 shadow-xl text-xs text-slate-200"
    onKeyDown={e => {
      e.stopPropagation()
      if (e.key === 'Escape') { e.preventDefault(); close() }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !(e.target instanceof HTMLSelectElement)) {
        e.preventDefault()
        const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>('[data-overlap-id]')]
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
        buttons[i < 0 ? (e.key === 'ArrowDown' ? 0 : buttons.length - 1) : (i + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus()
      }
    }}>
    <div className="flex items-center justify-between mb-2"><span>{zh ? '选择重叠零件' : 'Choose overlapping part'}</span><button onClick={close} aria-label={zh ? '关闭' : 'Close'}>×</button></div>
    <select aria-label={zh ? '零件类型' : 'Part type'} value={filter} onChange={e => setFilter(e.target.value)} className="bg-slate-950 rounded mb-2 w-full p-1">
      {Object.entries(names).map(([k, n]) => <option key={k} value={k}>{n}</option>)}
    </select>
    {overlap.picks.filter(p => filter === 'all' || p.kind === filter).map(p => {
      const c = p.kind === 'connector' ? doc.connectors.find(c => c.id === p.id) : undefined
      const profile = p.kind === 'profile' ? doc.profiles.find(c => c.id === p.id) : undefined
      const hosts = c ? c.panelMount ? [c.panelMount.profileId] : c.supportBinding ? [c.supportBinding.profileId] : slideSupports(c, doc) ?? connectorSeatsAt(c.type, new THREE.Vector3(...c.position), doc.profiles).find(seat => sameConnectorInstallation(c, { id: 'candidate', type: c.type, ...seat }))?.legs ?? [] : []
      const label = c ? connectorLabel(c.type, language) : profile ? profile.spec : names[p.kind]
      const Icon = p.kind === 'profile' ? Columns3 : p.kind === 'panel' ? PanelTop : p.kind === 'equipment' ? Package : Box
      return <button key={p.id} data-overlap-id={p.id} onMouseEnter={() => hover(p.id, p.kind)} onFocus={() => hover(p.id, p.kind)}
        onClick={e => { useStore.getState().selectItem(p.id, e.shiftKey); close() }} className="w-full flex gap-2 items-center text-left rounded p-2 hover:bg-slate-700 focus:bg-slate-700 focus:outline-cyan-500">
        {c ? <ConnectorThumbnail type={c.type} series={c.series} /> : <Icon size={24} />}
        <span className="min-w-0 break-all">{label}<small className="block text-slate-400">{p.kind === 'equipment' ? p.id : partNumber(p.kind, p.id)}</small>
          {!!hosts.length && <small className="block text-slate-400">{hosts.map(id => partNumber('profile', id)).join(' + ')}</small>}</span>
      </button>
    })}
    {!overlap.picks.some(p => filter === 'all' || p.kind === filter) && <p>{zh ? '此位置没有该类型零件' : 'No parts of this type here'}</p>}
    <p className="text-[10px] text-slate-400 mt-2">{zh ? '悬停预览 · ↑↓ 选择 · Enter 确认 · Shift 加选' : 'Hover to preview · ↑↓ choose · Enter confirm · Shift toggle'}</p>
  </div>
}
