import { useStore, type ProfileData } from '../store/useStore'
import { templateById, type Template } from './templates'
import { nextId } from './profileFactory'
import type { TemplateInstance } from './templateMetadata'
import type { EditResult } from './openingBindings'

export type TemplateEditResult = EditResult | { status: 'blocked'; reason: 'template' | 'parameters' | 'topology' | 'modified' | 'unbound' | 'panel-mount'; partIds: string[] }
const blocked = (reason: Extract<TemplateEditResult, { status: 'blocked' }>['reason'], partIds: string[] = []): TemplateEditResult => ({ status: 'blocked', reason, partIds })

/** Pose, machining and section changes make regeneration unsafe; locking is checked separately. */
export const templateProfileFingerprint = (p: ProfileData) => JSON.stringify({
  spec: p.spec, length: p.length, position: p.position, quaternion: p.quaternion,
  miterCuts: p.miterCuts ?? [], holes: p.holes ?? [], fixedTrims: p.fixedTrims ?? null,
  runnerBinding: p.runnerBinding ?? null,
})
const validParameters = (template: Template, values: Record<string, number>) =>
  Object.keys(values).length === template.params.length && template.params.every(param => {
    const value = values[param.key]
    return Number.isFinite(value) && value >= param.min && value <= param.max
      && (!['shelves', 'u'].includes(param.key) || Number.isInteger(value))
  })

export function addTemplateInstance(templateId: string, parameters: Record<string, number>): TemplateEditResult {
  const template = templateById(templateId)
  if (!template) return blocked('template')
  if (!validParameters(template, parameters)) return blocked('parameters')
  const profiles = template.build(parameters)
  const instance: TemplateInstance = { id: nextId('template'), templateId, parameters: { ...parameters },
    profileIds: profiles.map(p => p.id), fingerprints: profiles.map(templateProfileFingerprint) }
  const state = useStore.getState()
  return state.commitDocument({ profiles: [...state.profiles, ...profiles],
    templateInstances: [...state.templateInstances, instance] }, instance.profileIds)
}

export function updateTemplateInstance(id: string, parameters: Record<string, number>): TemplateEditResult {
  const state = useStore.getState(), instance = state.templateInstances.find(item => item.id === id)
  const template = instance && templateById(instance.templateId)
  if (!instance || !template) return blocked('template')
  if (!validParameters(template, parameters)) return blocked('parameters')
  if (template.params.every(param => parameters[param.key] === instance.parameters[param.key])) return { status: 'noop' }
  const members = instance.profileIds.map(member => state.profiles.find(p => p.id === member))
  const modified = members.flatMap((member, i) => !member || member.locked || templateProfileFingerprint(member) !== instance.fingerprints[i]
    ? [instance.profileIds[i]] : [])
  if (modified.length) return blocked('modified', modified)
  const generated = template.build(parameters)
  if (generated.length !== instance.profileIds.length) return blocked('topology', instance.profileIds)
  // Free parts have no reliable association to any particular template. Require an explicit binding
  // before regeneration rather than guessing which nearby part should move.
  const unbound = [
    ...state.connectors.filter(c => !c.supportBinding && !c.panelMount),
    ...state.panels.filter(p => !p.openingBinding),
    ...state.fittings.filter(f => !f.openingBinding),
  ].map(p => p.id)
  if (unbound.length) return blocked('unbound', unbound)
  const mounts = state.connectors.filter(c => c.panelMount).map(c => c.id)
  if (mounts.length) return blocked('panel-mount', mounts)
  const replacements = generated.map((p, index) => ({ ...members[index]!, ...p, id: instance.profileIds[index] }))
  const byId = new Map(replacements.map(p => [p.id, p]))
  const nextInstance: TemplateInstance = { ...instance, parameters: { ...parameters }, fingerprints: replacements.map(templateProfileFingerprint) }
  // The store reconciles opening, runner and support bindings before committing one history entry.
  return state.commitDocument({ profiles: state.profiles.map(p => byId.get(p.id) ?? p),
    templateInstances: state.templateInstances.map(item => item.id === id ? nextInstance : item) })
}

export function templateEditMessage(result: Extract<TemplateEditResult, { status: 'blocked' }>, zh: boolean): string {
  const messages = {
    template: ['此工程没有可编辑的模板实例记录。', 'This project has no editable template instance.'],
    parameters: ['参数超出模板范围，或层数 / U 数不是整数。', 'Parameters are outside the template range, or shelf / unit counts are not integers.'],
    topology: ['这项修改会改变型材数量。请新建模板实例；当前零件未改动。', 'This change alters the member count. Add a new template instance; existing parts are unchanged.'],
    modified: ['模板成员已手动修改、删除或锁定，不能按原参数重建。', 'Template members were manually changed, deleted or locked and cannot be regenerated.'],
    'panel-mount': ['现有板材固定件需要重新选择安装位。请先移除固定件，更新参数后重新安装。', 'Existing panel fasteners need new mounting positions. Remove them, update parameters and reinstall the fasteners.'],
    unbound: ['工程中有未关联的连接件、板材或门抽屉，无法确定应如何跟随。请先建立关联或移除这些零件。', 'The project contains unbound connectors, panels or fittings. Bind or remove them before changing template parameters.'],
  }
  return messages[result.reason][zh ? 0 : 1]
}
