import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forgetSavedFile, openProject, savedFileName, saveProject } from '../utils/projectFile'

const fileHandle = (name: string, text = '{}') => ({
  name,
  getFile: vi.fn(async () => ({ text: async () => text })),
  createWritable: vi.fn(async () => ({ write: vi.fn(), close: vi.fn() })),
})

beforeEach(async () => {
  forgetSavedFile()
  vi.stubGlobal('window', { showOpenFilePicker: async () => [fileHandle('original.json')] })
  const original = await openProject()
  if (original.outcome !== 'opened') throw new Error('expected the original file')
  original.accept()
})

afterEach(() => {
  forgetSavedFile()
  vi.unstubAllGlobals()
})

describe('native project opening outcomes', () => {
  it.each([undefined, null, {}])('reports unavailable picker %s without losing the save target', async (picker) => {
    vi.stubGlobal('window', { showOpenFilePicker: picker })
    expect(await openProject()).toEqual({ outcome: 'unsupported' })
    expect(savedFileName()).toBe('original.json')
  })

  it('treats a dismissed picker as cancellation and keeps the previous save target', async () => {
    const picker = vi.fn(async () => { throw new DOMException('Dismissed', 'AbortError') })
    vi.stubGlobal('window', { showOpenFilePicker: picker })
    expect(await openProject()).toEqual({ outcome: 'cancelled' })
    expect(picker).toHaveBeenCalledTimes(1)
    expect(savedFileName()).toBe('original.json')
  })

  it('reports a picker error without losing the save target', async () => {
    vi.stubGlobal('window', { showOpenFilePicker: async () => { throw new DOMException('Denied', 'NotAllowedError') } })
    expect(await openProject()).toEqual({ outcome: 'failed' })
    expect(savedFileName()).toBe('original.json')
  })

  it('reports an empty picker result as failure', async () => {
    vi.stubGlobal('window', { showOpenFilePicker: async () => [] })
    expect(await openProject()).toEqual({ outcome: 'failed' })
    expect(savedFileName()).toBe('original.json')
  })

  it.each(['getFile', 'text'])('reports %s AbortError as a read failure and can still save to the original file', async (phase) => {
    const candidate = fileHandle('unreadable.json')
    const fail = async (): Promise<never> => { throw new DOMException('Read aborted', 'AbortError') }
    candidate.getFile.mockImplementation(phase === 'getFile' ? fail : async () => ({ text: fail }))
    const savePicker = vi.fn()
    vi.stubGlobal('window', { showOpenFilePicker: async () => [candidate], showSaveFilePicker: savePicker })
    expect(await openProject()).toEqual({ outcome: 'failed' })
    expect(savedFileName()).toBe('original.json')
    expect(await saveProject('current drawing', 'fallback.json')).toEqual({ outcome: 'overwritten', name: 'original.json' })
    expect(savePicker).not.toHaveBeenCalled()
    expect(candidate.createWritable).not.toHaveBeenCalled()
  })

  it('reads a file without changing the save target until the caller accepts it', async () => {
    const candidate = fileHandle('next.json', '{"profiles":[]}')
    vi.stubGlobal('window', { showOpenFilePicker: async () => [candidate] })
    const opened = await openProject()
    if (opened.outcome !== 'opened') throw new Error('expected an opened file')
    expect(opened.text).toBe('{"profiles":[]}')
    expect(opened.name).toBe('next.json')
    expect(savedFileName()).toBe('original.json')
    opened.accept()
    expect(savedFileName()).toBe('next.json')
  })
})

describe('saving a project', () => {
  it.each(['write', 'close'])('reports %s AbortError as a failure and preserves the original target', async phase => {
    const chosen = fileHandle('copy.json')
    const write = vi.fn(), close = vi.fn()
    ;(phase === 'write' ? write : close).mockRejectedValue(new DOMException('Write aborted', 'AbortError'))
    chosen.createWritable.mockResolvedValue({ write, close })
    vi.stubGlobal('window', { showSaveFilePicker: async () => chosen })
    expect(await saveProject('contents', 'copy.json', true)).toEqual({ outcome: 'failed' })
    expect(savedFileName()).toBe('original.json')
    expect((await saveProject('contents', 'original.json')).outcome).toBe('overwritten')
  })

  it('keeps the original target when Save as is cancelled or writing fails', async () => {
    const picker = vi.fn(async (): Promise<ReturnType<typeof fileHandle>> => { throw new DOMException('Cancelled', 'AbortError') })
    vi.stubGlobal('window', { showSaveFilePicker: picker })
    expect(await saveProject('data', 'copy.json', true)).toEqual({ outcome: 'cancelled' })
    expect(savedFileName()).toBe('original.json')
    const broken = fileHandle('broken.json')
    broken.createWritable.mockRejectedValue(new Error('permission denied'))
    picker.mockResolvedValue(broken)
    expect(await saveProject('data', 'copy.json', true)).toEqual({ outcome: 'failed' })
    expect(savedFileName()).toBe('original.json')
    expect((await saveProject('data', 'copy.json')).outcome).toBe('overwritten')
  })

  it('adopts the chosen file only after writing and closing it successfully', async () => {
    const chosen = fileHandle('chosen.json')
    const write = vi.fn(), close = vi.fn()
    chosen.createWritable.mockResolvedValue({ write, close })
    vi.stubGlobal('window', { showSaveFilePicker: async () => chosen })
    expect(await saveProject('contents', 'suggested.json', true)).toEqual({ outcome: 'saved', name: 'chosen.json' })
    expect(write).toHaveBeenCalledWith('contents')
    expect(close).toHaveBeenCalledTimes(1)
    expect(savedFileName()).toBe('chosen.json')
  })
})
