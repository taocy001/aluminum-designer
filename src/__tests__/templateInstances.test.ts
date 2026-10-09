import { beforeEach, describe, expect, it } from 'vitest'
import { rotateSelected } from '../utils/editOps'
import { useStore } from '../store/useStore'
import { addTemplateInstance, updateTemplateInstance } from '../utils/templateInstances'
import { parseProjectDocument, serializeProjectDocument } from '../utils/document'
import { encodeShareLink, decodeShare } from '../utils/shareLink'
import { createProjectSession } from '../utils/projectSession'
import { templateById } from '../utils/templates'
import { openingFaceOptions, resolveOpening, deriveOpeningPanel, type OpeningRef } from '../utils/openingBindings'
import { attachPanels } from '../utils/attachPanels'
import { panelMountFrame, panelMountSupports } from '../utils/panelMounts'
import { panelOBB } from '../utils/analysis'
import { Vector3, Quaternion } from 'three'
import { panelDrillCenters } from '../utils/panelDrilling'
import { createConnectorPlacementValidator } from '../utils/connectorPlacement'

const defaults = (id: string) => Object.fromEntries(templateById(id)!.params.map(p => [p.key, p.value]))
const empty = () => ({ profiles: [], connectors: [], panels: [], fittings: [], equipment: [], throughRule: 'rails' as const, templateInstances: [] })
beforeEach(() => useStore.getState().loadDocument(empty()))
function add(id = 'cabinet') {
  expect(addTemplateInstance(id, defaults(id)).status).toBe('applied')
  return useStore.getState().templateInstances[0]
}

