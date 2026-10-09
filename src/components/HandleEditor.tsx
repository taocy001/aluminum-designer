import { useEffect, useState } from 'react'
import type { FittingData, HandleConfig } from '../store/useStore'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { handleDraft, handleFitsFront } from '../utils/fittingHandle'
import { transformGestureActive } from '../utils/transformGesture'
import { reportEditResult } from '../utils/editFeedback'

export default function HandleEditor({ fitting, zh }: { fitting: FittingData; zh: boolean }) {
  const [draft, setDraft] = useState(() => handleDraft(fitting))
  const [error, setError] = useState(false)
  const viewMode = useToolStore(s => s.viewMode)
  const source = JSON.stringify(handleDraft(fitting))
  useEffect(() => { setDraft(JSON.parse(source)); setError(false) }, [fitting.id, source])
  const apply = (handle: HandleConfig | undefined) => {
    if (transformGestureActive() || useToolStore.getState().viewMode) return
    const current = useStore.getState().fittings.find(f => f.id === fitting.id)
    if (!current || current.locked) return
    if (!handleFitsFront({ ...current, handle })) { setError(true); return }
    const result = useStore.getState().updateFitting(fitting.id, { handle })
    reportEditResult(result)
    setError(result.status === 'rejected')
  }
  const fields: [keyof HandleConfig, string][] = [
    ['pitch', zh ? '孔距' : 'Hole pitch'], ['projection', zh ? '突出量' : 'Projection'],
    ['thickness', zh ? '截面宽厚' : 'Square section'], ['holeDiameter', zh ? '通孔直径' : 'Bore diameter'],
    ['x', zh ? '中心 X' : 'Centre X'], ['y', zh ? '中心 Y' : 'Centre Y'],
  ]
  return <details className="border-t border-white/5 pt-2 text-xs" data-testid="handle-editor">
    <summary className="cursor-pointer text-slate-300">{zh ? '拉手尺寸与开孔' : 'Pull dimensions and holes'}</summary>
    <p className="mt-2 text-slate-400">{zh ? '按实物图纸填写毫米尺寸。中心从门板或抽面中心计量，突出量从外表面计量；模型使用方形截面包络。' : 'Enter measured dimensions in mm. Centre offsets use the finished front centre; projection starts at its outer face. The model uses a square-section envelope.'}</p>
    <fieldset disabled={viewMode || fitting.locked} className="mt-2 space-y-2 disabled:opacity-50">
      <div className="grid grid-cols-2 gap-2">{fields.map(([key, label]) => <label key={key}>{label}
        <input type="number" step="0.5" aria-label={label} data-testid={`handle-${key}`} value={Number.isFinite(draft[key]) ? draft[key] : ''}
          onChange={e => setDraft({ ...draft, [key]: e.currentTarget.valueAsNumber })} className="mt-1 w-full rounded bg-slate-800 p-1.5" />
      </label>)}</div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => apply(draft)} data-testid="handle-apply" className="rounded bg-slate-700 px-3 py-2 hover:bg-slate-600">{zh ? '应用尺寸' : 'Apply dimensions'}</button>
        {fitting.handle && <button type="button" onClick={() => apply(undefined)} data-testid="handle-clear" className="rounded px-3 py-2 hover:bg-slate-700">{zh ? '恢复示意' : 'Use illustration'}</button>}
      </div>
    </fieldset>
    {error && <p role="alert" className="mt-2 text-amber-300">{zh ? '未应用。请检查尺寸、板边与封边间距及干涉提示。' : 'Not applied. Check dimensions, edge-band clearance and collision feedback.'}</p>}
    <p className="mt-2 text-slate-400">{fitting.handle
      ? zh ? '已生成两个通孔，并计入孔表、图纸、STEP 和物料表。螺钉长度及螺纹须按所选拉手确认。' : 'Two through-holes are included in the hole table, drawings, STEP and BOM. Select screws for the actual pull thread and board thickness.'
      : zh ? '当前为示意拉手；应用尺寸后才生成开孔、清单和碰撞包络。' : 'Illustration only until dimensions are applied; no holes, BOM entry or collision envelope yet.'}</p>
  </details>
}
