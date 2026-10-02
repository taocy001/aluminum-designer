import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore, type FittingData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { validFitting } from '../utils/fittingValidation'
import { fittingParts } from '../utils/fittingGeometry'
import { liveParts } from '../utils/editOps'
import { addFittingFromSelection, updateFittings } from '../utils/fittingOps'
import { parseProjectDocument, serializeProjectDocument, PROJECT_VERSION } from '../utils/document'
import { decodeShare, encodeShareLink } from '../utils/shareLink'
import { buildProfile } from '../utils/profileFactory'

const drawer = (id = 'drawer', extra: Partial<FittingData> = {}): FittingData => ({
  id, kind: 'drawer', width: 500, height: 200, depth: 400, frame: 0,
  position: [0, 300, 0], quaternion: [0, 0, 0, 1], material: 'ply', open: 0, ...extra,
})
const document = (fittings: FittingData[]) => ({
  version: PROJECT_VERSION, profiles: [], connectors: [], panels: [], fittings, throughRule: 'rails' as const,
})
const invalid: Partial<FittingData>[] = [
  { width: 60 }, { width: 65 }, { height: 59 }, { depth: 60 },
  { depth: 78, overlay: 'inset' }, { width: NaN }, { depth: Infinity }, { frame: -1 },
  { swing: 270, hingeType: 'slot' }, { open: 1.1 }, { position: [0, NaN, 0] },
  { quaternion: [0, 0, 0, 0] }, { stacked: { above: 'yes' } as never },
  { meeting: 'right' }, { overlay: 'invalid' as never },
]

beforeEach(() => {
  useStore.setState({ ...document([]), selectedIds: [], past: [], future: [] })
  useToolStore.getState().setViewMode(false)
})

describe('fitting bounds produce complete geometry', () => {
  it.each(invalid)('rejects %j', (change) => expect(validFitting(drawer('d', change))).toBe(false))

  it.each([
    { width: 65.1 }, { depth: 60.1 }, { depth: 78.1, overlay: 'inset' as const },
    { depth: 60, frame: 20 }, { depth: 60, frame: 20, overlay: 'inset' as const },
    { depth: 60.1, overlay: 'half' as const }, { height: 60 },
  ])('accepts %j with all six positive-size boards', (change) => {
    const fitting = drawer('d', change)
    expect(validFitting(fitting)).toBe(true)
    const parts = fittingParts(fitting)
    expect(parts.boards.map((board) => board.role).sort()).toEqual(['back', 'base', 'front', 'inner-front', 'side', 'side'])
    expect(parts.boards.every((board) => [board.width, board.height, board.thickness].every((value) => value > 0))).toBe(true)
  })

  it('allows a 60 mm door opening and the supported slot-hinge angle', () => {
    const door = drawer('door', { kind: 'door', width: 60, height: 60, depth: 60, hingeType: 'slot', swing: 180 })
    expect(validFitting(door)).toBe(true)
    expect(fittingParts(door).boards).toHaveLength(1)
  })
})

describe('store fitting entry points reject invalid changes atomically', () => {
  const actions = {
    addFittings: (bad: FittingData) => useStore.getState().addFittings([drawer('added'), bad], true),
    updateFitting: (bad: FittingData) => useStore.getState().updateFitting('original', bad),
    commitDocument: (bad: FittingData) => useStore.getState().commitDocument({ fittings: [drawer('added'), bad], panels: [] }, ['added']),
    commitTransform: (bad: FittingData) => useStore.getState().commitTransform({
      fittings: [{ id: 'other', updates: { width: 600 } }, { id: 'original', updates: bad }],
      panels: [{ id: 'panel', updates: { width: 600 } }],
    }),
    updateParts: (bad: FittingData) => useStore.getState().updateParts({
      fittings: [{ id: 'other', updates: { width: 600 } }, { id: 'original', updates: bad }],
      panels: [{ id: 'panel', updates: { width: 600 } }],
    }),
  }
  for (const [name, action] of Object.entries(actions)) {
    it.each(invalid)(`${name} rejects %j without changing selection or undo/redo`, (change) => {
      useStore.getState().addFittings([drawer('original'), drawer('other')], true)
      useStore.setState({ panels: [{ id: 'panel', width: 500, height: 400, thickness: 18, material: 'mdf',
        position: [0, 0, 0], quaternion: [0, 0, 0, 1] }] })
      useStore.getState().updateFitting('other', { width: 700 })
      useStore.getState().undo()
      const before = useStore.getState()
      expect(before.past).not.toHaveLength(0)
      expect(before.future).toHaveLength(1)
      action(drawer('original', change))
      expect(useStore.getState()).toBe(before)
    })
  }

  it('accepts a valid size change with undo and redo', () => {
    useStore.getState().addFittings([drawer()], true)
    useStore.getState().updateFitting('drawer', { width: 65.1, depth: 60.1 })
    expect(fittingParts(useStore.getState().fittings[0]).boards).toHaveLength(6)
    useStore.getState().undo()
    expect(useStore.getState().fittings[0].width).toBe(500)
    useStore.getState().redo()
    expect(useStore.getState().fittings[0].width).toBe(65.1)
  })

  it('rejects duplicate fitting IDs and ignores unchanged or locked edits', () => {
    useStore.getState().addFittings([drawer('one'), drawer('locked', { locked: true })])
    const before = useStore.getState()
    before.addFittings([drawer('one')])
    before.updateFitting('one', { width: 500 })
    before.updateFitting('missing', { width: 600 })
    before.updateFitting('locked', { width: 600 })
    expect(useStore.getState()).toBe(before)
  })
})

