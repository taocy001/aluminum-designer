import { useState } from 'react'
import type { FittingData } from '../store/useStore'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { ACCURIDE_3832E } from '../utils/drawerRunnerCatalog'
import { drawerLayout } from '../utils/drawerLayout'
import { updateDrawerConfig, type DrawerConfigPatch } from '../utils/fittingOps'
import { validFitting } from '../utils/fittingValidation'
import { transformGestureActive } from '../utils/transformGesture'

export default function DrawerRunnerEditor({ fitting, ids, zh }: { fitting: FittingData; ids: string[]; zh: boolean }) {
  const [error, setError] = useState(false)
  const layout = drawerLayout(fitting)
  const catalog = layout.config.runnerModel === ACCURIDE_3832E.id
  const apply = (patch: DrawerConfigPatch) => {
    if (useToolStore.getState().viewMode || transformGestureActive()) return
    const current = useStore.getState().fittings.filter(f => ids.includes(f.id) && f.kind === 'drawer')
    if (!current.length || current.some(f => f.locked)) return
    if (!current.every(f => validFitting({ ...f, drawer: { ...f.drawer, ...patch } }))) { setError(true); return }
    setError(false)
    updateDrawerConfig(ids, patch)
  }
  return <div className="space-y-2 text-xs" data-testid="drawer-runner-editor">
    <label className="flex justify-between items-center gap-2 text-slate-400">
      {zh ? '滑轨规格' : 'Runner specification'}
      <select aria-label={zh ? '滑轨规格' : 'Runner specification'} data-testid="drawer-runner-model"
        value={layout.config.runnerModel} className="min-w-0 rounded bg-slate-900 px-2 py-1"
        onChange={e => {
          if (e.target.value === 'custom') apply({ runnerModel: 'custom', runnerLength: layout.runnerLength, runnerTravel: Math.min(layout.travel, layout.runnerLength) })
          else {
            const targets = useStore.getState().fittings.filter(f => ids.includes(f.id) && f.kind === 'drawer')
            const candidate = [...ACCURIDE_3832E.variants].reverse().find(v => targets.length > 0 && targets.every(f => validFitting({ ...f,
              drawer: { ...f.drawer, runnerModel: ACCURIDE_3832E.id, runnerLength: v.length, runnerTravel: undefined, sideClearance: 13 } })))
            if (!candidate) { setError(true); return }
            apply({ runnerModel: ACCURIDE_3832E.id, runnerLength: candidate.length, runnerTravel: undefined, sideClearance: 13 })
          }
        }}>
        <option value="custom">{zh ? '自定义' : 'Custom'}</option>
        <option value={ACCURIDE_3832E.id}>{ACCURIDE_3832E.label}</option>
      </select>
    </label>
    {catalog && <>
      <label className="flex justify-between items-center gap-2 text-slate-400">
        {zh ? '标准长度' : 'Standard length'}
        <select aria-label={zh ? '标准长度' : 'Standard length'} data-testid="drawer-runner-length" value={layout.runnerLength}
          className="min-w-0 max-w-[65%] rounded bg-slate-900 px-2 py-1" onChange={e => apply({ runnerLength: Number(e.target.value), runnerTravel: undefined })}>
          {ACCURIDE_3832E.variants.map(v => <option key={v.sku} value={v.length}>{v.length} mm · {v.sku}</option>)}
        </select>
      </label>
      <p className="text-slate-400" data-testid="drawer-runner-travel">{zh ? '行程' : 'Travel'} {layout.travel} mm · {zh ? '单侧间隙' : 'Side gap'} 12.7–13.5 mm</p>
      <p className="text-slate-500">{zh ? '支持 300–700 mm，按 3832E R10-0616 校核尺寸。无滑轨实体及孔位；型材固定方式需确认。' : '300–700 mm sizes checked against 3832E R10-0616. No rail solids or fixing holes; confirm frame attachments separately.'}</p>
    </>}
    {error && <p role="alert" className="text-amber-300">{zh ? '未应用：请检查所有选中抽屉的深度、侧隙与轨道高度。' : 'Not applied: check depth, side gap and rail height in every selected drawer.'}</p>}
  </div>
}
