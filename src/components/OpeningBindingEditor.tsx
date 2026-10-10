import { useSettledDocument } from '../store/useSettledDocument'
import { useEffect, useMemo, useState } from 'react'
import { useStore, type FittingData, type PanelData, type ProfileData, type ConnectorData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { openingFaceOptions, panelOpeningOrientation, resolveOpening,
  type OpeningRef, type OpeningRole, type PanelOpeningBinding } from '../utils/openingBindings'
import { translations } from '../utils/translations'

const roles: OpeningRole[] = ['left', 'right', 'bottom', 'top', 'front', 'back']
const faceKey = (ref?: OpeningRef['left']) => ref ? `${ref.profileId}:${ref.axis}:${ref.side}` : ''
const sourceIds = (opening: OpeningRef) => [...new Set(roles.flatMap((role) => opening[role] ? [opening[role]!.profileId] : []))]
const fieldClass = 'min-w-0 w-full rounded bg-slate-950 border border-white/10 px-2 py-1 text-xs disabled:opacity-40'

/** Attach a single existing part to faces explicitly chosen from the selection. */
export default function OpeningBindingEditor({ part, kind }: { part: FittingData | PanelData; kind: 'fitting' | 'panel' }) {
  const { profiles, selectedIds, throughRule, selectItems } = useSettledDocument()
  const language = useToolStore(s => s.language)
  const viewMode = useToolStore(s => s.viewMode)
  const showToast = useToolStore(s => s.showToast)
  const t = translations[language]
  const binding = part.openingBinding
  const [enabled, setEnabled] = useState(!!binding)
  const [faces, setFaces] = useState<Partial<Record<OpeningRole, string>>>({})
  const [fixedBack, setFixedBack] = useState(true)
  const [depth, setDepth] = useState('500')
  const [mode, setMode] = useState<PanelOpeningBinding['mode']>('front')
  const [bottomOffset, setBottomOffset] = useState('0')
  const [start, setStart] = useState('0')
  const [end, setEnd] = useState('1')
  const [margins, setMargins] = useState({ left: '0', right: '0', bottom: '0', top: '0' })
  const [normalOffset, setNormalOffset] = useState('0')
  useEffect(() => {
    setEnabled(!!binding)
    setFaces(Object.fromEntries(roles.map((role) => [role, faceKey(binding?.opening[role])])))
    setFixedBack(!binding?.opening.back)
    setDepth(String(binding?.opening.fixedDepth ?? ('depth' in part ? part.depth : 500)))
    if (kind === 'fitting') {
      const b = (part as FittingData).openingBinding
      setBottomOffset(String(b?.mode === 'drawer' ? b.bottomOffset : 0))
      setStart(String(b?.mode === 'door' ? b.start : 0))
      setEnd(String(b?.mode === 'door' ? b.end : 1))
    } else {
      const b = (part as PanelData).openingBinding
      setMode(b?.mode ?? 'front')
      setNormalOffset(String(b?.normalOffset ?? 0))
      setMargins({ left: String(b?.margins.left ?? 0), right: String(b?.margins.right ?? 0),
        bottom: String(b?.margins.bottom ?? 0), top: String(b?.margins.top ?? 0) })
    }
  // Geometry updates do not discard a draft face selection.
  }, [part.id, binding, kind])
  const orientation = useMemo(() => kind === 'panel' ? panelOpeningOrientation(part.quaternion, mode) : part.quaternion,
    [kind, part.quaternion, mode])
  const sources = useMemo(() => [...new Set([...selectedIds, ...(binding ? sourceIds(binding.opening) : [])])],
    [selectedIds, binding])
  const options = useMemo(() => openingFaceOptions(profiles, sources, orientation, throughRule),
    [profiles, sources, orientation, throughRule])
  const candidate = useMemo(() => {
    const result: Partial<OpeningRef> = {}
    for (const role of roles) {
      if (role === 'back' && fixedBack) continue
      const key = faces[role]
      const chosen = options[role].find((option) => option.key === key)
      if (!chosen) return null
      result[role] = chosen.ref
    }
    if (fixedBack) {
      if (!depth.trim() || !Number.isFinite(Number(depth)) || Number(depth) <= 0) return null
      result.fixedDepth = Number(depth)
    }
    return result as OpeningRef
  }, [faces, options, fixedBack, depth])
  const preview = useMemo(() => candidate ? resolveOpening(candidate, profiles, throughRule) : null,
    [candidate, profiles, throughRule])
  const current = useMemo(() => binding ? resolveOpening(binding.opening, profiles, throughRule) : null,
    [binding, profiles, throughRule])
  const labels = { left: t.bindingLeft, right: t.bindingRight, bottom: t.bindingBottom,
    top: t.bindingTop, front: t.bindingFront, back: t.bindingBack }
  const disabled = viewMode || !!part.locked
  const apply = (opening?: OpeningRef) => {
    const s = useStore.getState()
    const result = kind === 'fitting'
      ? s.commitTransform({ fittings: [{ id: part.id, updates: { openingBinding: opening
        ? (part as FittingData).kind === 'door'
          ? { opening, mode: 'door', start: Number(start), end: Number(end) }
          : { opening, mode: 'drawer', bottomOffset: Number(bottomOffset) }
        : undefined } }] })
      : s.commitTransform({ panels: [{ id: part.id, updates: { openingBinding: opening ? {
        opening, mode, normalOffset: Number(normalOffset), margins: {
          left: Number(margins.left), right: Number(margins.right), bottom: Number(margins.bottom), top: Number(margins.top),
        },
      } : undefined } }] })
    if (result.status === 'rejected') {
      setEnabled(!!binding)
      showToast(t.bindingEditRejected, 'error')
    }
  }
  const numeric = (label: string, value: string, set: (v: string) => void, step = 1) => (
    <label className="flex items-center gap-2 text-[10px] text-slate-400">
      <span className="w-24 shrink-0">{label}</span>
      <input type="number" aria-label={label} className={fieldClass} value={value} step={step} onChange={(e) => set(e.target.value)} />
    </label>
  )
  const validNumbers = kind === 'panel'
    ? [normalOffset, ...Object.values(margins)].every((v) => v.trim() && Number.isFinite(Number(v)))
    : (part as FittingData).kind === 'drawer'
      ? bottomOffset.trim() && Number.isFinite(Number(bottomOffset)) && Number(bottomOffset) >= 0
      : start.trim() && end.trim() && Number(start) >= 0 && Number(start) < Number(end) && Number(end) <= 1
  return (
    <div className="space-y-2 border-t border-white/5 pt-2" data-testid={`opening-binding-${part.id}`}>
      <label className="flex items-center gap-2 text-xs text-slate-300">
        <input type="checkbox" data-testid="binding-enabled" checked={enabled} disabled={disabled}
          onChange={(e) => { setEnabled(e.target.checked); if (!e.target.checked && binding) apply() }} />
        {t.bindingFollow}
      </label>
      {binding && (
        <>
          <p className={current?.status === 'resolved' ? 'text-[10px] text-emerald-400' : 'text-[10px] text-amber-300'} data-testid="binding-status">
            {current?.status === 'resolved' ? t.bindingConnected : current?.status === 'missing-source' ? t.bindingMissing : t.bindingInvalid}
          </p>
          <p className="break-all text-[9px] text-slate-500">{sourceIds(binding.opening).join(', ')}</p>
          <div className="flex gap-2 text-[10px]">
            <button type="button" data-testid="binding-select-sources" className="text-sky-400"
              onClick={() => selectItems([part.id, ...sourceIds(binding.opening).filter((id) => profiles.some((p) => p.id === id))])}>{t.bindingSelectSources}</button>
            <button type="button" data-testid="binding-detach" className="text-slate-400" disabled={disabled}
              onClick={() => apply()}>{t.bindingDetach}</button>
          </div>
        </>
      )}
      {enabled && (
        <fieldset disabled={disabled} className="space-y-2">
          <p className="text-[10px] text-slate-500">{t.bindingChooseHint}</p>
          {kind === 'panel' && (
            <label className="flex gap-2 text-[10px] text-slate-400 items-center">
              <span className="w-24 shrink-0">{t.bindingPanelFace}</span>
              <select aria-label={t.bindingPanelFace} value={mode} className={fieldClass}
                onChange={(e) => { setMode(e.target.value as PanelOpeningBinding['mode']); setFaces({}) }}>
                {roles.map((role) => <option key={role} value={role}>{labels[role]}</option>)}
              </select>
            </label>
          )}
          {roles.filter((role) => role !== 'back' || !fixedBack).map((role) => (
            <label key={role} className="flex gap-2 text-[10px] text-slate-400 items-center">
              <span className="w-24 shrink-0">{labels[role]}</span>
              <select data-testid={`binding-face-${role}`} aria-label={labels[role]} value={faces[role] ?? ''} className={fieldClass}
                onChange={(e) => setFaces((prev) => ({ ...prev, [role]: e.target.value }))}>
                <option value="">{t.bindingChoose}</option>
                {options[role].map((option) => <option key={option.key} value={option.key}>
                  {option.ref.profileId} · {['X', 'Y', 'Z'][option.ref.axis]}{option.ref.side > 0 ? '+' : '−'} · {Math.round(option.coordinate * 10) / 10}
                </option>)}
              </select>
            </label>
          ))}
          <label className="flex gap-2 text-[10px] text-slate-400">
            <input type="checkbox" data-testid="binding-fixed-depth" checked={fixedBack} onChange={(e) => setFixedBack(e.target.checked)} />{t.bindingFixedDepth}
          </label>
          {fixedBack && numeric(t.depthMm, depth, setDepth)}
          {kind === 'fitting' && ((part as FittingData).kind === 'drawer'
            ? numeric(t.bindingBottomOffset, bottomOffset, setBottomOffset)
            : <>{numeric(t.bindingStart, start, setStart, 0.1)}{numeric(t.bindingEnd, end, setEnd, 0.1)}</>)}
          {kind === 'panel' && <>
            {(['left', 'right', 'bottom', 'top'] as const).map((side) => <div key={side}>
              {numeric(t.bindingMargin(labels[side]), margins[side], (v) => setMargins((prev) => ({ ...prev, [side]: v })))}
            </div>)}
            {numeric(t.bindingNormalOffset, normalOffset, setNormalOffset)}
          </>}
          <p className="text-[10px] text-slate-400" data-testid="binding-preview">{preview?.status === 'resolved'
            ? `${Math.round(preview.opening.width * 10) / 10} × ${Math.round(preview.opening.height * 10) / 10} × ${Math.round(preview.opening.depth * 10) / 10} mm`
            : t.bindingIncomplete}</p>
          <button type="button" data-testid="binding-apply" disabled={!candidate || preview?.status !== 'resolved' || !validNumbers}
            onClick={() => { if (candidate) apply(candidate) }}
            className="w-full rounded bg-sky-700 py-1.5 text-xs text-white disabled:opacity-40">{t.bindingApply}</button>
        </fieldset>
      )}
    </div>
  )
}

/** Status and detach controls for generated rails and their brackets. */
export function SupportBindingEditor({ part }: { part: ProfileData | ConnectorData }) {
  const { profiles, fittings, throughRule, selectItems } = useSettledDocument()
  const language = useToolStore(s => s.language)
  const viewMode = useToolStore(s => s.viewMode)
  const showToast = useToolStore(s => s.showToast)
  const t = translations[language]
  const rail = 'length' in part ? part : profiles.find((p) => p.id === part.supportBinding?.profileId)
  const ref = 'length' in part ? part.runnerBinding?.fittingId : part.supportBinding?.profileId
  if (!ref) return null
  const fitting = rail?.runnerBinding ? fittings.find((f) => f.id === rail.runnerBinding!.fittingId) : undefined
  const opening = fitting?.openingBinding ? resolveOpening(fitting.openingBinding.opening, profiles, throughRule) : undefined
  const present = 'length' in part ? !!fitting : !!rail
  const connected = present && (!rail?.runnerBinding || !!fitting) && (!opening || opening.status === 'resolved')
  return <div className="space-y-1 border-t border-white/5 pt-2" data-testid="support-binding">
    <p className={`text-[10px] ${connected ? 'text-emerald-400' : 'text-amber-300'}`}>
      {connected ? t.bindingSupportConnected : t.bindingMissing}
    </p>
    <p className="break-all text-[9px] text-slate-500">{ref}</p>
    <div className="flex gap-2 text-[10px]">
      <button type="button" className="text-sky-400" disabled={!present} onClick={() => selectItems([ref])}>{t.bindingSelectSource}</button>
      <button type="button" className="text-slate-400" disabled={viewMode || part.locked}
        data-testid="binding-detach" onClick={() => {
          const result = useStore.getState().commitTransform('length' in part
            ? { profiles: [{ id: part.id, updates: { runnerBinding: undefined } }] }
            : { connectors: [{ id: part.id, updates: { supportBinding: undefined } }] })
          if (result.status === 'rejected') showToast(t.bindingEditRejected, 'error')
        }}>{t.bindingDetach}</button>
    </div>
  </div>
}
