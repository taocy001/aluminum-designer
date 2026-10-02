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
  position: f.position, quaternion: f.quaternion, frame: f.frame, stacked: f.stacked, parts: fittingParts(f),
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
})