function mountedPanel(mode: 'top' | 'front') {
  const instance = add(), state = useStore.getState()
  const identity: [number, number, number, number] = [0, 0, 0, 1]
  const options = openingFaceOptions(state.profiles, instance.profileIds, identity, 'rails')
  const coordinates = { left: 10, right: 590, bottom: 10, top: 790, front: 590, back: 10 }
  const ref = Object.fromEntries(Object.entries(coordinates).map(([role, coordinate]) => [role,
    options[role as keyof typeof options].find(o => Math.abs(o.coordinate - coordinate) < .001)!.ref])) as unknown as OpeningRef
  const resolved = resolveOpening(ref, state.profiles, 'rails')
  if (resolved.status !== 'resolved') throw new Error('fixture opening')
  const margin = mode === 'top' ? 0 : -20
  const panel = deriveOpeningPanel({ id: 'board', width: 1, height: 1, thickness: 18, material: 'ply', position: [0, 0, 0], quaternion: identity,
    openingBinding: { opening: ref, mode, margins: { left: margin, right: margin, top: margin, bottom: margin }, normalOffset: mode === 'top' ? 11 : 29 } }, resolved.opening)!
  expect(state.addPanels([panel]).status).toBe('applied')
  let n = 0
  const mounts = attachPanels(useStore.getState(), [panel.id], () => `mount-${n++}`).made
  expect(mounts.length).toBeGreaterThanOrEqual(4)
  expect(useStore.getState().commitDocument({ connectors: mounts }).status).toBe('applied')
  return instance
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

  it('refuses invalid panel fasteners without changing the current assembly', () => {
    const instance = add()
    useStore.getState().addConnector({ id: 'fastener', type: 'bracket', position: [0,0,0], quaternion: [0,0,0,1],
      panelMount: { panelId: 'board', profileId: instance.profileIds[0], spacer: 0, boardThickness: 18 } })
    const before = useStore.getState()
    expect(updateTemplateInstance(instance.id, { ...instance.parameters, h: 900 })).toMatchObject({ status: 'blocked', reason: 'panel-mount' })
    expect(useStore.getState()).toBe(before)
  })

  it.each(['top', 'front'] as const)('resizes a mounted %s board with valid holes, preserved IDs and one undo after reopening', mode => {
    const instance = mountedPanel(mode)
    // A user's fine adjustment must survive; regeneration must not replace it with a default seat.
    const c = useStore.getState().connectors[0], host = useStore.getState().profiles.find(p => p.id === c.panelMount!.profileId)!
    const axis = new Vector3(0, 0, 1).applyQuaternion(new Quaternion(...host.quaternion))
    useStore.getState().commitTransform({ connectors: [{ id: c.id, updates: { position: new Vector3(...c.position).addScaledVector(axis, 7.5).toArray() } }] })
    useStore.getState().loadDocument(parseProjectDocument(serializeProjectDocument(useStore.getState())))
    const before = useStore.getState(), oldBoard = panelOBB(before.panels[0])
    const fraction = panelMountFrame(before.connectors[0]).boardHole.sub(oldBoard.center).dot(axis)
      / (Math.abs(axis.dot(oldBoard.axes[0])) * oldBoard.half.x + Math.abs(axis.dot(oldBoard.axes[1])) * oldBoard.half.y)
    expect(updateTemplateInstance(instance.id, { ...instance.parameters, w: 850, d: 750, h: 1100 })).toMatchObject({ status: 'applied' })
    const after = useStore.getState(), board = panelOBB(after.panels[0])
    expect(after.connectors.map(c => c.id)).toEqual(before.connectors.map(c => c.id))
    expect(after.past).toHaveLength(1)
    expect(panelMountFrame(after.connectors[0]).boardHole.sub(board.center).dot(axis)
      / (Math.abs(axis.dot(board.axes[0])) * board.half.x + Math.abs(axis.dot(board.axes[1])) * board.half.y)).toBeCloseTo(fraction, 6)
    const validate = createConnectorPlacementValidator(after.profiles, after)
    for (const mount of after.connectors) {
      expect(panelMountSupports(mount, after.profiles, after.panels)).toEqual([mount.panelMount!.profileId])
      expect(validate(mount, after.connectors.filter(c => c.id !== mount.id)).allowed).toBe(true)
    }
    expect(panelDrillCenters(after.panels[0], after.connectors).length).toBe(after.connectors.length)
    after.undo()
    expect(useStore.getState().connectors).toEqual(before.connectors)
    expect(useStore.getState().panels).toEqual(before.panels)
    expect(useStore.getState().templateInstances).toEqual(before.templateInstances)
    useStore.getState().redo()
    expect(useStore.getState().connectors).toEqual(after.connectors)
  })

  it('rejects a resize that moves a locked fastener without partially updating the frame', () => {
    const instance = mountedPanel('top')
    useStore.getState().commitDocument({ connectors: useStore.getState().connectors.map(c => ({ ...c, locked: true })) })
    const before = useStore.getState()
    expect(updateTemplateInstance(instance.id, { ...instance.parameters, w: 800 })).toMatchObject({ status: 'rejected', reason: 'locked-dependent' })
    expect(useStore.getState()).toBe(before)
  })

  it('rejects new fastener obstructions without moving any part or changing parameters', () => {
    const instance = mountedPanel('top'), parameters = { ...instance.parameters, w: 900 }
    expect(updateTemplateInstance(instance.id, parameters).status).toBe('applied')
    const target = useStore.getState().connectors[0].position
    useStore.getState().undo()
    expect(useStore.getState().commitDocument({ equipment: [{ id: 'obstacle', name: 'Obstruction', position: target,
      quaternion: [0, 0, 0, 1], width: 50, height: 50, depth: 50,
      clearance: { left: 0, right: 0, top: 0, bottom: 0, front: 0, back: 0 } }] }).status).toBe('applied')
    const before = useStore.getState()
    expect(updateTemplateInstance(instance.id, parameters)).toMatchObject({ status: 'blocked', reason: 'panel-mount', partIds: expect.arrayContaining([before.connectors[0].id]) })
    expect(useStore.getState()).toBe(before)
  })

  it('keeps another instance and its locked mounts unchanged', () => {
    const mounted = mountedPanel('front')
    useStore.getState().commitDocument({ connectors: useStore.getState().connectors.map(c => ({ ...c, locked: true })) })
    expect(addTemplateInstance('cabinet', defaults('cabinet')).status).toBe('applied')
    const state = useStore.getState(), other = state.templateInstances.find(i => i.id !== mounted.id)!
    expect(updateTemplateInstance(other.id, { ...other.parameters, w: 800 }).status).toBe('applied')
    expect(useStore.getState().connectors).toEqual(state.connectors)
    expect(useStore.getState().panels).toEqual(state.panels)
  })

  it('preserves the template origin after rigid rotation, translation, reopening and repeated resizing', () => {
    const instance = add(), beforeMove = useStore.getState()
    const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2)
    const translation = new Vector3(1200, 40, -800)
    expect(beforeMove.commitTransform({ profiles: beforeMove.profiles.map(p => ({ id: p.id, updates: {
      position: new Vector3(...p.position).applyQuaternion(rotation).add(translation).toArray(),
      quaternion: rotation.clone().multiply(new Quaternion(...p.quaternion)).toArray(),
    } })) }).status).toBe('applied')
    useStore.getState().loadDocument(parseProjectDocument(serializeProjectDocument(useStore.getState())))
    const before = useStore.getState()
    for (const w of [700, 900]) {
      expect(updateTemplateInstance(instance.id, { ...instance.parameters, w }).status).toBe('applied')
      const expected = templateById('cabinet')!.build({ ...instance.parameters, w })
      useStore.getState().profiles.forEach((p, i) => {
        expect(new Vector3(...p.position).distanceTo(new Vector3(...expected[i].position).applyQuaternion(rotation).add(translation))).toBeLessThan(1e-6)
        expect(p.length).toBeCloseTo(expected[i].length)
        expect(Math.abs(new Quaternion(...p.quaternion).dot(rotation.clone().multiply(new Quaternion(...expected[i].quaternion))))).toBeCloseTo(1)
      })
    }
    useStore.getState().undo(); useStore.getState().undo()
    expect(useStore.getState().profiles).toEqual(before.profiles)
  })

  it('accepts repeated rounded rotations from the actual selection command', () => {
    const instance = add()
    useStore.getState().selectItems(instance.profileIds)
    for (const angle of [15, 37, -11, 23, -5]) expect(rotateSelected('y', angle)).toBe(true)
    const moved = useStore.getState()
    expect(moved.commitTransform({ profiles: moved.profiles.map(p => ({ id: p.id, updates: {
      position: [p.position[0]+1000, p.position[1]+100, p.position[2]-300],
    } })) }).status).toBe('applied')
    useStore.getState().loadDocument(parseProjectDocument(serializeProjectDocument(useStore.getState())))
    expect(updateTemplateInstance(instance.id, { ...instance.parameters, w: 750 }).status).toBe('applied')
  })

  it.each<Record<string, number>>([{ shelves: 1e9 }, {}, { w: 600, d: 400, h: 1800, shelves: 3, extra: 1 }])('rejects invalid saved parameter metadata before rebuilding', parameters => {
    const instance = add('shelving')
    useStore.getState().commitDocument({ templateInstances: [{ ...instance, parameters }] })
    const before = useStore.getState()
    expect(updateTemplateInstance(instance.id, defaults('shelving'))).toMatchObject({ status: 'blocked', reason: 'parameters' })
    expect(useStore.getState()).toBe(before)
  })

  it('resizes a rotated frame with its attached board and fasteners', () => {
    const instance = mountedPanel('top'), state = useStore.getState()
    const q = new Quaternion().setFromAxisAngle(new Vector3(0,1,0), Math.PI / 2), t = new Vector3(1000,0,-500)
    const move = (p: { id: string; position: [number,number,number]; quaternion: [number,number,number,number] }) => ({ id: p.id, updates: {
      position: new Vector3(...p.position).applyQuaternion(q).add(t).toArray(),
      quaternion: q.clone().multiply(new Quaternion(...p.quaternion)).toArray(),
    } })
    expect(state.commitTransform({ profiles: state.profiles.map(move), panels: state.panels.map(move), connectors: state.connectors.map(move) }).status).toBe('applied')
    expect(updateTemplateInstance(instance.id, { ...instance.parameters, w: 800, d: 750 }).status).toBe('applied')
    const after = useStore.getState(), validate = createConnectorPlacementValidator(after.profiles, after)
    for (const mount of after.connectors) {
      expect(panelMountSupports(mount, after.profiles, after.panels)).toEqual([mount.panelMount!.profileId])
      expect(validate(mount, after.connectors.filter(c => c.id !== mount.id)).allowed).toBe(true)
    }
    expect(panelDrillCenters(after.panels[0], after.connectors)).toHaveLength(after.connectors.length)
  })

  it.each(['move', 'rotate', 'malformed'] as const)('rejects %s changes that cannot retain the template frame', kind => {
    const instance = add(), state = useStore.getState(), p = state.profiles[0]
    if (kind === 'malformed') state.commitDocument({ templateInstances: [{ ...instance, fingerprints: instance.fingerprints.map(() => 'invalid') }] })
    else state.commitTransform({ profiles: [{ id: p.id, updates: kind === 'move' ? { position: [15, 16, 17] }
      : { quaternion: [0, 0, 0, 1] } }] })
    const before = useStore.getState()
    expect(updateTemplateInstance(instance.id, { ...instance.parameters, w: 750 })).toMatchObject({ status: 'blocked', reason: 'modified' })
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
