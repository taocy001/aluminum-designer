import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../store/useStore'
import { addTemplateInstance, updateTemplateInstance } from '../utils/templateInstances'
import { parseProjectDocument, serializeProjectDocument } from '../utils/document'
import { encodeShareLink, decodeShare } from '../utils/shareLink'
import { createProjectSession } from '../utils/projectSession'
import { templateById } from '../utils/templates'
import { openingFaceOptions, resolveOpening, deriveOpeningPanel, type OpeningRef } from '../utils/openingBindings'

const defaults = (id: string) => Object.fromEntries(templateById(id)!.params.map(p => [p.key, p.value]))
const empty = () => ({ profiles: [], connectors: [], panels: [], fittings: [], equipment: [], throughRule: 'rails' as const, templateInstances: [] })
beforeEach(() => useStore.getState().loadDocument(empty()))
function add(id = 'cabinet') {
  expect(addTemplateInstance(id, defaults(id)).status).toBe('applied')
  return useStore.getState().templateInstances[0]
}

describe('editable template instances', () => {
  it('retains member IDs and gives one undo for geometry and parameters together', () => {
    const instance = add(), before = useStore.getState()
    expect(updateTemplateInstance(instance.id, { ...instance.parameters, w: 700 }).status).toBe('applied')
    const after = useStore.getState()
    expect(after.templateInstances[0].parameters.w).toBe(700)
    expect(after.profiles.map(p => p.id)).toEqual(before.profiles.map(p => p.id))
    expect(after.profiles).not.toEqual(before.profiles)
    expect(after.past.length).toBe(before.past.length + 1)
    after.undo()
    expect(useStore.getState().profiles).toEqual(before.profiles)
    expect(useStore.getState().templateInstances).toEqual(before.templateInstances)
    useStore.getState().redo()
    expect(useStore.getState().templateInstances).toEqual(after.templateInstances)
  })

  it('round-trips through files and share links without losing editable provenance', async () => {
    const instance = add()
    const text = serializeProjectDocument(useStore.getState())
    useStore.getState().loadDocument(parseProjectDocument(text))
    expect(useStore.getState().templateInstances).toEqual([instance])
    const url = await encodeShareLink(useStore.getState(), 'https://example.com/')
    const doc = await decodeShare(url.split('#d=')[1])
    expect(doc.templateInstances).toEqual([instance])
    useStore.getState().loadDocument(doc)
    expect(updateTemplateInstance(instance.id, { ...instance.parameters, h: 1000 }).status).toBe('applied')
  })

  it('tracks parameter metadata in dirty baselines and drafts', () => {
    add()
    const data = new Map<string, string>()
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) },
      removeItem: (k: string) => { data.delete(k) }, key: (i: number) => [...data.keys()][i] ?? null, get length() { return data.size } }
    const session = createProjectSession(() => storage)
    session.start(useStore.getState(), { saved: true })
    const instance = useStore.getState().templateInstances[0]
    const doc = { ...useStore.getState(), templateInstances: [{ ...instance, parameters: { ...instance.parameters, w: 650 } }] }
    session.update(doc, 'cabinet.json')
    expect(session.getState().dirty).toBe(true)
    expect(session.keepDraft()).toBe(true)
    const id = session.getState().id
    session.start(empty())
    expect(session.listDrafts().find(d => d.id === id)?.document.templateInstances).toEqual(doc.templateInstances)
  })

  it('rejects topology changes, manual edits and locked members without changing history', () => {
    let instance = add('shelving'), before = useStore.getState()
    expect(updateTemplateInstance(instance.id, { ...instance.parameters, shelves: 5 })).toMatchObject({ status: 'blocked', reason: 'topology' })
    expect(useStore.getState()).toBe(before)
    useStore.getState().commitProfileEdit(instance.profileIds[0], { length: 1400 })
    before = useStore.getState()
    expect(updateTemplateInstance(instance.id, { ...instance.parameters, w: 1000 })).toMatchObject({ status: 'blocked', reason: 'modified' })
    expect(useStore.getState()).toBe(before)
    before.undo()
    useStore.getState().commitDocument({ profiles: useStore.getState().profiles.map((p, i) => i === 0 ? { ...p, locked: true } : p) })
    expect(updateTemplateInstance(instance.id, { ...instance.parameters, w: 1000 })).toMatchObject({ status: 'blocked', reason: 'modified' })
  })

  it('does not infer templates in legacy projects and does not ignore free connectors', () => {
    expect(updateTemplateInstance('unknown', {})).toMatchObject({ status: 'blocked', reason: 'template' })
    const instance = add()
    useStore.getState().addConnector({ id: 'free', type: 'bracket', position: [0, 0, 0], quaternion: [0, 0, 0, 1], series: 20 })
    const before = useStore.getState()
    expect(updateTemplateInstance(instance.id, { ...instance.parameters, w: 650 })).toMatchObject({ status: 'blocked', reason: 'unbound', partIds: ['free'] })
    expect(useStore.getState()).toBe(before)
  })

  it('refuses panel fasteners until they can be reinstalled without losing the current assembly', () => {
    const instance = add()
    useStore.getState().addConnector({ id: 'fastener', type: 'bracket', position: [0,0,0], quaternion: [0,0,0,1],
      panelMount: { panelId: 'board', profileId: instance.profileIds[0], spacer: 0, boardThickness: 18 } })
    const before = useStore.getState()
    expect(updateTemplateInstance(instance.id, { ...instance.parameters, h: 900 })).toMatchObject({ status: 'blocked', reason: 'panel-mount' })
    expect(useStore.getState()).toBe(before)
  })

  it('updates opening-bound panels and end-bound supports with the frame', () => {
    const instance = add(), state = useStore.getState(), identity = [0, 0, 0, 1] as [number, number, number, number]
    const options = openingFaceOptions(state.profiles, instance.profileIds, identity, 'rails')
    const ref: OpeningRef = { left: options.left[0].ref, right: options.right.at(-1)!.ref,
      bottom: options.bottom[0].ref, top: options.top.at(-1)!.ref, front: options.front.at(-1)!.ref, back: options.back[0].ref }
    const opening = resolveOpening(ref, state.profiles, 'rails')
    expect(opening.status).toBe('resolved')
    if (opening.status !== 'resolved') throw new Error('fixture opening')
    const panel = deriveOpeningPanel({ id: 'bound', width: 1, height: 1, thickness: 18, material: 'ply', position: [0,0,0], quaternion: identity,
      openingBinding: { opening: ref, mode: 'front', margins: { left: 2, right: 2, top: 2, bottom: 2 }, normalOffset: 0 } }, opening.opening)!
    expect(state.addPanels([panel]).status).toBe('applied')
    expect(state.addConnector({ id: 'support', type: 'bracket', position: [0, 0, 0], quaternion: identity,
      supportBinding: { profileId: instance.profileIds[0], end: 'end', localPosition: [0, 0, 0], localQuaternion: identity } }).status).toBe('applied')
    const before = useStore.getState()
    expect(updateTemplateInstance(instance.id, { ...instance.parameters, w: 700, h: 1000 }).status).toBe('applied')
    const after = useStore.getState()
    expect(after.panels[0].width).toBeCloseTo(before.panels[0].width + 100)
    expect(after.panels[0].height).toBeCloseTo(before.panels[0].height + 200)
    expect(after.connectors[0].position).not.toEqual(before.connectors[0].position)
  })
})
