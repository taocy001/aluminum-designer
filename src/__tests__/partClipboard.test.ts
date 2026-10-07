import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore, type PanelData } from '../store/useStore'
import { copySelected, mirrorSelected, pasteCopied } from '../utils/editOps'
import { buildProfile } from '../utils/profileFactory'
import { computeTrims, setThroughRule } from '../utils/jointUtils'
import { boundProject } from './fixtures/bindings'
import { equipment } from './fixtures/equipment'
import { panelMountCandidates, panelMountFasteners, panelMountFrame, panelMountSupports } from '../utils/panelMounts'
import { connectorMeshes } from '../utils/connectorGeometry'

const kinds = ['profiles', 'connectors', 'panels', 'fittings', 'equipment'] as const
const empty = { profiles: [], connectors: [], panels: [], fittings: [], equipment: [] }

function mountedShelf() {
  const rail = { ...buildProfile(new THREE.Vector3(0, 350, 20), new THREE.Vector3(900, 350, 20), '2040', 'rail')!,
    quaternion: [.5, .5, .5, .5] as [number, number, number, number] }
  const panel: PanelData = { id: 'shelf', width: 860, height: 240, thickness: 18,
    position: [450, 350, 160], quaternion: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], material: 'ply' }
  const connectors = panelMountCandidates(panel, [rail]).map((c, i) => ({ ...c, id: `mount-${i}` }))
  expect(connectors).toHaveLength(2)
  return { profiles: [rail], connectors, panels: [panel], fittings: [], equipment: [] }
}

beforeEach(() => {
  useStore.setState({ ...empty, selectedIds: [], past: [], future: [], throughRule: 'rails' })
  setThroughRule('rails')
})

