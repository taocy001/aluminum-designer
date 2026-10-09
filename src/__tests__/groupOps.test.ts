import { beforeEach, describe, expect, it } from 'vitest'
import { useStore, type PanelData } from '../store/useStore'
import { createSelectedGroup, dissolveGroup, renameGroup } from '../utils/groupOps'
import { copySelected, duplicateSelected, pasteCopied } from '../utils/editOps'
import { beginTransformGesture, transformGestureActive } from '../utils/transformGesture'
import { useToolStore } from '../store/useToolStore'

const panel = (id: string, x: number): PanelData => ({ id, width: 100, height: 100, thickness: 18, material: 'mdf', position: [x, 100, 0], quaternion: [0, 0, 0, 1] })
beforeEach(() => {
  useToolStore.setState({ viewMode: false })
  useStore.setState({ profiles: [], connectors: [], panels: [panel('a', 0), panel('b', 300)], fittings: [], equipment: [], groups: [], templateInstances: [], selectedIds: ['a', 'b'], past: [], future: [] })
})
describe('persistent part groups', () => {
  it('creates, renames and dissolves groups with one undo step each and no part changes', () => {
    const parts = useStore.getState().panels
    expect(createSelectedGroup(' Frame ')).toBe(true)
    const group = useStore.getState().groups[0]
    expect(group).toMatchObject({ name: 'Frame', memberIds: ['a', 'b'] })
    expect(useStore.getState().past).toHaveLength(1)
    useStore.getState().undo()
    expect(useStore.getState().groups).toEqual([])
    useStore.getState().redo()
    expect(renameGroup(group.id, 'Shelf')).toBe(true)
    expect(useStore.getState().groups[0].name).toBe('Shelf')
    useStore.getState().undo()
    expect(useStore.getState().groups[0].name).toBe('Frame')
    expect(dissolveGroup(group.id)).toBe(true)
    expect(useStore.getState().groups).toEqual([])
    expect(useStore.getState().panels).toEqual(parts)
    useStore.getState().undo()
    expect(useStore.getState().groups).toEqual([group])
  })
  it('rejects empty names and fewer than two live selected members', () => {
    expect(createSelectedGroup(' ')).toBe(false)
    useStore.setState({ selectedIds: ['a', 'missing', 'a'] })
    expect(createSelectedGroup('Frame')).toBe(false)
    expect(useStore.getState().past).toEqual([])
  })
  it('does not create history for unchanged names and prevents editing in read-only mode', () => {
    createSelectedGroup('Frame')
    const group = useStore.getState().groups[0]
    renameGroup(group.id, ' Frame ')
    expect(useStore.getState().past).toHaveLength(1)
    useToolStore.setState({ viewMode: true })
    expect(createSelectedGroup('Other')).toBe(false)
    expect(renameGroup(group.id, 'Other')).toBe(false)
    expect(dissolveGroup(group.id)).toBe(false)
    expect(useStore.getState().groups).toEqual([group])
    expect(useStore.getState().past).toHaveLength(1)
  })
  it('cancels provisional transforms before grouping', () => {
    const parts = useStore.getState().panels
    beginTransformGesture()
    useStore.setState({ panels: parts.map(p => ({ ...p, position: [p.position[0] + 10, 100, 0] })) })
    expect(createSelectedGroup('Frame')).toBe(true)
    expect(transformGestureActive()).toBe(false)
    expect(useStore.getState().panels).toEqual(parts)
    useStore.getState().undo()
    expect(useStore.getState().groups).toEqual([])
    expect(useStore.getState().panels).toEqual(parts)
  })
  it('duplicates complete groups with new group and member IDs in the same transaction', () => {
    createSelectedGroup('Frame')
    const original = useStore.getState().groups[0]
    expect(duplicateSelected()).toBe(true)
    const state = useStore.getState()
    expect(state.groups).toHaveLength(2)
    expect(state.groups[1].id).not.toBe(original.id)
    expect(state.groups[1].name).toBe('Frame')
    expect(state.groups[1].memberIds).toEqual(state.selectedIds)
    expect(state.groups[1].memberIds.every(id => !original.memberIds.includes(id))).toBe(true)
    expect(state.past).toHaveLength(2)
    state.undo()
    expect(useStore.getState().groups).toEqual([original])
    expect(useStore.getState().panels).toHaveLength(2)
  })
  it('clipboard keeps captured groups across source edits and remaps each paste independently', () => {
    createSelectedGroup('Original')
    expect(copySelected()).toBe(true)
    renameGroup(useStore.getState().groups[0].id, 'Changed')
    expect(pasteCopied()).toBe(true)
    expect(pasteCopied()).toBe(true)
    const groups = useStore.getState().groups
    expect(groups.map(g => g.name)).toEqual(['Changed', 'Original', 'Original'])
    expect(new Set(groups.flatMap(g => g.memberIds)).size).toBe(6)
    expect(new Set(groups.map(g => g.id)).size).toBe(3)
  })
  it('does not copy partial groups; can copy a surviving one-member group', () => {
    createSelectedGroup('Frame')
    useStore.setState({ selectedIds: ['a'] })
    copySelected(); pasteCopied()
    expect(useStore.getState().groups).toHaveLength(1)
    useStore.setState({ groups: [{ id: 'single', name: 'Remaining', memberIds: ['a'] }], selectedIds: ['a'] })
    expect(duplicateSelected()).toBe(true)
    expect(useStore.getState().groups).toHaveLength(2)
    expect(useStore.getState().groups[1].memberIds).toEqual(useStore.getState().selectedIds)
  })
})
