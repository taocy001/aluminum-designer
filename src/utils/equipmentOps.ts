import { useStore, type EquipmentClearance, type EquipmentData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { normalizeEquipmentClearance, validEquipment } from './equipmentValidation'
import { selectionPivot } from './editOps'
import { nextId } from './profileFactory'
import { noteNext } from './opLog'
import type { EditResult } from './openingBindings'

export type EquipmentInput = Pick<EquipmentData, 'name' | 'width' | 'height' | 'depth'> & { clearance?: Partial<EquipmentClearance> }

/** Keep the entered dimensions; place the body on the work plane at the selected assembly's X/Z centre. */
export function createEquipment(input: EquipmentInput): EditResult {
  const store = useStore.getState(), ids = new Set(store.selectedIds)
  const clearance = normalizeEquipmentClearance(input.clearance)
  if (!clearance) return { status: 'rejected', reason: 'invalid-equipment', partIds: [] }
  const centre = selectionPivot(store.profiles.filter((p) => ids.has(p.id)), store.connectors.filter((c) => ids.has(c.id)), 'center',
    store.panels.filter((p) => ids.has(p.id)), store.fittings.filter((f) => ids.has(f.id)), store.profiles,
    store.equipment.filter((e) => ids.has(e.id)))
  const equipment: EquipmentData = {
    id: nextId('e'), name: input.name, width: input.width, height: input.height, depth: input.depth, clearance,
    position: [centre.x, useToolStore.getState().workPlaneY + input.height / 2, centre.z], quaternion: [0, 0, 0, 1],
  }
  if (!validEquipment(equipment)) return { status: 'rejected', reason: 'invalid-equipment', partIds: [] }
  noteNext('add equipment')
  return store.addEquipment(equipment)
}
