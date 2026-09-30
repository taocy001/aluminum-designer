import { beforeEach, describe, expect, it, vi } from 'vitest'
import deskFixture from '../../examples/desk-with-pedestal.json'
import { parseProjectDocument, serializeProjectDocument } from '../utils/document'
import { encodeShareLink, decodeShare } from '../utils/shareLink'
import { useStore } from '../store/useStore'
import { getThroughRule, computeAllTrims } from '../utils/jointUtils'
import { projectStorage, clearRejectedLocalProject, rejectedLocalProject } from '../utils/documentPersistence'
import { openProject, saveProject, forgetSavedFile, savedFileName } from '../utils/projectFile'

const empty = () => ({ profiles: [], connectors: [], panels: [], fittings: [], throughRule: 'rails' as const })
const desk = () => {
  const doc = parseProjectDocument(deskFixture)
  doc.panels.push({ id: 'test-board', width: 500, height: 300, thickness: 18, material: 'mdf',
    position: [2000, 0, 0], quaternion: [0, 0, 0, 1] })
  return doc
}
const packedPayload = async (packed: unknown) => {
  const stream = new Blob([JSON.stringify(packed)]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
beforeEach(() => {
  useStore.setState({ ...empty(), past: [], future: [], selectedIds: [] })
  forgetSavedFile()
  clearRejectedLocalProject()
  vi.unstubAllGlobals()
})

describe('one validated manufacturing document', () => {
  it('reads an old v1 share and migrates its fitting frame exactly once', async () => {
    const legacy = { profiles: [], connectors: [], panels: [], fittings: [{
      id: 'old', kind: 'door', width: 500, height: 700, depth: 400,
      position: [0, 400, 0], quaternion: [0, 0, 0, 1], material: 'mdf', open: 0,
    }] }
    const expected = parseProjectDocument(legacy)
    const oldLink = await packedPayload([1, [], [], [], [
      ['door', 500, 700, 400, [0, 400, 0], [0, 0, 0, 1], 'mdf', '', '', '', 0],
    ]])
    useStore.getState().loadDocument(await decodeShare(oldLink))
    expect(useStore.getState().fittings[0].frame).toBe(expected.fittings[0].frame)
    expect(useStore.getState().fittings[0].position).toEqual(expected.fittings[0].position)
    expect(useStore.getState().throughRule).toBe('rails')
  })

  it('refuses incomplete shares rather than replacing the project with an empty drawing', async () => {
    await expect(decodeShare(await packedPayload([1]))).rejects.toThrow('incomplete')
    await expect(decodeShare(await packedPayload([2, 'rails', [], [], []]))).rejects.toThrow('incomplete')
  })

  it('preserves current geometry, rules and locks through file and actual share loading', async () => {
    const source = desk()
    source.throughRule = 'posts'
    source.connectors[0].locked = true
    source.panels[0].locked = true
    source.fittings[0].locked = true
    const restored = parseProjectDocument(serializeProjectDocument(source))
    expect(restored).toEqual(source)
    const link = await encodeShareLink(source, 'https://example.com/')
    const shared = await decodeShare(new URL(link).hash.slice(3))
    useStore.getState().loadDocument(shared)
    const actual = useStore.getState()
    expect(actual.throughRule).toBe('posts')
    expect(actual.fittings.map(({ id, ...f }) => f)).toEqual(source.fittings.map(({ id, ...f }) => f))
    expect(actual.connectors[0].locked).toBe(true)
    expect(actual.panels[0].locked).toBe(true)
  })

  it.each([
    { profiles: [], connectors: [{ id: 'c1', type: 'inside-corner', position: [0, 0, 0] }] },
    { profiles: [], panels: [null] },
    { profiles: [{ id: 'p', spec: '2020', length: -2, position: [0, 0, 0], quaternion: [0, 0, 0, 1] }] },
    { profiles: [{ id: 'p', spec: '2020', length: 20, position: [0, '0', 0], quaternion: [0, 0, 0, 1] }] },
    { profiles: [], fittings: [{ id: 'f', kind: 'door', width: 500, height: 500, depth: 400,
      position: [0, 0, 0], quaternion: [0, 0, 0, 0], material: 'mdf', open: 0 }] },
    { version: 999, profiles: [] },
  ])('rejects malformed data atomically (%j)', (bad) => {
    const before = useStore.getState()
    expect(() => useStore.getState().loadDocument(bad as never)).toThrow()
    expect(useStore.getState()).toBe(before)
  })

  it('rejects ids shared across different part kinds', () => {
    const doc = desk()
    doc.panels[0].id = doc.profiles[0].id
    expect(() => parseProjectDocument(doc)).toThrow(/duplicate/)
  })

  it('restores manufacturing rules with undo and redo, including actual cut lengths', () => {
    const doc = desk()
    useStore.getState().loadDocument(doc)
    const old = [...computeAllTrims(useStore.getState().profiles).values()].map((t) => t.cutLength)
    useStore.getState().setThroughRule('posts')
    expect(getThroughRule()).toBe('posts')
    const changed = [...computeAllTrims(useStore.getState().profiles).values()].map((t) => t.cutLength)
    expect(changed).not.toEqual(old)
    useStore.getState().undo()
    expect(getThroughRule()).toBe('rails')
    expect([...computeAllTrims(useStore.getState().profiles).values()].map((t) => t.cutLength)).toEqual(old)
    useStore.getState().redo()
    expect(useStore.getState().throughRule).toBe('posts')
    expect(getThroughRule()).toBe('posts')
  })
})

describe('automatic save and recovery', () => {
  it('coalesces live updates, skips selection-only writes, and flushes the latest geometry', () => {
    vi.useFakeTimers()
    try {
      const setItem = vi.fn()
      const storage = projectStorage(() => ({ getItem: () => null, setItem, removeItem: vi.fn() }))
      const doc = desk()
      const persisted = (state = doc) => ({ state, version: 0 })
      storage.setItem('doc', persisted())
      storage.flush()
      expect(setItem).toHaveBeenCalledTimes(1)
      for (let i = 0; i < 2; i++) storage.setItem('doc', persisted({ ...doc }))
      vi.advanceTimersByTime(200)
      expect(setItem).toHaveBeenCalledTimes(1)
      for (let i = 0; i < 60; i++) storage.setItem('doc', persisted({ ...doc,
        profiles: doc.profiles.map((p, j) => j ? p : { ...p, length: p.length + i }) }))
      expect(setItem).toHaveBeenCalledTimes(1)
      storage.flush()
      expect(setItem).toHaveBeenCalledTimes(2)
      expect(JSON.parse(setItem.mock.calls[1][1]).state.profiles[0].length).toBe(doc.profiles[0].length + 59)
    } finally { vi.useRealTimers() }
  })

  it('keeps rejected original data available and hydrates a usable empty editor', () => {
    const raw = JSON.stringify({ state: { profiles: [], connectors: [{ id: 'c1' }] }, version: 0 })
    const setItem = vi.fn()
    const storage = projectStorage(() => ({ getItem: () => raw, setItem, removeItem: vi.fn() }))
    expect(storage.getItem('doc')).toBeNull()
    expect(rejectedLocalProject()).toBe(raw)
    expect(setItem).toHaveBeenCalledWith('doc:recovery', raw)
    expect(setItem.mock.calls.some(([key]) => key === 'doc')).toBe(false)
  })

  it('keeps the recovery copy across valid edits and reloads until explicitly cleared', async () => {
    const raw = '{broken original'
    const values = new Map<string, string>([['doc', raw]])
    const backing = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    }
    const first = projectStorage(() => backing)
    expect(first.getItem('doc')).toBeNull()
    first.setItem('doc', { state: desk(), version: 0 })
    first.flush()
    clearRejectedLocalProject()
    const reloaded = projectStorage(() => backing)
    expect((await reloaded.getItem('doc'))?.state.profiles.length).toBeGreaterThan(0)
    expect(rejectedLocalProject()).toBe(raw)
    reloaded.removeItem('doc')
    expect(values.size).toBe(0)
  })
})

describe('a file target is accepted only after successful import', () => {
  it('does not adopt a rejected JSON file as the next save target', async () => {
    const badWrite = vi.fn()
    const goodWrite = vi.fn()
    const handle = (name: string, write: typeof badWrite, text: string) => ({
      name, getFile: async () => ({ text: async () => text }),
      createWritable: async () => ({ write, close: async () => {} }),
    })
    const bad = handle('settings.json', badWrite, '{"unrelated":true}')
    const good = handle('drawing.json', goodWrite, '{}')
    vi.stubGlobal('window', { showOpenFilePicker: async () => [bad], showSaveFilePicker: async () => good })
    const opened = await openProject()
    expect(() => parseProjectDocument(opened!.text)).toThrow()
    expect(savedFileName()).toBeNull()
    expect((await saveProject(serializeProjectDocument(empty()), 'drawing.json')).outcome).toBe('saved')
    expect(badWrite).not.toHaveBeenCalled()
    expect(goodWrite).toHaveBeenCalledTimes(1)
  })

  it('adopts a successfully imported file for later save', async () => {
    const write = vi.fn()
    const h = { name: 'drawing.json', getFile: async () => ({ text: async () => serializeProjectDocument(empty()) }),
      createWritable: async () => ({ write, close: async () => {} }) }
    vi.stubGlobal('window', { showOpenFilePicker: async () => [h], showSaveFilePicker: vi.fn() })
    const opened = await openProject()
    parseProjectDocument(opened!.text)
    opened!.accept()
    expect(savedFileName()).toBe('drawing.json')
    expect((await saveProject(serializeProjectDocument(empty()), 'drawing.json')).outcome).toBe('overwritten')
    expect(write).toHaveBeenCalledTimes(1)
  })
})