describe('editing validates every target after rounding', () => {
  it.each([updateFittings, liveParts])('keeps the entire batch when one overlay leaves too little box depth', (edit) => {
    useStore.getState().addFittings([drawer('full'), drawer('inset', { overlay: 'inset' })], true)
    const before = useStore.getState()
    expect(edit(['full', 'inset'], { depth: 70 })).toBe(false)
    expect(useStore.getState()).toBe(before)
  })

  it.each([{ width: 65.04 }, { depth: 60.04 }, { depth: 78.04, overlay: 'inset' }])('rejects %j when rounding would remove the box', (change) => {
    useStore.getState().addFittings([drawer()], true)
    const before = useStore.getState()
    expect(liveParts(['drawer'], change, true)).toBe(false)
    expect(useStore.getState()).toBe(before)
  })

  it('rounds a valid size, retains unchanged targets and skips locked targets', () => {
    useStore.getState().addFittings([drawer('same', { width: 65.1 }), drawer('changed'), drawer('locked', { locked: true })])
    const before = useStore.getState()
    expect(liveParts(['same', 'changed', 'locked'], { width: 65.06 }, true)).toBe(true)
    expect(useStore.getState().fittings.map((f) => f.width)).toEqual([65.1, 65.1, 500])
    expect(useStore.getState().past).toHaveLength(before.past.length + 1)
    useStore.getState().undo()
    expect(useStore.getState().fittings).toEqual(before.fittings)
  })

  it('rejects a narrow new drawer before adding its front or recording history', () => {
    const profiles = [0, 85].flatMap((x) => [0, 80].map((z) => buildProfile(
      new THREE.Vector3(x, 0, z), new THREE.Vector3(x, 800, z), '2020')!))
    useStore.setState({ profiles, selectedIds: profiles.map((p) => p.id) })
    const before = useStore.getState()
    expect(addFittingFromSelection({ kind: 'drawer', frontHeight: 200 })).toBe(false)
    expect(useStore.getState()).toBe(before)
    expect(addFittingFromSelection({ kind: 'door', hingeType: 'slot', swing: 270 })).toBe(false)
    expect(useStore.getState()).toBe(before)
    expect(addFittingFromSelection({ kind: 'door' })).toBe(true)
    expect(useStore.getState().fittings[0].width).toBeCloseTo(65)
  })
})

describe('file and share fitting validation', () => {
  it.each(invalid)('rejects %j on import, save and share without polluting the store', async (change) => {
    useStore.getState().addFittings([drawer('existing')], true)
    const before = useStore.getState()
    const bad = document([drawer('valid'), drawer('invalid', change)])
    expect(() => parseProjectDocument(bad)).toThrow(/Invalid project/)
    expect(() => before.loadDocument(bad)).toThrow(/Invalid project/)
    expect(() => serializeProjectDocument(bad)).toThrow(/Invalid project/)
    await expect(encodeShareLink(bad, 'https://example.com/')).rejects.toThrow(/Invalid project/)
    expect(useStore.getState()).toBe(before)
  })

  it('validates a legacy drawer after inferring its frame and rejects the same depth without a frame in a current file', () => {
    const doc = document([drawer('legacy', { frame: undefined, depth: 60, overlay: 'inset' })])
    const migrated = parseProjectDocument({ ...doc, version: 5 })
    expect(migrated.fittings[0].frame).toBe(20)
    expect(fittingParts(migrated.fittings[0]).boards).toHaveLength(6)
    expect(parseProjectDocument(migrated)).toEqual(migrated)
    expect(() => parseProjectDocument(doc)).toThrow(/drawer box/)
  })

  it('rejects a crafted invalid share even when it bypasses the share encoder', async () => {
    const packed = [4, 'rails', [], [], [], [['drawer', 65, 200, 400, [0, 0, 0], [0, 0, 0, 1], 'ply', '', '', '', 0, 0]]]
    const stream = new Blob([JSON.stringify(packed)]).stream().pipeThrough(new CompressionStream('deflate-raw'))
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
    const payload = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    await expect(decodeShare(payload)).rejects.toThrow(/drawer box/)
  })
})
