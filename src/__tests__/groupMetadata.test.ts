import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../store/useStore'
import { parseProjectDocument, serializeProjectDocument } from '../utils/document'
import { encodeShareLink, decodeShare } from '../utils/shareLink'
import { validPartGroups } from '../utils/groupMetadata'
import { addTemplateInstance } from '../utils/templateInstances'
import { templateById } from '../utils/templates'

beforeEach(() => useStore.getState().loadDocument({ profiles: [], connectors: [], panels: [], fittings: [], equipment: [], throughRule: 'rails' }))
function fixture() {
  const template = templateById('cabinet')!
  addTemplateInstance(template.id, Object.fromEntries(template.params.map(p => [p.key, p.value])))
  const memberIds = useStore.getState().profiles.slice(0, 2).map(p => p.id)
  const group = { id: 'group', name: 'Frame pair', memberIds }
  useStore.getState().commitDocument({ groups: [group] })
  return group
}

describe('persistent group metadata', () => {
  it('removes deleted references, retains a single survivor, and restores membership on undo', () => {
    const group = fixture(), before = useStore.getState()
    expect(before.removeProfile(group.memberIds[0]).status).toBe('applied')
    expect(useStore.getState().groups).toEqual([{ ...group, memberIds: [group.memberIds[1]] }])
    expect(useStore.getState().past.length).toBe(before.past.length + 1)
    useStore.getState().removeProfile(group.memberIds[1])
    expect(useStore.getState().groups).toEqual([])
    useStore.getState().undo()
    expect(useStore.getState().groups[0].memberIds).toEqual([group.memberIds[1]])
    useStore.getState().undo()
    expect(useStore.getState().groups).toEqual([group])
    useStore.getState().redo()
    expect(useStore.getState().groups[0].memberIds).toEqual([group.memberIds[1]])
  })
  it('preserves names and member IDs through JSON and share links', async () => {
    const group = fixture()
    const parsed = parseProjectDocument(serializeProjectDocument(useStore.getState()))
    expect(parsed.groups).toEqual([group])
    const link = await encodeShareLink(parsed, 'https://example.com/')
    expect((await decodeShare(link.split('#d=')[1])).groups).toEqual([group])
  })
  it('rejects malformed group metadata rather than discarding it', () => {
    const group = fixture(), doc = JSON.parse(serializeProjectDocument(useStore.getState()))
    for (const groups of [[{ ...group, memberIds: [] }], [{ ...group, memberIds: ['a', 'a'] }], [group, group], [{ ...group, name: '' }]]) {
      expect(validPartGroups(groups)).toBe(false)
      expect(() => parseProjectDocument({ ...doc, groups })).toThrow()
    }
  })
})
