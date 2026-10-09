import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProjectSession, projectSession } from '../utils/projectSession'
import { useStore } from '../store/useStore'
import { savedFileName, rememberOpenedFile } from '../utils/projectFile'
import type { ProjectDocument } from '../utils/document'

const doc = (length = 300): ProjectDocument => ({ throughRule: 'rails', profiles: [
  { id: 'p', spec: '2020', length, position: [0, 0, 0], quaternion: [0, 0, 0, 1], holes: [], miterCuts: [] },
], panels: [], connectors: [], fittings: [], equipment: [] })
const memory = () => {
  const values = new Map<string, string>()
  return { get length() { return values.size }, key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('document sessions', () => {
  it('keeps edits and undo inside the opened document, including its file identity', () => {
    useStore.getState().loadDocument(doc(), { name: 'A.json', saved: true })
    useStore.getState().commitProfileEdit('p', { length: 320 })
    expect(projectSession.getState().dirty).toBe(true)
    useStore.getState().loadDocument(doc(500), { name: 'B.json', saved: true })
    rememberOpenedFile('B.json')
    expect(useStore.getState().past).toEqual([])
    expect(useStore.getState().future).toEqual([])
    useStore.getState().undo()
    expect(useStore.getState().profiles[0].length).toBe(500)
    expect(useStore.getState().projectName).toBe('B.json')
    expect(savedFileName()).toBe('B.json')
    expect(projectSession.getState().dirty).toBe(false)
    useStore.getState().commitProfileEdit('p', { length: 540 })
    expect(projectSession.getState().dirty).toBe(true)
    useStore.getState().undo()
    expect(projectSession.getState().dirty).toBe(false)
    useStore.getState().redo()
    expect(projectSession.getState().dirty).toBe(true)
  })

  it('retains independent drafts with original baselines across switches and reload', () => {
    vi.useFakeTimers()
    const storage = memory(), session = createProjectSession(() => storage)
    session.start(doc(), { name: 'A.json', saved: true })
    const a = session.getState().id
    session.update(doc(350), 'A.json')
    expect(session.keepDraft()).toBe(true)
    session.start(doc(500), { name: 'B.json', saved: true })
    session.keepDraft()
    const [draft] = session.listDrafts()
    expect(draft.id).toBe(a)
    expect(draft.document.profiles[0].length).toBe(350)
    session.start(draft.document, { draft })
    expect(session.getState().dirty).toBe(true)
    session.keepDraft()
    const reload = createProjectSession(() => storage)
    reload.initialize(draft.document, 'A.json')
    expect(reload.getState().id).toBe(a)
    expect(reload.getState().dirty).toBe(true)
    reload.update(doc(), 'A.json')
    expect(reload.getState().dirty).toBe(false)
  })

  it('only advances the saved baseline to the document actually written in the same session', () => {
    vi.useFakeTimers()
    const storage = memory(), session = createProjectSession(() => storage)
    session.start(doc(), { saved: true })
    const a = session.getState().id
    session.update(doc(350), 'A.json')
    session.update(doc(400), 'A.json') // edit while an asynchronous save writes 350
    session.markSaved(doc(350), a)
    expect(session.getState().dirty).toBe(true)
    session.update(doc(350), 'A.json')
    expect(session.getState().dirty).toBe(false)
    session.start(doc(500), { name: 'B.json' })
    expect(session.markSaved(doc(400), a)).toBe(false)
    expect(session.getState().dirty).toBe(true)
  })

  it('does not overwrite another draft when the active pointer and restored document differ', () => {
    vi.useFakeTimers()
    const storage = memory(), first = createProjectSession(() => storage)
    first.start(doc(300), { name: 'A.json', saved: true })
    first.update(doc(350), 'A.json')
    first.keepDraft()
    const a = first.getState().id
    const reloaded = createProjectSession(() => storage)
    reloaded.initialize(doc(500), 'B.json')
    expect(reloaded.getState().id).not.toBe(a)
    reloaded.keepDraft()
    const [draft] = reloaded.listDrafts()
    expect(draft.id).toBe(a)
    expect(draft.name).toBe('A.json')
    expect(draft.document.profiles[0].length).toBe(350)
  })

  it('retains the document when a pending switch is cancelled or storage is full', () => {
    vi.useFakeTimers()
    const storage = memory(), session = createProjectSession(() => storage)
    session.start(doc(), { saved: true })
    session.update(doc(350), 'A.json')
    const replace = vi.fn()
    session.requestReplacement(replace)
    expect(replace).not.toHaveBeenCalled()
    session.cancelReplacement()
    expect(session.getState().dirty).toBe(true)
    expect(replace).not.toHaveBeenCalled()
    storage.setItem = () => { throw new Error('QuotaExceededError') }
    expect(session.keepDraft()).toBe(false)
    expect(session.getState().storageError).toBe(true)
    expect(session.getState().dirty).toBe(true)
    expect(session.getState().current).toContain('350')
  })

  it('does not serialize selection or history and does not treat save timestamps as changes', () => {
    useStore.getState().loadDocument(doc(), { saved: true })
    const before = projectSession.getState()
    useStore.getState().selectItem('p')
    useStore.getState().snapshotHistory()
    expect(projectSession.getState()).toBe(before)
    expect(projectSession.getState().dirty).toBe(false)
  })
})
