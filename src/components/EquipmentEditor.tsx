import { useEffect, useState } from 'react'
import { useStore, type EquipmentData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { createEquipment } from '../utils/equipmentOps'
import { reportEditResult } from '../utils/editFeedback'
import { translations } from '../utils/translations'

const dimensions = ['width', 'height', 'depth'] as const
const sides = ['left', 'right', 'bottom', 'top', 'back', 'front'] as const
const fieldStyle = 'w-full min-w-0 rounded bg-slate-950 border border-white/10 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-blue-500 disabled:opacity-40'
type Values = Record<typeof dimensions[number] | typeof sides[number] | 'x' | 'y' | 'z', string>
const valuesOf = (part?: EquipmentData): Values => ({
  width: String(part?.width ?? 600), height: String(part?.height ?? 600), depth: String(part?.depth ?? 600),
  ...Object.fromEntries(sides.map((side) => [side, String(part?.clearance[side] ?? 0)])),
  x: String(part?.position[0] ?? 0), y: String(part?.position[1] ?? 0), z: String(part?.position[2] ?? 0),
}) as Values

function EquipmentForm({ part }: { part?: EquipmentData }) {
  const language = useToolStore((s) => s.language)
  const viewMode = useToolStore((s) => s.viewMode)
  const t = translations[language]
  const [name, setName] = useState(part?.name ?? '')
  const [values, setValues] = useState(() => valuesOf(part))
  useEffect(() => { setName(part?.name ?? ''); setValues(valuesOf(part)) }, [part])
  const numbers = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim() ? Number(value) : NaN])) as Record<keyof Values, number>
  const valid = !!name.trim() && dimensions.every((key) => Number.isFinite(numbers[key]) && numbers[key] > 0)
    && sides.every((key) => Number.isFinite(numbers[key]) && numbers[key] >= 0)
    && (!part || ['x', 'y', 'z'].every((key) => Number.isFinite(numbers[key as keyof Values])))
  const disabled = viewMode || !!part?.locked
  const labels = {
    width: t.widthMm, height: t.heightMm, depth: t.depthMm,
    left: t.equipmentLeft, right: t.equipmentRight, bottom: t.equipmentBottom,
    top: t.equipmentTop, back: t.equipmentBack, front: t.equipmentFront,
    x: 'X', y: 'Y', z: 'Z',
  }
  const field = (key: keyof Values) => <label key={key} className="text-[10px] text-slate-400">
    {labels[key]}
    <input className={fieldStyle} type="number" step="1" min={sides.includes(key as typeof sides[number]) ? 0 : undefined}
      aria-label={`${part ? t.equipment : t.addEquipment} ${labels[key]}`}
      data-testid={`equipment-${part ? 'edit' : 'new'}-${key}`} value={values[key]}
      onChange={(e) => setValues({ ...values, [key]: e.target.value })} />
  </label>
  const apply = () => {
    if (!valid || disabled) return
    const next = { name: name.trim(), width: numbers.width, height: numbers.height, depth: numbers.depth,
      clearance: { left: numbers.left, right: numbers.right, bottom: numbers.bottom, top: numbers.top, back: numbers.back, front: numbers.front } }
    const result = part
      ? useStore.getState().updateEquipment(part.id, { ...next, position: [numbers.x, numbers.y, numbers.z] })
      : createEquipment(next)
    reportEditResult(result)
  }
  return <fieldset disabled={disabled} className="space-y-2" data-testid={part ? 'equipment-properties' : 'equipment-create'}
    onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); apply() } }}>
    <label className="text-[10px] text-slate-400 block">{t.equipmentName}
      <input className={fieldStyle} data-testid={`equipment-${part ? 'edit' : 'new'}-name`}
        aria-label={t.equipmentName} value={name} onChange={(e) => setName(e.target.value)} />
    </label>
    <div className="grid grid-cols-3 gap-1">{dimensions.map(field)}</div>
    <p className="text-[10px] text-slate-400">{t.equipmentClearance}</p>
    <div className="grid grid-cols-3 gap-1">{sides.map(field)}</div>
    <p className="text-[10px] text-slate-500 leading-relaxed">{t.equipmentHint}</p>
    {part && <><p className="text-[10px] text-slate-400">{t.position}</p><div className="grid grid-cols-3 gap-1">{(['x', 'y', 'z'] as const).map(field)}</div></>}
    <button className="w-full rounded-lg py-1.5 text-[11px] bg-cyan-700 hover:bg-cyan-600 disabled:opacity-40"
      disabled={disabled || !valid} data-testid={part ? 'equipment-apply' : 'equipment-add'} onClick={apply}>
      {part ? t.equipmentApply : t.addEquipment}
    </button>
  </fieldset>
}

export function EquipmentCreator() {
  const [open, setOpen] = useState(false)
  const t = translations[useToolStore((s) => s.language)]
  return <div className="space-y-2 border-t border-white/5 pt-2">
    <button className="w-full rounded-lg bg-cyan-900/50 py-1.5 text-[11px] text-cyan-200"
      data-testid="equipment-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{t.equipment}</button>
    {open && <EquipmentForm />}
  </div>
}

export default function EquipmentEditor({ part }: { part: EquipmentData }) {
  return <EquipmentForm part={part} />
}
