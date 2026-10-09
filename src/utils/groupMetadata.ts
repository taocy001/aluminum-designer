export interface PartGroup { id: string; name: string; memberIds: string[] }
export function validPartGroups(value: unknown): value is PartGroup[] {
  if (!Array.isArray(value)) return false
  const ids = new Set<string>()
  return value.every(group => {
    if (!group || typeof group !== 'object' || typeof group.id !== 'string' || !group.id || ids.has(group.id)
      || typeof group.name !== 'string' || !group.name.trim() || group.name.length > 200
      || !Array.isArray(group.memberIds) || !group.memberIds.length
      || !group.memberIds.every((id: unknown) => typeof id === 'string' && id.trim())
      || new Set(group.memberIds).size !== group.memberIds.length) return false
    ids.add(group.id)
    return true
  })
}
