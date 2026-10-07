import { describe, expect, it } from 'vitest'
import type { ConnectorData } from '../store/useStore'
import { buildBom } from '../utils/bom'
import { accessoryHardwareReference, accessoryHingeDimensions, accessoryPlateDimensions } from '../utils/connectorAccessoryReferences'
import { profileSlotDimensions } from '../utils/specUtils'
import { buildProfile } from '../utils/profileFactory'
import { computeAllTrims } from '../utils/jointUtils'
import { Vector3 } from 'three'

const C = (type: string, series: 20 | 30 | 40 = 20): ConnectorData => ({ id: `${type}-${series}`, type, series,
  position: [0, 0, 0], quaternion: [0, 0, 0, 1] })

describe('physical accessory bill of materials', () => {
  it('lists the supplied foot locknut and the specified caster fixing screw without inventing slot nuts', () => {
    const rows = buildBom([], [C('foot', 40), C('end-cap'), C('caster-mount', 40)], new Map(), 'en').fasteners
    expect(rows).toHaveLength(2)
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'M8 nut (supplied locknut)', qty: 1 }),
      expect.objectContaining({ label: 'M8×25 DIN 7991 screw (caster core mounting)', qty: 1 }),
    ]))
  })

  it('keeps square and rectangular caps separate, including legacy square defaults', () => {
    const rows = buildBom([], [C('end-cap'), { ...C('end-cap'), id: 'rectangular', profileSpec: '2040' }], new Map(), 'en').connectors
    expect(rows.map((r) => [r.spec, r.qty])).toEqual([['2020', 1], ['2040', 1]])
  })

  it('counts four purchased 2020 B6 caps per 4040 B6 end in placed and suggested hardware', () => {
    const p = buildProfile(new Vector3(0, 0, -100), new Vector3(), '4040-B6', 'b6')!
    const c = { ...C('end-cap'), profileSpec: '4040-B6' as const }
    const bom = buildBom([p], [c], computeAllTrims([p]), 'en')
    expect(bom.connectors).toEqual([expect.objectContaining({ spec: 'Motedis PTS6B20x20 (4040 B6)', qty: 4 })])
    expect(bom.suggested).toEqual([expect.objectContaining({ key: 'suggest-cap-4040-B6', spec: 'Motedis PTS6B20x20 (4040 B6)', qty: 4 })])
    expect(bom.fasteners).toEqual([])
  })

  it('uses M6 countersunk screws on a 40-series hinge and leaves the bearing screw length unspecified', () => {
    const rows = buildBom([], [C('hinge', 40), C('pivot', 40)], new Map(), 'en').fasteners
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'M6×12 countersunk screw', qty: 4 }),
      expect.objectContaining({ label: 'M6 T-slot nut', qty: 4 }),
      expect.objectContaining({ label: 'M5 screw', qty: 2 }),
    ]))
    expect(rows.some((r) => r.label.startsWith('M8'))).toBe(false)
  })

  it.each([20, 30, 40] as const)('keeps plate and hinge screws clear of the series %s slot floor', (series) => {
    const slot = profileSlotDimensions(series)
    for (const type of ['flat-plate', 'joining-plate', 't-bracket', 'cross-bracket', 'hinge']) {
      const ref = accessoryHardwareReference(type, series)!
      if (!ref.verified) continue
      const bolt = ref.fasteners.find((f) => f.kind === 'bolt')!
      const thickness = type === 'hinge' ? accessoryHingeDimensions(series).thickness : accessoryPlateDimensions(type, series).thickness
      const washer = ref.fasteners.some((f) => f.kind === 'washer') ? 1 : 0
      // Flat-head screw lengths include the head, which is flush with the top leaf.
      const insertion = bolt.length! - thickness - washer
      expect(insertion, `${type} screw reaches slot nut`).toBeGreaterThan(slot.lipDepth + 1)
      expect(insertion, `${type} screw clears slot floor`).toBeLessThan(slot.depth)
    }
  })
})
