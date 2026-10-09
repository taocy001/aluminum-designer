/** Generation provenance used to reject edits that would replace manual geometry. */
export interface TemplateInstance {
  id: string
  templateId: string
  parameters: Record<string, number>
  profileIds: string[]
  fingerprints: string[]
}

export function validTemplateInstances(value: unknown): value is TemplateInstance[] {
  if (!Array.isArray(value)) return false
  const instances = new Set<string>(), members = new Set<string>()
  return value.every(item => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || instances.has(item.id)
      || typeof item.templateId !== 'string' || !item.templateId
      || !item.parameters || typeof item.parameters !== 'object' || Array.isArray(item.parameters)
      || !Object.values(item.parameters).every(n => typeof n === 'number' && Number.isFinite(n))
      || !Array.isArray(item.profileIds) || !item.profileIds.length
      || !Array.isArray(item.fingerprints) || item.fingerprints.length !== item.profileIds.length
      || !item.fingerprints.every((text: unknown) => typeof text === 'string' && text.length > 0)) return false
    instances.add(item.id)
    return item.profileIds.every((id: unknown) => {
      if (typeof id !== 'string' || !id || members.has(id)) return false
      members.add(id)
      return true
    })
  })
}
