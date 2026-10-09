import { useState } from 'react'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { templateById } from '../utils/templates'
import { updateTemplateInstance, templateEditMessage } from '../utils/templateInstances'
import { reportEditResult } from '../utils/editFeedback'
import { cancelActiveTransformGesture } from '../utils/transformGesture'
import type { TemplateInstance } from '../utils/templateMetadata'

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
    if (result.status === 'blocked') { setError(templateEditMessage(result, zh)); return }
    if (!reportEditResult(result)) return
    setError('')
  }}>
    <h3 className="text-xs font-semibold">{zh ? `${template.labelZh}参数` : `${template.labelEn} parameters`}</h3>
    <p className="text-[11px] text-slate-400">{zh ? '保持成员数量时可更新尺寸及关联部件。手动修改或锁定的模板成员不能重建；未关联零件和现有板材固定件也会阻止应用。' : 'Dimension updates keep the member count and update bound parts. Edited or locked members, unbound parts and existing panel fasteners prevent regeneration.'}</p>
    <div className="grid grid-cols-2 gap-2">{template.params.map(param => <label className="text-xs" key={param.key}>
      {zh ? param.labelZh : param.labelEn}
      <input type="number" disabled={viewMode} required min={param.min} max={param.max} step={['shelves', 'u'].includes(param.key) ? 1 : 'any'}
        data-testid={`instance-param-${param.key}`} value={Number.isFinite(values[param.key]) ? values[param.key] : ''}
        onChange={event => setValues(previous => ({ ...previous, [param.key]: event.target.valueAsNumber }))}
        className="w-full mt-1 rounded bg-slate-800 px-2 py-1" />
    </label>)}</div>
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
