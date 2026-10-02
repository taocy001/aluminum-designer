import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { normalizeEquipmentClearance, validEquipment, validEquipmentClearance, validEquipmentList } from '../utils/equipmentValidation'
import { equipment, noClearance } from './fixtures/equipment'

describe('equipment dimensions and clearance validation', () => {
  it('defaults only omitted clearances to zero', () => {
    expect(normalizeEquipmentClearance(undefined)).toEqual(noClearance())
    expect(normalizeEquipmentClearance({ front: 45, left: 12 })).toEqual({ ...noClearance(), front: 45, left: 12 })
    expect(validEquipmentClearance({ front: 45 })).toBe(false)
    expect(validEquipmentClearance(noClearance())).toBe(true)
  })

  it.each([null, [], '10', { front: -1 }, { left: NaN }, { back: Infinity }, { rear: 20 }])('rejects malformed clearance %j', (value) => {
    expect(normalizeEquipmentClearance(value)).toBeNull()
  })

  it('accepts small positive user dimensions and a finite nonunit orientation', () => {
    expect(validEquipment(equipment('tiny', { width: 0.001, height: 0.02, depth: 0.03, quaternion: [0, 0, 0, 2] }))).toBe(true)
  })

  it.each([
    { width: 0 }, { height: -1 }, { depth: Infinity }, { name: '  ' }, { position: [NaN, 0, 0] },
    { quaternion: [0, 0, 0, 0] }, { quaternion: [1e308, 1e308, 0, 0] }, { locked: 1 },
    { clearance: { ...noClearance(), front: -1 } }, { openingBinding: {} },
  ])('rejects invalid saved fields %j', (updates) => {
    expect(validEquipment({ ...equipment(), ...updates })).toBe(false)
  })

  it('rejects finite dimensions whose asymmetric clearance span overflows', () => {
    expect(validEquipment(equipment('large', { width: 1e308, clearance: { ...noClearance(), left: 1e308, right: 1e308 } }))).toBe(false)
  })

  it('rejects finite pose and dimensions whose rotated extent overflows', () => {
    const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 4).toArray()
    expect(validEquipment(equipment('large', { position: [1.6e308, 0, 0], width: 1e308, height: 1e308,
      quaternion, clearance: noClearance() }))).toBe(false)
  })

  it('rejects repeated equipment IDs and malformed arrays', () => {
    expect(validEquipmentList([equipment(), equipment()])).toBe(false)
    expect(validEquipmentList(null)).toBe(false)
    expect(validEquipmentList([null])).toBe(false)
    expect(validEquipmentList([equipment('one'), equipment('two')])).toBe(true)
  })
})