describe('part clipboard', () => {
  it('captures all selected part kinds without history and pastes independent unlocked groups atomically', () => {
    const doc = { ...boundProject(), equipment: [equipment()] }
    expect(useStore.getState().commitDocument(doc).status).toBe('applied')
    // Resolve driven dimensions before locking the reference assembly.
    for (const kind of kinds) for (const part of useStore.getState()[kind]) part.locked = true
    const state = useStore.getState()
    state.selectItems(kinds.flatMap((kind) => state[kind].map((p) => p.id)))
    const original = structuredClone(Object.fromEntries(kinds.map((kind) => [kind, state[kind]])))
    const past = useStore.getState().past.length
    expect(copySelected()).toBe(true)
    expect(useStore.getState().past).toHaveLength(past)
    useStore.getState().clearSelection()
    expect(pasteCopied()).toBe(true)
    const first = useStore.getState()
    const firstIds = new Set(first.selectedIds)
    expect(first.past).toHaveLength(past + 1)
    for (const kind of kinds) {
      expect(first[kind]).toHaveLength(2 * state[kind].length)
      expect(first[kind].slice(state[kind].length).every((p) => firstIds.has(p.id) && p.locked === false)).toBe(true)
    }
    const newProfiles = first.profiles.slice(state.profiles.length)
    const newFittings = first.fittings.slice(state.fittings.length)
    const newConnectors = first.connectors.slice(state.connectors.length)
    expect(newProfiles.at(-1)!.runnerBinding!.fittingId).toBe(newFittings[0].id)
    expect(newConnectors[0].supportBinding!.profileId).toBe(newProfiles.at(-1)!.id)
    for (const fitting of newFittings) {
      expect(fitting.openingBinding!.opening.left.profileId).toBe(newProfiles[0].id)
      expect(fitting.openingBinding!.opening.right.profileId).toBe(newProfiles[1].id)
    }
    expect(first.panels.at(-1)!.openingBinding!.opening.left.profileId).toBe(newProfiles[0].id)
    expect(pasteCopied()).toBe(true)
    const second = useStore.getState()
    expect(second.selectedIds.every((id) => !firstIds.has(id))).toBe(true)
    expect(second.profiles[state.profiles.length * 2].position[0] - newProfiles[0].position[0]).toBe(50)
    expect(second.past).toHaveLength(past + 2)
    second.undo()
    for (const kind of kinds) expect(useStore.getState()[kind]).toEqual(first[kind])
    useStore.getState().undo()
    for (const kind of kinds) expect(useStore.getState()[kind]).toEqual(original[kind])
    useStore.getState().redo()
    for (const kind of kinds) expect(useStore.getState()[kind]).toEqual(first[kind])
  })

  it('retains a deep snapshot across source edits, document replacement and mutations to prior copies', () => {
    const source = boundProject().fittings[0]
    useStore.setState({ fittings: [source], equipment: [equipment()], selectedIds: [source.id, 'oven'] })
    expect(copySelected()).toBe(true)
    source.drawer!.runnerLength = 300
    useStore.getState().equipment[0].clearance.front = 999
    useStore.setState({ ...empty, selectedIds: [], past: [], future: [] })
    expect(pasteCopied()).toBe(true)
    const pasted = useStore.getState()
    expect(pasted.fittings[0].drawer!.runnerLength).toBe(400)
    expect(pasted.fittings[0].openingBinding).toBeUndefined()
    expect(pasted.equipment[0].clearance.front).toBe(100)
    pasted.fittings[0].drawer!.runnerLength = 450
    pasted.equipment[0].clearance.front = 333
    expect(pasteCopied()).toBe(true)
    expect(useStore.getState().fittings[1].drawer!.runnerLength).toBe(400)
    expect(useStore.getState().equipment[1].clearance.front).toBe(100)
  })

  it('preserves an isolated member’s original physical cuts even after the source and through rule change', () => {
    const profiles = [buildProfile(new THREE.Vector3(), new THREE.Vector3(0, 800, 0), '4040', 'post')!,
      buildProfile(new THREE.Vector3(0, 800, 0), new THREE.Vector3(600, 800, 0), '4040', 'rail')!]
    useStore.setState({ profiles, selectedIds: ['rail'] })
    const length = computeTrims(profiles[1], profiles).cutLength
    expect(length).toBe(620)
    expect(copySelected()).toBe(true)
    useStore.setState({ ...empty, selectedIds: [], throughRule: 'posts' })
    setThroughRule('posts')
    expect(pasteCopied()).toBe(true)
    const copied = useStore.getState().profiles
    expect(computeTrims(copied[0], copied).cutLength).toBe(length)
    expect(copied[0].fixedTrims).toBeDefined()
  })

  it('an empty copy leaves the existing clipboard intact without adding history', () => {
    useStore.setState({ equipment: [equipment()], selectedIds: ['oven'] })
    expect(copySelected()).toBe(true)
    useStore.getState().clearSelection()
    expect(copySelected()).toBe(false)
    expect(useStore.getState().past).toHaveLength(0)
    expect(pasteCopied()).toBe(true)
    expect(useStore.getState().equipment).toHaveLength(2)
  })

  it('copies mounted shelves with remapped hosts, and keeps isolated hardware complete', () => {
    const doc = mountedShelf()
    useStore.setState({ ...doc, selectedIds: ['rail', 'shelf', ...doc.connectors.map(c => c.id)] })
    expect(copySelected()).toBe(true)
    expect(pasteCopied()).toBe(true)
    const pasted = useStore.getState()
    for (const c of pasted.connectors.slice(2)) {
      expect(c.panelMount).toMatchObject({ panelId: pasted.panels[1].id, profileId: pasted.profiles[1].id })
      expect(panelMountSupports(c, pasted.profiles, pasted.panels)).toEqual([pasted.profiles[1].id])
    }
    const original = doc.connectors[0]
    useStore.setState({ ...doc, selectedIds: [original.id], past: [], future: [] })
    expect(copySelected()).toBe(true)
    useStore.setState({ ...empty, selectedIds: [] })
    expect(pasteCopied()).toBe(true)
    const isolated = useStore.getState().connectors[0]
    expect(isolated.panelMount).toEqual(original.panelMount)
    expect(panelMountFasteners(isolated.panelMount!)).toEqual(panelMountFasteners(original.panelMount!))
    expect(connectorMeshes(isolated.type, isolated.series, isolated.profileSpec, isolated.mountSeries, isolated.panelMount))
      .toHaveLength(connectorMeshes(original.type, original.series, original.profileSpec, original.mountSeries, original.panelMount).length)
    expect(panelMountSupports(isolated, [], [])).toBeNull()
  })

  it.each(['x', 'z'] as const)('mirrors shelf mounts across %s while preserving the downward face and distinct bolt ends', (axis) => {
    const doc = mountedShelf()
    useStore.setState({ ...doc, selectedIds: ['rail', 'shelf', ...doc.connectors.map(c => c.id)] })
    expect(mirrorSelected(axis)).toBe(true)
    const mirrored = useStore.getState()
    for (const c of mirrored.connectors.slice(2)) {
      expect(c.panelMount).toMatchObject({ panelId: mirrored.panels[1].id, profileId: mirrored.profiles[1].id })
      expect(panelMountFrame(c).normal.distanceTo(new THREE.Vector3(0, -1, 0))).toBeLessThan(1e-9)
      expect(panelMountSupports(c, mirrored.profiles, mirrored.panels)).toEqual([mirrored.profiles[1].id])
    }
    expect(mirrored.past).toHaveLength(1)
    mirrored.undo()
    expect(useStore.getState().connectors).toEqual(doc.connectors)
  })
})
