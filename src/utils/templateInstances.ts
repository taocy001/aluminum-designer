import { Quaternion, Vector3 } from 'three'
import { useStore, type ProfileData } from '../store/useStore'
import { templateById, type Template } from './templates'
import { nextId } from './profileFactory'
import type { TemplateInstance } from './templateMetadata'
import { reconcileBindings, type EditResult } from './openingBindings'
import { withFixedProfileCuts } from './jointUtils'
import { resizePanelMounts } from './resizePanelMounts'

export type TemplateEditResult = EditResult | { status: 'blocked'; reason: 'template' | 'parameters' | 'topology' | 'modified' | 'unbound' | 'panel-mount'; partIds: string[] }
const blocked = (reason: Extract<TemplateEditResult, { status: 'blocked' }>['reason'], partIds: string[] = []): TemplateEditResult => ({ status: 'blocked', reason, partIds })

/** Stored geometry used to detect member edits; a common rigid pose is checked separately. */
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

/** A rigid frame preserves the instance origin when the whole assembly is moved or rotated. */
function instanceFrame(canonical: ProfileData[], members: ProfileData[], fingerprints: string[], frozen: ProfileData[]) {
  if (!members.length || canonical.length !== members.length) return null
  const rotation = new Quaternion(...members[0].quaternion).multiply(new Quaternion(...canonical[0].quaternion).invert()).normalize()
  const translation = new Vector3(...members[0].position).sub(new Vector3(...canonical[0].position).applyQuaternion(rotation))
  for (let i = 0; i < members.length; i++) {
    const member = members[i], source = canonical[i]
    try {
      const previous = JSON.parse(fingerprints[i])
      // Ignore only pose; all machining, section and length changes still invalidate regeneration.
      const comparison = { ...member, position: previous?.position, quaternion: previous?.quaternion }
      if (previous?.fixedTrims === null && JSON.stringify(member.fixedTrims) === JSON.stringify(frozen[i].fixedTrims)) comparison.fixedTrims = undefined
      if (!previous || typeof previous !== 'object' || Array.isArray(previous)
        || templateProfileFingerprint(comparison) !== fingerprints[i]) return null
    } catch { return null }
    // Interactive transforms round positions to 0.001 mm; allow accumulated rounding
    // from repeated rigid edits, while rejecting an individual member offset.
    const expectedPosition = new Vector3(...source.position).applyQuaternion(rotation).add(translation)
    const expectedRotation = rotation.clone().multiply(new Quaternion(...source.quaternion)).normalize()
    if (expectedPosition.distanceTo(new Vector3(...member.position)) > .01
      || 1 - Math.abs(expectedRotation.dot(new Quaternion(...member.quaternion).normalize())) > 1e-10) return null
  }
  return { rotation, translation }
}

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
  if (!validParameters(template, parameters) || !validParameters(template, instance.parameters)) return blocked('parameters')
  if (template.params.every(param => parameters[param.key] === instance.parameters[param.key])) return { status: 'noop' }
  const members = instance.profileIds.map(member => state.profiles.find(p => p.id === member))
  const missingOrLocked = members.flatMap((member, index) => !member || member.locked ? [instance.profileIds[index]] : [])
  if (missingOrLocked.length) return blocked('modified', missingOrLocked)
  const canonical = template.build(instance.parameters)
  const frame = instanceFrame(canonical, members as ProfileData[], instance.fingerprints, withFixedProfileCuts(canonical, undefined, state.throughRule))
  if (!frame) return blocked('modified', instance.profileIds)
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
  const frozenGenerated = withFixedProfileCuts(generated, undefined, state.throughRule)
  const replacements = generated.map((p, index) => ({ ...members[index]!, ...p, id: instance.profileIds[index],
    fixedTrims: members[index]!.fixedTrims ? frozenGenerated[index].fixedTrims : undefined,
    position: new Vector3(...p.position).applyQuaternion(frame.rotation).add(frame.translation).toArray(),
    quaternion: frame.rotation.clone().multiply(new Quaternion(...p.quaternion)).normalize().toArray(),
  }))
  const byId = new Map(replacements.map(p => [p.id, p]))
  const nextInstance: TemplateInstance = { ...instance, parameters: { ...parameters }, fingerprints: replacements.map(templateProfileFingerprint) }
  const resolved = reconcileBindings(state, { profiles: state.profiles.map(p => byId.get(p.id) ?? p),
    panels: state.panels, fittings: state.fittings, connectors: state.connectors, equipment: state.equipment, throughRule: state.throughRule })
  if (resolved.status === 'rejected') return resolved
  const mounts = resizePanelMounts(state, resolved.document)
  if (mounts.status !== 'resolved') return mounts
  // Stage every dependent and mounting check before writing a single history entry.
  return state.commitDocument({ ...resolved.document, connectors: mounts.connectors,
    templateInstances: state.templateInstances.map(item => item.id === id ? nextInstance : item) })
}

export function templateEditMessage(result: Extract<TemplateEditResult, { status: 'blocked' }>, zh: boolean): string {
  const messages = {
    template: ['此工程没有可编辑的模板实例记录。', 'This project has no editable template instance.'],
    parameters: ['参数超出模板范围，或层数 / U 数不是整数。', 'Parameters are outside the template range, or shelf / unit counts are not integers.'],
    topology: ['这项修改会改变型材数量。请新建模板实例；当前零件未改动。', 'This change alters the member count. Add a new template instance; existing parts are unchanged.'],
    modified: ['模板成员被单独手动修改、删除或锁定，不能按原参数重建；整组平移或旋转可保留。', 'Individual template members were changed, deleted or locked. Moving or rotating the whole frame is supported.'],
    'panel-mount': ['板材固定件的原安装位无效，或新尺寸下无法保持安装、存在干涉。请检查标出的固定件。', 'Panel fasteners have invalid original seats or cannot remain installed without interference at the new size. Check the indicated fasteners.'],
    unbound: ['工程中有未关联的连接件、板材或门抽屉，无法确定应如何跟随。请先建立关联或移除这些零件。', 'The project contains unbound connectors, panels or fittings. Bind or remove them before changing template parameters.'],
  }
  return messages[result.reason][zh ? 0 : 1]
}
