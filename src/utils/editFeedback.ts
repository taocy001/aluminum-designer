import type { EditResult } from './openingBindings'
import { useToolStore } from '../store/useToolStore'
import { translations } from './translations'
import { cancelNextNote } from './opLog'

/** Operation callers decide when to show feedback; rejected edits never publish document state. */
export function reportEditResult(result: EditResult): boolean {
  const tools = useToolStore.getState(), t = translations[tools.language]
  if (result.status !== 'applied') cancelNextNote()
  if (result.status === 'rejected') tools.showToast(result.reason === 'invalid-equipment' ? t.equipmentInvalid : t.bindingEditRejected, 'error')
  else if (result.status === 'applied' && result.orphanedIds.length) tools.showToast(t.bindingMissing, 'info')
  return result.status === 'applied'
}
