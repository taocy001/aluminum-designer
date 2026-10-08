import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectDocument } from '../utils/document'
import { clearRejectedLocalProject, projectStorage, rejectedLocalProject } from '../utils/documentPersistence'

const drawing = (length = 600): ProjectDocument => ({
  profiles: [{ id: 'beam', spec: '2020', length, position: [0, 0, 0], quaternion: [0, 0, 0, 1], miterCuts: [], holes: [] }],
  connectors: [], panels: [], fittings: [], throughRule: 'rails',
})
const value = (state = drawing()) => ({ state, version: 0 })
const backing = () => {
  const data = new Map<string, string>()
  return { data, getItem: (key: string) => data.get(key) ?? null,
    setItem: vi.fn((key: string, text: string) => { data.set(key, text) }),
    removeItem: vi.fn((key: string) => { data.delete(key) }) }
}

beforeEach(() => { vi.useFakeTimers(); clearRejectedLocalProject() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('automatic save failures and retries', () => {
  it('retains a failed write and retries the same drawing without polling', () => {
    const disk = backing()
    disk.setItem.mockImplementationOnce(() => { throw new Error('quota exceeded') })
    const storage = projectStorage(() => disk)
    const statuses: string[] = []
    storage.subscribe(() => statuses.push(storage.getStatus()))
    const doc = value()
    storage.setItem('project', doc)
    expect(storage.getStatus()).toBe('pending')
    vi.advanceTimersByTime(180)
    expect(storage.getStatus()).toBe('error')
    expect(disk.data.has('project')).toBe(false)
    vi.advanceTimersByTime(60_000)
    expect(disk.setItem).toHaveBeenCalledTimes(1)
    storage.flush()
    expect(storage.getStatus()).toBe('saved')
    expect(JSON.parse(disk.data.get('project')!)).toEqual(doc)
    storage.flush()
    expect(disk.setItem).toHaveBeenCalledTimes(2)
    expect(statuses).toEqual(['pending', 'error', 'saved'])
  })

  it('allows the identical content to be queued again after a write failure', () => {
    const disk = backing()
    disk.setItem.mockImplementationOnce(() => { throw new Error('write blocked') })
    const storage = projectStorage(() => disk)
    const doc = value()
    storage.setItem('project', doc)
    storage.flush()
    storage.setItem('project', { ...doc, state: { ...doc.state } })
    expect(storage.getStatus()).toBe('error')
    vi.advanceTimersByTime(180)
    expect(storage.getStatus()).toBe('saved')
    expect(JSON.parse(disk.data.get('project')!)).toEqual(doc)
  })

  it('replaces failed data with later edits and keeps the failure visible until success', () => {
    const disk = backing()
    const storage = projectStorage(() => disk)
    storage.setItem('project', value(drawing(600)))
    storage.flush()
    disk.setItem.mockImplementationOnce(() => { throw new Error('full') })
    storage.setItem('project', value(drawing(700)))
    storage.flush()
    expect(JSON.parse(disk.data.get('project')!).state.profiles[0].length).toBe(600)
    storage.setItem('project', value(drawing(800)))
    vi.advanceTimersByTime(100)
    storage.setItem('project', value(drawing(900)))
    expect(storage.getStatus()).toBe('error')
    vi.advanceTimersByTime(179)
    expect(disk.setItem).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1)
    expect(storage.getStatus()).toBe('saved')
    expect(JSON.parse(disk.data.get('project')!).state.profiles[0].length).toBe(900)
    expect(disk.setItem).toHaveBeenCalledTimes(3)
  })

  it.each(['missing', 'access-denied'] as const)('reports %s storage and saves retained data when it becomes available', (kind) => {
    const disk = backing()
    let available = false
    const storage = projectStorage(() => {
      if (available) return disk
      if (kind === 'access-denied') throw new Error('storage access denied')
      return null
    })
    expect(storage.getItem('project')).toBeNull()
    expect(storage.getStatus()).toBe('unavailable')
    const doc = value()
    storage.setItem('project', doc)
    storage.flush()
    expect(storage.getStatus()).toBe('unavailable')
    expect(disk.setItem).not.toHaveBeenCalled()
    expect(rejectedLocalProject()).toBeNull()
    available = true
    storage.flush()
    expect(storage.getStatus()).toBe('saved')
    expect(JSON.parse(disk.data.get('project')!)).toEqual(doc)
  })

  it('reports blocked reads as unavailable rather than corrupt project data', () => {
    const disk = backing()
    const storage = projectStorage(() => ({ ...disk, getItem: () => { throw new Error('blocked') } }))
    expect(storage.getItem('project')).toBeNull()
    expect(storage.getStatus()).toBe('unavailable')
    expect(rejectedLocalProject()).toBeNull()
  })
})

describe('successful save tracking', () => {
  it('does not postpone or duplicate a write for selection/history-only changes', () => {
    const disk = backing()
    const storage = projectStorage(() => disk)
    const doc = value()
    storage.setItem('project', doc)
    vi.advanceTimersByTime(120)
    storage.setItem('project', { ...doc, state: { ...doc.state } })
    vi.advanceTimersByTime(60)
    expect(disk.setItem).toHaveBeenCalledTimes(1)
    expect(storage.getStatus()).toBe('saved')
    for (let i = 0; i < 5; i++) storage.setItem('project', { ...doc, state: { ...doc.state } })
    vi.advanceTimersByTime(1000)
    expect(disk.setItem).toHaveBeenCalledTimes(1)
  })

  it('cancels unsaved edits when undo returns to the exact saved drawing', () => {
    const disk = backing()
    const storage = projectStorage(() => disk)
    const saved = value()
    storage.setItem('project', saved)
    storage.flush()
    storage.setItem('project', value(drawing(900)))
    storage.setItem('project', saved)
    vi.advanceTimersByTime(1000)
    expect(storage.getStatus()).toBe('saved')
    expect(disk.setItem).toHaveBeenCalledTimes(1)
    expect(JSON.parse(disk.data.get('project')!)).toEqual(saved)
  })

  it('does not deduplicate a different project key or persistence version', () => {
    const disk = backing()
    const storage = projectStorage(() => disk)
    const doc = value()
    storage.setItem('project', doc)
    storage.flush()
    storage.setItem('other-project', doc)
    storage.flush()
    storage.setItem('other-project', { ...doc, version: 1 })
    storage.flush()
    expect(disk.setItem).toHaveBeenCalledTimes(3)
    expect(JSON.parse(disk.data.get('other-project')!).version).toBe(1)
  })

  it('recognizes validated saved data without rewriting it and keeps corruption recovery separate', async () => {
    const disk = backing()
    disk.data.set('project', JSON.stringify(value()))
    const storage = projectStorage(() => disk)
    const loaded = await storage.getItem('project')
    expect(storage.getStatus()).toBe('saved')
    storage.setItem('project', loaded!)
    storage.flush()
    expect(disk.setItem).not.toHaveBeenCalled()
    disk.data.set('project', '{broken')
    const recovery = projectStorage(() => disk)
    expect(recovery.getItem('project')).toBeNull()
    expect(recovery.getStatus()).toBe('idle')
    expect(rejectedLocalProject()).toBe('{broken')
  })

  it('notifies only real state transitions and supports unsubscribing', () => {
    const disk = backing()
    const storage = projectStorage(() => disk)
    const listener = vi.fn()
    const unsubscribe = storage.subscribe(listener)
    storage.setItem('project', value())
    storage.setItem('project', value(drawing(700)))
    expect(listener).toHaveBeenCalledTimes(1)
    storage.flush()
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    storage.setItem('project', value(drawing(800)))
    storage.flush()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('does not resurrect pending or failed data after explicitly clearing storage', () => {
    const disk = backing()
    disk.setItem.mockImplementationOnce(() => { throw new Error('quota exceeded') })
    const storage = projectStorage(() => disk)
    storage.setItem('project', value())
    storage.flush()
    storage.removeItem('project')
    storage.flush()
    vi.advanceTimersByTime(1000)
    expect(storage.getStatus()).toBe('idle')
    expect(disk.setItem).toHaveBeenCalledTimes(1)
    expect(disk.data.has('project')).toBe(false)
  })
})

describe('current project file name', () => {
  it('persists a name change without geometry changes and restores only the name, not a disk handle', () => {
    const disk = backing()
    const storage = projectStorage(() => disk)
    const doc = drawing()
    storage.setItem('project', value({ ...doc, projectName: 'first.json' } as ProjectDocument))
    storage.flush()
    storage.setItem('project', value({ ...doc, projectName: 'second.json' } as ProjectDocument))
    storage.flush()
    expect(disk.setItem).toHaveBeenCalledTimes(2)
    expect(storage.getItem('project')).toMatchObject({ state: { projectName: 'second.json', profiles: doc.profiles } })
  })

  it('does not restore a path as a file name', () => {
    const disk = backing()
    disk.data.set('project', JSON.stringify(value({ ...drawing(), projectName: '/private/file.json' } as ProjectDocument)))
    expect(projectStorage(() => disk).getItem('project')).not.toHaveProperty('state.projectName')
  })
})
