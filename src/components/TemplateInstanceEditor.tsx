import { useState } from 'react'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { templateById } from '../utils/templates'
import { updateTemplateInstance, templateEditMessage } from '../utils/templateInstances'
import { reportEditResult } from '../utils/editFeedback'
import { cancelActiveTransformGesture } from '../utils/transformGesture'
import type { TemplateInstance } from '../utils/templateMetadata'
import { partNumber } from '../utils/partNumbers'

function InstanceForm({ instance, zh }: { instance: TemplateInstance; zh: boolean }) {
  const viewMode = useToolStore(state => state.viewMode)
  const template = templateById(instance.templateId)
  const [values, setValues] = useState(instance.parameters)
  const [error, setError] = useState('')
  if (!template) return null
  return <form className="p-3 border-b border-white/10 space-y-2" data-testid="template-instance-editor" onSubmit={event => {
    event.preventDefault()
    if (viewMode) return
    cancelActiveTransformGesture()
    const result = updateTemplateInstance(instance.id, values)
    if (result.status === 'blocked') {
      const doc = useStore.getState()
      const numbers = result.partIds.map(id => {
        const kind = doc.connectors.some(c => c.id === id) ? 'connector' : doc.panels.some(p => p.id === id) ? 'panel'
          : doc.fittings.some(f => f.id === id) ? 'fitting' : 'profile'
        return partNumber(kind, id)
      })
      setError(`${templateEditMessage(result, zh)}${numbers.length ? ` (${numbers.join(', ')})` : ''}`)
      return
    }
    if (!reportEditResult(result)) return
    setError('')
  }}>
    <h3 className="text-xs font-semibold">{zh ? `${template.labelZh}参数` : `${template.labelEn} parameters`}</h3>
    <p className="text-[11px] text-slate-400">{zh ? '整组移动或旋转后仍可改尺寸，关联板材、支撑和固定件随之更新。单根成员改动、锁定、数量变化或安装失效会阻止应用。' : 'Resize after moving or rotating the whole frame; bound boards, supports and fasteners follow. Changed or locked members, topology changes and invalid mounting prevent application.'}</p>
    <div className="grid grid-cols-2 gap-2">{template.params.map(param => <label className="text-xs" key={param.key}>
      {zh ? param.labelZh : param.labelEn}
      <input type="number" disabled={viewMode} readOnly={template.id === 'shelving' && param.key === 'shelves'} aria-describedby={template.id === 'shelving' && param.key === 'shelves' ? 'instance-shelves-help' : undefined} required min={param.min} max={param.max} step={['shelves', 'u'].includes(param.key) ? 1 : 'any'}
        data-testid={`instance-param-${param.key}`} value={Number.isFinite(values[param.key]) ? values[param.key] : ''}
        onChange={event => setValues(previous => ({ ...previous, [param.key]: event.target.valueAsNumber }))}
        className="w-full mt-1 rounded bg-slate-800 px-2 py-1" />
    </label>)}</div>
    {template.id === 'shelving' && <p id="instance-shelves-help" className="text-[11px] text-slate-400">{zh ? '层数为只读；更改层数需要新建置物架实例。' : 'Shelf count is read-only. Create a new shelving instance to change it.'}</p>}
    {error && <p role="alert" className="text-xs text-amber-300">{error}</p>}
    <button type="submit" disabled={viewMode} data-testid="template-instance-apply" className="w-full rounded bg-blue-600 py-1.5 text-xs disabled:opacity-40">{zh ? '应用参数' : 'Apply parameters'}</button>
  </form>
}

export function TemplateInstanceEditor() {
  const instances = useStore(state => state.templateInstances)
  const selectedIds = useStore(state => state.selectedIds)
  const zh = useToolStore(state => state.language === 'zh')
  const selected = instances.filter(instance => instance.profileIds.some(id => selectedIds.includes(id)))
  if (selected.length !== 1) return null
  const instance = selected[0]
  return <InstanceForm key={`${instance.id}:${JSON.stringify(instance.parameters)}`} instance={instance} zh={zh} />
}
