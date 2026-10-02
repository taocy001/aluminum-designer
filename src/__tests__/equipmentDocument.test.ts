import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../store/useStore'
import { parseProjectDocument, serializeProjectDocument, PROJECT_VERSION } from '../utils/document'
import { decodeShare, encodeShareLink } from '../utils/shareLink'
import { projectStorage } from '../utils/documentPersistence'
import { forgetSavedFile, openProject, saveProject } from '../utils/projectFile'
import { boundProject } from './fixtures/bindings'
import { equipment, noClearance } from './fixtures/equipment'

const document = () => ({ version: PROJECT_VERSION, throughRule: 'posts' as const,
  profiles: [], connectors: [], panels: [], fittings: [], equipment: [equipment()] })
const packedRow = (e: Record<string, unknown>) => [e.id, e.name, e.width, e.height, e.depth, e.position, e.quaternion, e.clearance, e.locked ?? false]
const payload = async (packed: unknown) => {
  const stream = new Blob([JSON.stringify(packed)]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const shared = async (doc = document()) => decodeShare(new URL(await encodeShareLink(doc, 'https://example.com/design')).hash.slice(3))

beforeEach(() => {
  useStore.setState({ profiles: [], connectors: [], panels: [], fittings: [], equipment: [], throughRule: 'rails',
    past: [], future: [], selectedIds: [] })
  forgetSavedFile()
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('equipment documents', () => {
  it.each(['file', 'share'] as const)('preserves equipment-only geometry, all clearances and identifiers through %s', async (via) => {
    const source = document()
    source.equipment[0] = equipment('oven: 柜|%\n"', { name: '烤箱 "A"\n600', locked: true })
    const restored = via === 'file' ? parseProjectDocument(serializeProjectDocument(source)) : await shared(source)
    expect(restored).toEqual(source)
    expect(parseProjectDocument(restored)).toEqual(source)
    useStore.getState().loadDocument(restored)
    expect(useStore.getState().equipment).toEqual(source.equipment)
    expect(useStore.getState().throughRule).toBe('posts')
  })

  it('saves and reopens an equipment-only file through the file picker', async () => {
    let contents = ''
    const handle = { name: 'equipment.json', getFile: async () => ({ text: async () => contents }),
      createWritable: async () => ({ write: async (text: string) => { contents = text }, close: async () => {} }) }
    vi.stubGlobal('window', { showSaveFilePicker: async () => handle, showOpenFilePicker: async () => [handle] })
    expect((await saveProject(serializeProjectDocument(document()), 'equipment.json')).outcome).toBe('saved')
    const result = await openProject()
    if (result.outcome !== 'opened') throw new Error('Expected the saved equipment file')
    expect(parseProjectDocument(result.text)).toEqual(document())
    result.accept()
  })

  it.each([undefined, 1, 2, 3, 4, 5, 6, 7, 8])('adds an empty equipment list to project version %s', (version) => {
    const parsed = parseProjectDocument({ version, profiles: [] })
    expect(parsed.equipment).toEqual([])
    expect(parsed.version).toBe(PROJECT_VERSION)
    expect(JSON.parse(serializeProjectDocument({ profiles: [], connectors: [], panels: [], fittings: [] })).equipment).toEqual([])
  })

  it.each([1, 2, 3, 4, 5, 6])('reads share version %i without equipment', async (version) => {
    const old = version === 1 ? [1, [], [], [], []] : [version, 'posts', [], [], [], []]
    const restored = await decodeShare(await payload(old))
    expect(restored.equipment).toEqual([])
    expect(restored.version).toBe(PROJECT_VERSION)
  })

  it.each([undefined, {}, { back: 50 }])('defaults omitted clearance faces to zero (%j)', (clearance) => {
    const parsed = parseProjectDocument({ ...document(), equipment: [{ ...equipment(), clearance }] })
    expect(parsed.equipment[0].clearance).toEqual({ ...noClearance(), ...clearance })
  })

  it('normalizes omitted clearances before producing a share', async () => {
    const source = { ...document(), equipment: [{ ...equipment(), clearance: undefined }] }
    const decoded = await decodeShare(new URL(await encodeShareLink(source as never, 'https://example.com/')).hash.slice(3))
    expect(decoded.equipment[0].clearance).toEqual(noClearance())
  })

  it.each(['profiles', 'connectors', 'panels', 'fittings', 'equipment'] as const)('rejects a device ID shared with %s', async (kind) => {
    const doc = { ...boundProject(), equipment: [equipment('duplicate')] }
    if (kind === 'equipment') doc.equipment.push(equipment('duplicate'))
    else doc[kind][0].id = 'duplicate'
    expect(() => parseProjectDocument(doc)).toThrow('duplicate')
    await expect(encodeShareLink(doc, 'https://example.com/')).rejects.toThrow('duplicate')
  })

  it('rejects a binding that names equipment as its existing profile source', () => {
    const doc = { ...boundProject(), equipment: [equipment()] }
    doc.fittings[0].openingBinding!.opening.left.profileId = 'oven'
    expect(() => parseProjectDocument(doc)).toThrow('binding source type')
  })

  it('rejects duplicate device IDs in a compact share', async () => {
    const row = packedRow(equipment() as unknown as Record<string, unknown>)
    await expect(decodeShare(await payload([7, 'rails', [], [], [], [], [row, row]]))).rejects.toThrow('duplicate')
  })

  it.each([null, {}, 'devices'])('rejects a non-array equipment collection (%j)', async (bad) => {
    expect(() => parseProjectDocument({ ...document(), equipment: bad })).toThrow('equipment')
    await expect(decodeShare(await payload([7, 'rails', [], [], [], [], bad]))).rejects.toThrow('incomplete')
  })

  it.each([[], [7, 'rails', [], [], [], []], [7, 'rails', [], [], [], [], [[]]], [7, 'rails', [], [], [], [], [null]]].map((bad) => ({ bad })))
    ('rejects incomplete equipment shares ($bad)', async ({ bad }) => { await expect(decodeShare(await payload(bad))).rejects.toThrow() })
})

const badEquipment: Array<[string, Record<string, unknown>]> = [
  ['empty id', { id: ' ' }], ['missing name', { name: undefined }], ['empty name', { name: '\t' }], ['non-text name', { name: 6 }],
  ...['width', 'height', 'depth'].flatMap((key) => [0, -1, Infinity, NaN, '600'].map((value) => [`${key} ${value}`, { [key]: value }] as [string, Record<string, unknown>])),
  ['invalid position', { position: [0, 0] }], ['non-finite position', { position: [0, Infinity, 0] }],
  ['zero quaternion', { quaternion: [0, 0, 0, 0] }], ['overflowing quaternion norm', { quaternion: [1e308, 0, 0, 1] }],
  ['invalid quaternion', { quaternion: [0, 0, 1] }], ['non-boolean lock', { locked: 'yes' }],
  ['null clearance', { clearance: null }], ['array clearance', { clearance: [] }], ['unknown clearance face', { clearance: { ...noClearance(), rear: 5 } }],
  ...Object.keys(noClearance()).flatMap((key) => [-1, Infinity, NaN, '5'].map((value) => [`${key} clearance ${value}`, { clearance: { ...noClearance(), [key]: value } }] as [string, Record<string, unknown>])),
  ['overflowing envelope', { width: 1e308, clearance: { ...noClearance(), left: 1e308, right: 1e308 } }],
]

describe('equipment validation before loading', () => {
  it.each(badEquipment)('refuses %s in files and shares without changing the current project', async (_label, patch) => {
    useStore.getState().loadDocument(document())
    const before = useStore.getState(), bad = { ...equipment(), ...patch }
    const doc = { ...document(), equipment: [bad] }
    expect(() => parseProjectDocument(doc)).toThrow('Invalid project:')
    expect(() => serializeProjectDocument(doc as never)).toThrow('Invalid project:')
    expect(() => before.loadDocument(doc as never)).toThrow('Invalid project:')
    expect(useStore.getState()).toBe(before)
    await expect(encodeShareLink(doc as never, 'https://example.com/')).rejects.toThrow('Invalid project:')
    await expect(decodeShare(await payload([7, 'rails', [], [], [], [], [packedRow(bad)]]))).rejects.toThrow('Invalid project:')
    expect(useStore.getState()).toBe(before)
  })

  it.each(['openingBinding', 'runnerBinding', 'supportBinding'])('refuses equipment carrying a %s', (key) => {
    expect(() => parseProjectDocument({ ...document(), equipment: [{ ...equipment(), [key]: {} }] })).toThrow('binding')
  })
})

describe('equipment automatic saves', () => {
  it('writes equipment edits while skipping unchanged drawings, then reloads the complete device', async () => {
    vi.useFakeTimers()
    const values = new Map<string, string>()
    const disk = { getItem: (key: string) => values.get(key) ?? null,
      setItem: vi.fn((key: string, value: string) => { values.set(key, value) }), removeItem: vi.fn() }
    const storage = projectStorage(() => disk), source = document()
    storage.setItem('equipment-doc', { state: source, version: 0 })
    storage.flush()
    storage.setItem('equipment-doc', { state: { ...source }, version: 0 })
    vi.advanceTimersByTime(200)
    expect(disk.setItem).toHaveBeenCalledTimes(1)
    const edited = { ...source, equipment: [equipment('oven', { name: 'Replacement oven', width: 600 })] }
    storage.setItem('equipment-doc', { state: edited, version: 0 })
    vi.advanceTimersByTime(180)
    expect(disk.setItem).toHaveBeenCalledTimes(2)
    expect((await projectStorage(() => disk).getItem('equipment-doc'))?.state.equipment).toEqual(edited.equipment)
    const clearanceEdit = { ...edited, equipment: [{ ...edited.equipment[0], clearance: { ...edited.equipment[0].clearance, back: 75 } }] }
    storage.setItem('equipment-doc', { state: clearanceEdit, version: 0 })
    vi.advanceTimersByTime(180)
    expect(disk.setItem).toHaveBeenCalledTimes(3)
    expect((await projectStorage(() => disk).getItem('equipment-doc'))?.state.equipment).toEqual(clearanceEdit.equipment)
  })

  it('includes devices in the store persistence snapshot and clears them when opening an older empty project', () => {
    const source = document()
    useStore.getState().loadDocument(source)
    const state = useStore.getState(), persisted = useStore.persist.getOptions().partialize!(state)
    expect(persisted).toMatchObject({ version: PROJECT_VERSION, equipment: source.equipment })
    state.loadDocument({ profiles: [], connectors: [] })
    expect(useStore.getState().equipment).toEqual([])
    useStore.getState().undo()
    expect(useStore.getState().equipment).toEqual(source.equipment)
  })
})
