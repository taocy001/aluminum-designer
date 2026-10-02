import type { EquipmentData } from '../../store/useStore'

export const noClearance = () => ({ left: 0, right: 0, bottom: 0, top: 0, back: 0, front: 0 })
export const equipment = (id = 'oven', extra: Partial<EquipmentData> = {}): EquipmentData => ({
  id, name: 'Built-in oven', width: 595, height: 590, depth: 550,
  position: [150, 420, -280], quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
  clearance: { left: 5, right: 10, bottom: 3, top: 20, back: 40, front: 100 }, ...extra,
})
