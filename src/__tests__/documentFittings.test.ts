import { beforeEach, describe, expect, it } from 'vitest'
import { useStore, type FittingData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { parseProjectDocument, serializeProjectDocument, PROJECT_VERSION, type ProjectDocument } from '../utils/document'
import { projectStorage } from '../utils/documentPersistence'
import { duplicateSelected, nudgeSelected, rotateSelected } from '../utils/editOps'
import { fittingParts } from '../utils/fittingGeometry'
import { decodeShare, encodeShareLink } from '../utils/shareLink'

const drawer = (id: string, y = 1000, extra: Partial<FittingData> = {}): FittingData => ({
  id, kind: 'drawer', width: 500, height: 250, depth: 500,
  position: [0, y, 0], quaternion: [0, 0, 0, 1], material: 'mdf', open: 0, frame: 20, ...extra,
})
const project = (fittings: FittingData[] = []): ProjectDocument => ({
  profiles: [], connectors: [], panels: [], fittings, throughRule: 'rails',
})
const front = (f: FittingData) => fittingParts(f).boards.find((b) => b.role === 'front')!
const shape = (f: FittingData) => ({
  position: f.position, quaternion: f.quaternion, frame: f.frame, stacked: f.stacked, drawer: f.drawer, parts: fittingParts(f),
})
const reload = async (via: 'file' | 'share', source: ProjectDocument) => {
  const doc = via === 'file' ? parseProjectDocument(serializeProjectDocument(source))
    : await decodeShare(new URL(await encodeShareLink(source, 'https://example.com/')).hash.slice(3))
  expect(doc.version).toBe(PROJECT_VERSION)
  useStore.getState().loadDocument(doc)
  return useStore.getState().fittings
}
const packedPayload = async (packed: unknown) => {
  const stream = new Blob([JSON.stringify(packed)]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

beforeEach(() => {
  useStore.setState({ ...project(), past: [], future: [], selectedIds: [] })
  useToolStore.getState().stopDrag()
  useToolStore.getState().stopResize()
  useToolStore.getState().setPivotMode('center')
})

describe('current fitting geometry round trips', () => {
  it.each(['file', 'share'] as const)('keeps adjacent independent drawer fronts unchanged through %s', async (via) => {
    useStore.getState().addFittings([drawer('original')], true)
    expect(duplicateSelected()).toBe(true)
    expect(nudgeSelected([-50, 250, 0])).toBe(true)
    const before = useStore.getState().fittings
    expect(before.map((f) => [front(f).width, front(f).height])).toEqual([[530, 280], [530, 280]])
    const after = await reload(via, project(before))
    expect(after.map(shape)).toEqual(before.map(shape))
    expect(after.every((f) => f.stacked === undefined)).toBe(true)
  })

  it.each(['file', 'share'] as const)('retains an absent frame and its original pose through %s', async (via) => {
    const source = drawer('without-frame', 1000, { frame: undefined })
    const current = parseProjectDocument({ ...project([source]), version: PROJECT_VERSION })
    expect(current.fittings[0].frame).toBeUndefined()
    expect(current.fittings[0].position).toEqual([0, 1000, 0])
    const [restored] = await reload(via, current)
    expect(restored.frame).toBeUndefined()
    expect(shape(restored)).toEqual(shape(source))
  })

  it.each(['file', 'share'] as const)('preserves explicit front edges after copying, moving and rotating through %s', async (via) => {
    const flags: FittingData['stacked'][] = [{ above: true }, { below: true }, { above: false, below: false }, {}]
    const source = flags.map((stacked, i) => drawer(`edge-${i}`, 1000 + i * 1000, { stacked }))
    useStore.getState().addFittings(source, true)
    expect(duplicateSelected()).toBe(true)
    expect(nudgeSelected([900, 125, 300])).toBe(true)
    expect(rotateSelected('x', 90)).toBe(true)
    const before = useStore.getState().fittings
    expect(before.slice(4).map((f) => f.stacked)).toEqual(flags)
    expect(before.slice(4).map(fittingParts)).toEqual(source.map(fittingParts))
    expect(before[4].quaternion).not.toEqual(source[0].quaternion)
    const after = await reload(via, project(before))
    expect(after.map(shape)).toEqual(before.map(shape))
  })

  it('persists the project version with the actual store snapshot and reloads unchanged', async () => {
    const values = new Map<string, string>()
    const backing = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    }
    const storage = projectStorage(() => backing)
    useStore.getState().addFittings([drawer('lower'), drawer('upper', 1250)])
    const before = useStore.getState().fittings
    const { partialize, version = 0 } = useStore.persist.getOptions()
    storage.setItem('doc', { state: partialize!(useStore.getState()), version })
    storage.flush()
    expect(JSON.parse(values.get('doc')!)).toMatchObject({ version: 0, state: { version: PROJECT_VERSION } })
    const restored = await projectStorage(() => backing).getItem('doc')
    useStore.getState().loadDocument(restored!.state)
    expect(useStore.getState().fittings.map(shape)).toEqual(before.map(shape))
  })
})

describe('legacy fitting migration', () => {
  it('retains version 6 geometry without inferring drawer edges or frame offsets', () => {
    const source = project([drawer('lower', 1000, { frame: undefined }), drawer('upper', 1250, { frame: undefined })])
    const current = parseProjectDocument({ ...source, version: 6 })
    expect(current.version).toBe(PROJECT_VERSION)
    expect(current.fittings.map(shape)).toEqual(source.fittings.map(shape))
    expect(current.fittings.every((f) => f.frame === undefined && f.stacked === undefined && f.drawer === undefined)).toBe(true)
  })

  it.each([undefined, 1, 2, 3, 4, 5])('migrates version %s once and preserves the result on subsequent loads', (version) => {
    const source = project([drawer('lower', 1000, { frame: undefined }), drawer('upper', 1250, { frame: undefined })])
    const migrated = parseProjectDocument({ ...source, version })
    expect(migrated.version).toBe(PROJECT_VERSION)
    expect(migrated.fittings.map((f) => f.frame)).toEqual([20, 20])
    expect(migrated.fittings.map((f) => f.position)).toEqual([[0, 1000, -10], [0, 1250, -10]])
    expect(migrated.fittings.map((f) => f.stacked)).toEqual([{ above: true, below: false }, { above: false, below: true }])
    expect(migrated.fittings.map((f) => front(f).height)).toEqual([263.5, 263.5])
    expect(parseProjectDocument(migrated)).toEqual(migrated)
    useStore.getState().loadDocument(migrated)
    expect(useStore.getState().fittings).toEqual(migrated.fittings)
    expect(source.fittings.every((f) => f.frame === undefined && f.stacked === undefined)).toBe(true)
  })

  it('does not infer new shared edges when a parsed drawer later acquires a neighbour', () => {
    const migrated = parseProjectDocument(project([drawer('lower', 1000, { frame: undefined })]))
    migrated.fittings.push(drawer('upper', 1250, { position: [0, 1250, -10] }))
    useStore.getState().loadDocument(migrated)
    expect(useStore.getState().fittings.map((f) => front(f).height)).toEqual([280, 280])
    expect(useStore.getState().fittings.every((f) => f.stacked === undefined)).toBe(true)
  })

  it('migrates an unversioned browser snapshot before a second store load', async () => {
    const source = project([drawer('lower', 1000, { frame: undefined }), drawer('upper', 1250, { frame: undefined })])
    const raw = JSON.stringify({ version: 0, state: source })
    const storage = projectStorage(() => ({ getItem: (key) => key === 'doc' ? raw : null, setItem: () => {}, removeItem: () => {} }))
    const loaded = await storage.getItem('doc')
    expect(loaded!.state).toMatchObject({ version: PROJECT_VERSION })
    useStore.getState().loadDocument(loaded!.state)
    expect(useStore.getState().fittings.map((f) => f.position[2])).toEqual([-10, -10])
    expect(useStore.getState().fittings.map((f) => front(f).height)).toEqual([263.5, 263.5])
  })

  it('retains stacked-edge migration when reading an old v3 share', async () => {
    const payload = await packedPayload([3, 'rails', [], [], [], [1000, 1250].map((y) => [
      'drawer', 500, 250, 500, [0, y, 0], [0, 0, 0, 1], 'mdf', '', '', '', 0, 20,
    ])])
    const doc = await decodeShare(payload)
    expect(doc.version).toBe(PROJECT_VERSION)
    useStore.getState().loadDocument(doc)
    expect(useStore.getState().fittings.map((f) => front(f).height)).toEqual([263.5, 263.5])
    expect(useStore.getState().fittings.map((f) => f.position[2])).toEqual([0, 0])
  })

  it('reads a version 4 share without inferring adjacent drawer edges', async () => {
    const payload = await packedPayload([4, 'rails', [], [], [], [1000, 1250].map((y) => [
      'drawer', 500, 250, 500, [0, y, 0], [0, 0, 0, 1], 'mdf', '', '', '', 0, null, null, false, '',
    ])])
    const doc = await decodeShare(payload)
    expect(doc.version).toBe(PROJECT_VERSION)
    expect(doc.fittings.map(shape)).toEqual([
      drawer('lower', 1000, { frame: undefined }), drawer('upper', 1250, { frame: undefined }),
    ].map(shape))
  })
})

describe('drawer parameters in project files and links', () => {
  it.each(['file', 'share'] as const)('preserves a catalog slide and derived over-length travel through %s', async via => {
    const source = drawer('catalog', 1000, { drawer: { runnerModel: 'accuride-3832e', runnerLength: 450 } })
    const [restored] = await reload(via, project([source]))
    expect(restored.drawer).toEqual(source.drawer)
    expect(fittingParts(restored).travel).toBe(457)
    expect(shape(restored)).toEqual(shape(source))
  })

  const configured = {
    sideClearance: 20, boxThickness: 18, bottomThickness: 9, rearClearance: 30,
    runnerLength: 400, runnerTravel: 300, reinforcement: { count: 1, width: 40, height: 20 },
  }

  it.each(['file', 'share'] as const)('preserves drawer parameters and generated parts through %s', async (via) => {
    const source = drawer('configured', 1000, { drawer: configured })
    const [restored] = await reload(via, project([source]))
    expect(restored.drawer).toEqual(configured)
    expect(shape(restored)).toEqual(shape(source))
    expect(fittingParts(restored).travel).toBe(300)
    expect(fittingParts(restored).boards.find((board) => board.role === 'base')?.thickness).toBe(9)
  })

  it.each(['file', 'share'] as const)('preserves omitted parameters and explicit zero values through %s', async (via) => {
    const source = drawer('partial', 1000, { drawer: {
      sideClearance: 0, rearClearance: 0, runnerTravel: 0,
      reinforcement: { count: 0, width: 40, height: 20 },
    } })
    const [restored] = await reload(via, project([source]))
    expect(restored.drawer).toEqual(source.drawer)
    expect(shape(restored)).toEqual(shape(source))
    expect(fittingParts(restored).travel).toBe(0)
  })

  it.each(['file', 'share'] as const)('preserves an empty parameter object through %s', async (via) => {
    const source = drawer('defaults', 1000, { drawer: {} })
    const [restored] = await reload(via, project([source]))
    expect(restored.drawer).toEqual({})
    expect(fittingParts(restored)).toEqual(fittingParts(drawer('defaults')))
  })

  it.each([undefined, 5, 6])('keeps the default drawer parts when reading version %s without parameters', (version) => {
    const doc = parseProjectDocument({ ...project([drawer('default')]), version })
    expect(doc.fittings[0].drawer).toBeUndefined()
    const parts = fittingParts(doc.fittings[0])
    expect(parts.boards.map((board) => [board.role, board.width, board.height, board.thickness])).toEqual([
      ['side', 500, 224, 15], ['side', 500, 224, 15],
      ['back', 445, 224, 15], ['inner-front', 445, 224, 15],
      ['base', 445, 470, 15], ['front', 530, 280, 18],
    ])
    expect(parts.travel).toBe(470)
  })

  const invalid = [
    { name: 'non-object', value: [] },
    { name: 'unknown field', value: { unknown: 1 } },
    { name: 'negative side clearance', value: { sideClearance: -1 } },
    { name: 'non-finite clearance', value: { sideClearance: Infinity } },
    { name: 'zero box thickness', value: { boxThickness: 0 } },
    { name: 'zero bottom thickness', value: { bottomThickness: 0 } },
    { name: 'negative rear clearance', value: { rearClearance: -1 } },
    { name: 'zero runner length', value: { runnerLength: 0 } },
    { name: 'negative runner travel', value: { runnerTravel: -1 } },
    { name: 'non-finite runner travel', value: { runnerTravel: Infinity } },
    { name: 'fractional reinforcement count', value: { reinforcement: { count: 1.5, width: 40, height: 20 } } },
    { name: 'too many reinforcements', value: { reinforcement: { count: 5, width: 40, height: 20 } } },
    { name: 'missing reinforcement dimensions', value: { reinforcement: { count: 1 } } },
    { name: 'zero reinforcement width', value: { reinforcement: { count: 1, width: 0, height: 20 } } },
    { name: 'no remaining box width', value: { sideClearance: 250 } },
    { name: 'no remaining box depth', value: { rearClearance: 520 } },
  ]

  it.each(invalid)('rejects $name in files, saved snapshots and links', async ({ value }) => {
    const source = project([drawer('invalid', 1000, { drawer: value as FittingData['drawer'] })])
    expect(() => parseProjectDocument({ ...source, version: PROJECT_VERSION })).toThrow('Invalid project:')
    expect(() => serializeProjectDocument(source)).toThrow('Invalid project:')
    await expect(encodeShareLink(source, 'https://example.com/')).rejects.toThrow('Invalid project:')
    const payload = await packedPayload([5, 'rails', [], [], [], [[
      'drawer', 500, 250, 500, [0, 1000, 0], [0, 0, 0, 1], 'mdf', '', '', '', 0, 20, null, false, '', value,
    ]]])
    await expect(decodeShare(payload)).rejects.toThrow('Invalid project:')
  })

  it('rejects drawer parameters on a door', async () => {
    const source = project([drawer('door', 1000, { kind: 'door', drawer: configured })])
    expect(() => parseProjectDocument({ ...source, version: PROJECT_VERSION })).toThrow('Invalid project:')
    expect(() => serializeProjectDocument(source)).toThrow('Invalid project:')
    await expect(encodeShareLink(source, 'https://example.com/')).rejects.toThrow('Invalid project:')
    const payload = await packedPayload([5, 'rails', [], [], [], [[
      'door', 500, 250, 500, [0, 1000, 0], [0, 0, 0, 1], 'mdf', '', '', '', 0, 20, null, false, '', configured,
    ]]])
    await expect(decodeShare(payload)).rejects.toThrow('Invalid project:')
  })
})
