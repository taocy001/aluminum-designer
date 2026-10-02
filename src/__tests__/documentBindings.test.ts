import { beforeEach, describe, expect, it } from 'vitest'
import { parseProjectDocument, serializeProjectDocument, PROJECT_VERSION, type ProjectDocument } from '../utils/document'
import { encodeShareLink, decodeShare } from '../utils/shareLink'
import { remapCopiedBindings } from '../utils/bindingCopies'
import { resolveOpening } from '../utils/openingBindings'
import { useStore } from '../store/useStore'
import { boundProject, identity, openingRef } from './fixtures/bindings'

const payload = async (packed: unknown) => {
  const stream = new Blob([JSON.stringify(packed)]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const packed = (doc: ProjectDocument): unknown[][] => [
  doc.profiles.map((p) => [p.spec, p.length, p.position, p.quaternion, p.locked ?? false, p.miterCuts, p.holes, p.fixedTrims ?? null, p.id, p.runnerBinding ?? null]),
  doc.connectors.map((c) => [c.type, c.series, c.position, c.quaternion, c.locked ?? false, c.id, c.supportBinding ?? null]),
  doc.panels.map((b) => [b.width, b.height, b.thickness, b.position, b.quaternion, b.material, b.locked ?? false, b.id, b.openingBinding ?? null]),
  doc.fittings.map((f) => [f.kind, f.width, f.height, f.depth, f.position, f.quaternion, f.material, f.hinge ?? '', f.hingeType ?? '', f.overlay ?? '',
    f.swing ?? 0, f.frame, f.stacked ?? null, f.locked ?? false, f.meeting ?? '', f.drawer ?? null, f.id, f.openingBinding ?? null]),
]
const decode = async (doc: ProjectDocument) => decodeShare(new URL(await encodeShareLink(doc, 'https://example.com/')).hash.slice(3))
const ref = openingRef()
const drawerBinding = { opening: ref, mode: 'drawer', bottomOffset: 0 }
const doorBinding = { opening: ref, mode: 'door', start: 0, end: 1 }
const panelBinding = { opening: ref, mode: 'front', margins: { left: 0, right: 0, bottom: 0, top: 0 }, normalOffset: 0 }
const runnerBinding = { fittingId: 'drawer', side: 'left', backOffset: 0, frontOffset: 0 }
const supportBinding = { profileId: 'runner', end: 'start', localPosition: [0, 0, 0], localQuaternion: identity }

beforeEach(() => useStore.setState({ profiles: [], connectors: [], panels: [], fittings: [], throughRule: 'rails', past: [], future: [], selectedIds: [] }))

describe('persisted assembly bindings', () => {
  it.each(['file', 'share'] as const)('preserves all entity IDs, bindings and stored geometry through %s', async (via) => {
    const source = boundProject()
    const copies = {
      profiles: source.profiles.map((part) => ({ ...part, id: `${part.id}: 柜|%\n\"` })),
      connectors: source.connectors.map((part) => ({ ...part, id: `${part.id}: 柜|%\n\"` })),
      panels: source.panels.map((part) => ({ ...part, id: `${part.id}: 柜|%\n\"` })),
      fittings: source.fittings.map((part) => ({ ...part, id: `${part.id}: 柜|%\n\"` })),
    }
    const current = { ...remapCopiedBindings(source, copies), throughRule: source.throughRule }
    const restored = via === 'file' ? parseProjectDocument(serializeProjectDocument(current)) : await decode(current)
    expect(restored).toEqual({ ...current, version: PROJECT_VERSION })
    expect(parseProjectDocument(restored)).toEqual(restored)
    expect(resolveOpening(restored.fittings[0].openingBinding!.opening, restored.profiles, restored.throughRule).status).toBe('resolved')
  })

  it.each(['file', 'share'] as const)('retains missing references and their last stored geometry through %s', async (via) => {
    const doc = boundProject()
    doc.profiles = doc.profiles.filter((part) => part.id !== 'back' && part.id !== 'runner')
    doc.fittings = doc.fittings.filter((part) => part.id !== 'drawer')
    const restored = via === 'file' ? parseProjectDocument(serializeProjectDocument(doc)) : await decode(doc)
    expect(restored).toEqual({ ...doc, version: PROJECT_VERSION })
    expect(resolveOpening(restored.fittings[0].openingBinding!.opening, restored.profiles, restored.throughRule))
      .toEqual({ status: 'missing-source', sourceIds: ['back'] })
    expect(restored.connectors[0].supportBinding!.profileId).toBe('runner')
  })

  it('retains a runner whose drawer was removed', async () => {
    const doc = boundProject()
    doc.fittings = doc.fittings.filter((part) => part.id !== 'drawer')
    expect((await decode(doc)).profiles.at(-1)!.runnerBinding).toEqual(doc.profiles.at(-1)!.runnerBinding)
  })

  it('retains derived opening sources as an invalid relationship for inspection', () => {
    const doc = boundProject()
    doc.fittings[1].openingBinding!.opening.left.profileId = 'runner'
    const restored = parseProjectDocument(serializeProjectDocument(doc))
    expect(resolveOpening(restored.fittings[1].openingBinding!.opening, restored.profiles, restored.throughRule))
      .toMatchObject({ status: 'invalid', reason: 'derived-source' })
  })

  it.each([6, 7])('reads version %i without inferring absent frame or adjacency', (version) => {
    const doc = boundProject()
    doc.fittings = [doc.fittings[0], { ...doc.fittings[0], id: 'another', position: [0, 320, -250] }]
    for (const f of doc.fittings) { delete f.frame; delete f.openingBinding }
    const restored = parseProjectDocument({ ...doc, version })
    expect(restored.fittings).toEqual(doc.fittings)
    expect(restored.fittings.every((f) => f.frame === undefined && f.stacked === undefined)).toBe(true)
  })

  it('reads v5 shares with their original drawer options and no repeated migration', async () => {
    const source = boundProject().fittings[0]
    delete source.frame
    const row = [source.kind, source.width, source.height, source.depth, source.position, source.quaternion, source.material,
      '', '', '', 0, null, null, false, '', source.drawer]
    const restored = await decodeShare(await payload([5, 'rails', [], [], [], [row]]))
    expect(restored.fittings[0]).toMatchObject({ id: 'f-s0', drawer: source.drawer, position: source.position })
    expect(restored.fittings[0].frame).toBeUndefined()
    expect(restored.fittings[0].openingBinding).toBeUndefined()
  })

  it.each(['profiles', 'connectors', 'panels', 'fittings'] as const)('rejects a %s ID duplicated across entity kinds in files and shares', async (kind) => {
    const doc = boundProject()
    if (kind === 'profiles') doc.profiles[0].id = doc.connectors[0].id
    else doc[kind][0].id = doc.profiles[0].id
    expect(() => parseProjectDocument({ ...doc, version: 8 })).toThrow('duplicate')
    await expect(decodeShare(await payload([6, 'rails', ...packed(doc)]))).rejects.toThrow('duplicate')
  })

  it.each([[0, 8], [1, 5], [2, 7], [3, 16]])('requires the original ID in v6 share entity %i', async (kind, column) => {
    const rows = packed(boundProject())
    ;(rows[kind][0] as unknown[])[column] = null
    await expect(decodeShare(await payload([6, 'rails', ...rows]))).rejects.toThrow('part id')
  })
})

const invalid: Array<[string, keyof ProjectDocument, number, string, unknown]> = [
  ...[null, [], {}, { ...drawerBinding, extra: 1 }, { ...drawerBinding, bottomOffset: -1 }, { ...drawerBinding, bottomOffset: Infinity },
    doorBinding, { ...drawerBinding, opening: { ...ref, back: undefined } },
    { ...drawerBinding, opening: { ...ref, fixedDepth: 500 } },
    { ...drawerBinding, opening: { ...ref, back: undefined, fixedDepth: 0 } },
    { ...drawerBinding, opening: { ...ref, back: undefined, fixedDepth: Infinity } },
    { ...drawerBinding, opening: { ...ref, unexpected: true } },
    { ...drawerBinding, opening: { ...ref, left: { profileId: 'left', axis: 3, side: 1 } } },
    { ...drawerBinding, opening: { ...ref, left: { profileId: 'left', axis: 0, side: 0 } } },
    { ...drawerBinding, opening: { ...ref, left: { profileId: ' ', axis: 0, side: 1 } } },
    { ...drawerBinding, opening: { ...ref, left: { ...ref.left, extra: 1 } } },
  ].map((v, i) => [`drawer binding ${i}`, 'fittings', 0, 'openingBinding', v] as [string, keyof ProjectDocument, number, string, unknown]),
  ...[{ ...doorBinding, start: -0.1 }, { ...doorBinding, end: 1.1 }, { ...doorBinding, start: 1 },
    { ...doorBinding, end: Infinity }, { ...doorBinding, extra: 1 }, drawerBinding,
  ].map((v, i) => [`door binding ${i}`, 'fittings', 1, 'openingBinding', v] as [string, keyof ProjectDocument, number, string, unknown]),
  ...[{ ...panelBinding, mode: 'other' }, { ...panelBinding, margins: { left: 0 } },
    { ...panelBinding, margins: { ...panelBinding.margins, top: NaN } },
    { ...panelBinding, margins: { ...panelBinding.margins, extra: 1 } },
    { ...panelBinding, normalOffset: Infinity }, { ...panelBinding, extra: 1 },
  ].map((v, i) => [`panel binding ${i}`, 'panels', 0, 'openingBinding', v] as [string, keyof ProjectDocument, number, string, unknown]),
  ...[{ ...runnerBinding, fittingId: '' }, { ...runnerBinding, side: 'top' }, { ...runnerBinding, backOffset: NaN },
    { ...runnerBinding, frontOffset: Infinity }, { ...runnerBinding, extra: 1 },
  ].map((v, i) => [`runner binding ${i}`, 'profiles', 5, 'runnerBinding', v] as [string, keyof ProjectDocument, number, string, unknown]),
  ...[{ ...supportBinding, profileId: ' ' }, { ...supportBinding, end: 'middle' }, { ...supportBinding, localPosition: [0, 0] },
    { ...supportBinding, localPosition: [0, Infinity, 0] }, { ...supportBinding, localQuaternion: [0, 0, 0, 0] },
    { ...supportBinding, localQuaternion: [1e308, 1e308, 0, 0] }, { ...supportBinding, extra: 1 },
  ].map((v, i) => [`support binding ${i}`, 'connectors', 0, 'supportBinding', v] as [string, keyof ProjectDocument, number, string, unknown]),
  ['wrong profile field', 'profiles', 0, 'openingBinding', drawerBinding],
  ['wrong panel field', 'panels', 0, 'supportBinding', supportBinding],
  ['wrong fitting field', 'fittings', 0, 'runnerBinding', runnerBinding],
  ['wrong connector field', 'connectors', 0, 'openingBinding', panelBinding],
]

describe('binding validation at persistence boundaries', () => {
  it.each(invalid)('rejects %s without replacing store or history', async (_label, kind, index, key, value) => {
    const doc = boundProject()
    ;(doc[kind] as unknown as Record<string, unknown>[])[index][key] = value
    const before = useStore.getState()
    expect(() => useStore.getState().loadDocument({ ...doc, version: 8 })).toThrow('binding')
    expect(useStore.getState()).toBe(before)
    expect(() => serializeProjectDocument(doc)).toThrow('binding')
    await expect(encodeShareLink(doc, 'https://example.com/')).rejects.toThrow('binding')
    // Compact rows expose only the binding belonging to each entity kind.
    if (value !== null && key === (kind === 'profiles' ? 'runnerBinding' : kind === 'connectors' ? 'supportBinding' : 'openingBinding')) {
      await expect(decodeShare(await payload([6, 'rails', ...packed(doc)]))).rejects.toThrow('binding')
    }
  })

  it.each(['opening-to-drawer', 'opening-to-connector', 'runner-to-door', 'runner-to-profile', 'support-to-panel'])('rejects an existing source of the wrong kind: %s', async (kind) => {
    const doc = boundProject()
    if (kind.startsWith('opening')) doc.fittings[0].openingBinding!.opening.left.profileId = kind.endsWith('drawer') ? 'drawer' : 'support'
    else if (kind.startsWith('runner')) doc.profiles.at(-1)!.runnerBinding!.fittingId = kind.endsWith('door') ? 'door' : 'left'
    else doc.connectors[0].supportBinding!.profileId = 'panel'
    expect(() => parseProjectDocument({ ...doc, version: 8 })).toThrow('binding source type')
    await expect(decodeShare(await payload([6, 'rails', ...packed(doc)]))).rejects.toThrow('binding source type')
  })
})
