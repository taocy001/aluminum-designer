import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeChange, type Doc } from '../utils/opLog'

const doc = (): Doc => ({ profiles: [], connectors: [], panels: [{ id: 'b', width: 560, height: 760, thickness: 18, material: 'mdf', position: [0, 0, 0], quaternion: [0, 0, 0, 1] }],
  fittings: [{ id: 'f', kind: 'door', width: 580, height: 760, depth: 400, frame: 20, position: [300, 400, 210], quaternion: [0, 0, 0, 1], material: 'mdf', open: 0, hinge: 'left', hingeType: 'cup', swing: 110 }], throughRule: 'rails' })

describe('the operation log records design changes', () => {
  it('includes every edited board dimension and material', () => {
    const before = doc(), after = { ...before, panels: [{ ...before.panels[0], width: 800, height: 600, thickness: 15, material: 'alu' as const }] }
    const change = describeChange(before, after)!
    for (const detail of ['width 560 → 800', 'height 760 → 600', 'thickness 18 → 15', 'material mdf → alu']) expect(change.detail).toContain(detail)
    expect(change.ids).toEqual(['b'])
  })

  it('records hinge, frame and stacked data even if open changes too', () => {
    const before = doc(), after = { ...before, fittings: [{ ...before.fittings[0], hinge: 'right' as const, swing: 165, frame: 40, open: 1, stacked: { above: true } }] }
    const change = describeChange(before, after)!
    for (const field of ['hinge left → right', 'swing 110 → 165', 'frame 20 → 40', 'stacked']) expect(change.detail).toContain(field)
    expect(change.detail).not.toContain('open ')
  })

  it('ignores opening alone, but does not hide a simultaneous lock change', () => {
    const before = doc()
    expect(describeChange(before, { ...before, fittings: [{ ...before.fittings[0], open: 1 }] })).toBeNull()
    expect(describeChange(before, { ...before, fittings: [{ ...before.fittings[0], open: 1, locked: true }] })!.detail).toContain('locked')
  })

  it('records through-rule changes without any part changing', () => {
    const before = doc()
    expect(describeChange(before, { ...before, throughRule: 'posts' })!.detail).toContain('throughRule rails → posts')
  })

  it('keeps edits of surviving parts in the same transaction as additions and deletions', () => {
    const before = doc(), after = { ...before, fittings: [], panels: [{ ...before.panels[0], width: 800 }, { ...before.panels[0], id: 'b2' }] }
    const change = describeChange(before, after)!
    expect(change.label).toBe('replace')
    expect(change.detail).toContain('+1 board')
    expect(change.detail).toContain('−1 fitting')
    expect(change.detail).toContain('width 560 → 800')
    expect(change.ids.sort()).toEqual(['b', 'b2', 'f'])
  })

  it('does not hide submillimetre design edits or add noise for reordered nested fields', () => {
    const before = doc(), after = { ...before, panels: [{ ...before.panels[0], position: [0.001, 0, 0] as [number, number, number] }] }
    expect(describeChange(before, after)!.detail).toContain('[0.001, 0, 0]')
    const first = { ...before, fittings: [{ ...before.fittings[0], stacked: { above: true, below: false } }] }
    expect(describeChange(first, { ...first, fittings: [{ ...first.fittings[0], stacked: { below: false, above: true } }] })).toBeNull()
  })
})

describe('operation log cache validation', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

  it.each(['null', '{}', '17', '[null]', '[{}]', '[{"at":1,"label":"x","detail":"","ids":null}]',
    '[{"at":1e99,"label":"x","detail":"","ids":[]}]', '{broken'])('keeps the editor usable with a bad cache: %s', async (raw) => {
    vi.stubGlobal('localStorage', { getItem: () => raw, setItem: vi.fn() })
    vi.resetModules()
    const log = await import('../utils/opLog')
    expect(log.opLog()).toEqual([])
    expect(log.opLogText()).toBe('')
    const before = doc()
    log.record(before, { ...before, panels: [{ ...before.panels[0], width: 800 }] })
    expect(log.opLog()).toHaveLength(1)
    expect(log.opLogText()).toContain('width 560 → 800')
  })

  it('retains valid records while dropping malformed entries and limiting the cache size', async () => {
    const valid = { at: 1, label: 'edit', detail: 'width 560 → 800', ids: ['b'] }
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify([null, ...Array.from({ length: 405 }, () => valid)]), setItem: vi.fn() })
    vi.resetModules()
    const log = await import('../utils/opLog')
    expect(log.opLog()).toHaveLength(400)
    expect(log.opLog()[0]).toEqual(valid)
    expect(log.opLogText()).toContain('width 560 → 800')
  })
})
