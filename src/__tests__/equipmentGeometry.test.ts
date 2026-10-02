import { afterEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { EquipmentData, FittingData, ProfileData } from '../store/useStore'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { equipmentBody, equipmentClearance } from '../utils/equipmentGeometry'
import { findEquipmentConflicts } from '../utils/equipmentChecks'
import { makeOBB } from '../utils/obb'
import { analyzeFrame } from '../utils/analysis'
import { buildProfile, prepareProfile } from '../utils/profileFactory'
import { pickCandidatesAtScreen } from '../utils/screenPick'
import { frontmostId } from '../utils/frontmost'
import { toScreen } from '../utils/pickUtils'
import { vet, type SuggestDoc } from '../utils/suggestGate'
import { nextSuggestion } from '../utils/suggestOps'
import { noClearance } from './fixtures/equipment'

const V = (x: number, y: number, z = 0) => new THREE.Vector3(x, y, z)
const equipment = (patch: Partial<EquipmentData> = {}): EquipmentData => ({
  id: 'equipment', name: 'Equipment', width: 100, height: 100, depth: 100,
  position: [0, 50, 0], quaternion: [0, 0, 0, 1], clearance: noClearance(), ...patch,
})
const box = (id: string, x: number, y: number, z: number, width = 20) => ({
  id, obb: makeOBB(V(x, y, z), V(width / 2, 10, 10), new THREE.Quaternion()),
})

afterEach(() => {
  useToolStore.getState().setSuggestion(null, new Set())
  useToolStore.setState({ section: null })
})

describe('equipment envelopes', () => {
  it('rotates asymmetric clearances from the six local faces', () => {
    const e = equipment({ width: 100, height: 80, depth: 60, position: [10, 20, 30],
      quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
      clearance: { left: 10, right: 30, bottom: 4, top: 12, back: 6, front: 26 } })
    expect(equipmentBody(e).half.toArray()).toEqual([50, 40, 30])
    const reserved = equipmentClearance(e)
    expect(reserved.half.toArray()).toEqual([70, 48, 46])
    expect(reserved.center.distanceTo(V(20, 24, 20))).toBeLessThan(1e-8)
    expect(reserved.axes[2].distanceTo(V(1, 0, 0))).toBeLessThan(1e-8)
  })

  it('matches the physical body when all clearances are zero', () => {
    const e = equipment()
    expect(equipmentClearance(e)).toEqual(equipmentBody(e))
  })

  it('reports a body collision before clearance on any board of the same part', () => {
    const e = equipment({ clearance: { ...noClearance(), right: 50 } })
    const hits = findEquipmentConflicts([e], [box('drawer', 80, 50, 0), box('drawer', 55, 50, 0)])
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ a: e.id, b: 'drawer', kind: 'equipment-body', depth: 5 })
    expect(hits[0].region.min.x).toBe(45)
    expect(hits[0].region.max.x).toBe(50)
  })

  it('reports only the occupied clearance face and respects 1 mm contact tolerance', () => {
    const e = equipment({ clearance: { ...noClearance(), right: 30 } })
    expect(findEquipmentConflicts([e], [box('within', 75, 50, 0)])).toEqual([
      expect.objectContaining({ kind: 'equipment-clearance', depth: 15 }),
    ])
    expect(findEquipmentConflicts([e], [box('touch', 89, 50, 0), box('left', -65, 50, 0)])).toEqual([])
    expect(findEquipmentConflicts([equipment()], [box('touch', 59, 50, 0)])).toEqual([])
    expect(findEquipmentConflicts([equipment()], [box('penetrates', 58.9, 50, 0)])[0].depth).toBe(1.1)
  })

  it('checks equipment bodies and each reservation against the other body, never reservation pairs', () => {
    const a = equipment({ id: 'a', clearance: { ...noClearance(), right: 50 } })
    const b = equipment({ id: 'b', position: [120, 50, 0], clearance: { ...noClearance(), left: 50 } })
    expect(findEquipmentConflicts([a, b], []).map(({ a, b, kind }) => ({ a, b, kind }))).toEqual([
      { a: 'a', b: 'b', kind: 'equipment-clearance' }, { a: 'b', b: 'a', kind: 'equipment-clearance' },
    ])
    expect(findEquipmentConflicts([a, { ...b, position: [80, 50, 0] }], [])).toEqual([
      expect.objectContaining({ a: 'a', b: 'b', kind: 'equipment-body' }),
    ])
    expect(findEquipmentConflicts([a, { ...b, position: [175, 50, 0] }], [])).toEqual([])
  })

  it('uses rotated bodies rather than their world bounding boxes', () => {
    const e = equipment({ width: 200, height: 20, depth: 20,
      quaternion: [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)] })
    expect(findEquipmentConflicts([e], [box('outside', 60, -10, 0, 10)])).toEqual([])
  })
})

describe('equipment analysis and selection', () => {
  it('invalidates analysis when equipment changes, retaining the structural result', () => {
    const profiles = [buildProfile(V(0, 0), V(0, 200), '2020', 'post')!]
    const connectors: [] = [], panels: [] = [], fittings: [] = [], devices = [equipment()]
    const first = analyzeFrame(profiles, connectors, panels, fittings, devices)
    expect(analyzeFrame(profiles, connectors, panels, fittings, devices)).toBe(first)
    expect(first.conflicts).toEqual([])
    expect(first.equipmentConflictIds).toEqual(new Set(['equipment', 'post']))
    const moved = analyzeFrame(profiles, connectors, panels, fittings, [{ ...devices[0], position: [1000, 50, 0] }])
    expect(moved).not.toBe(first)
    expect(moved.equipmentConflicts).toEqual([])
  })

  it('checks actual drawer boards, leaving the empty interior available', () => {
    const f: FittingData = { id: 'drawer', kind: 'drawer', width: 580, height: 250, depth: 600, frame: 20,
      material: 'ply', position: [0, 0, 0], quaternion: [0, 0, 0, 1], open: 0 }
    const e = equipment({ width: 50, height: 50, depth: 50, position: [0, 0, 0] })
    expect(analyzeFrame([], [], [], [f], [e]).equipmentConflicts).toEqual([])
    const opened = { ...f, open: 1 }
    expect(analyzeFrame([], [], [], [opened], [equipment({ ...e, position: [0, 0, 575] })]).equipmentConflicts).toEqual([])
    expect(analyzeFrame([], [], [], [f], [equipment({ ...e, position: [275, 0, 0] })]).equipmentConflicts[0])
      .toMatchObject({ a: e.id, b: f.id, kind: 'equipment-body' })
  })

  it('picks rotated bodies while excluding clearance space and the clipped side', () => {
    const camera = new THREE.OrthographicCamera(-200, 200, 200, -200, 1, 2000)
    camera.position.set(0, 0, 1000); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(); camera.updateProjectionMatrix()
    const e = equipment({ position: [0, 0, 0], clearance: { ...noClearance(), right: 100 } })
    const size = { width: 1000, height: 1000 }
    const pick = (x: number, y = 0, part = e) => {
      const cursor = toScreen(V(x, y), camera, size)
      const rc = new THREE.Raycaster(); rc.setFromCamera(new THREE.Vector2(cursor.x / 500 - 1, 1 - cursor.y / 500), camera)
      return pickCandidatesAtScreen(cursor, rc.ray, camera, size, [], [], [], [], undefined, [part])
    }
    expect(pick(25)[0]).toMatchObject({ kind: 'equipment', id: e.id })
    expect(pick(100)).toEqual([])
    const rotated = equipment({ width: 200, height: 20, depth: 20, position: [0, 0, 0],
      quaternion: [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)] })
    expect(pick(30, 30, rotated)[0]?.id).toBe(rotated.id)
    expect(pick(60, -60, rotated)).toEqual([])
    useToolStore.setState({ section: { axis: 'x', at: -10, flip: false } })
    expect(pick(25)).toEqual([])
  })

  it('resolves equipment ownership from the rendered mesh', () => {
    const scene = new THREE.Scene(), group = new THREE.Group(), mesh = new THREE.Mesh(new THREE.BoxGeometry(20, 20, 20))
    group.userData.equipmentId = 'equipment'; group.add(mesh); scene.add(group); scene.updateMatrixWorld()
    expect(frontmostId(scene, new THREE.Ray(V(0, 0, 100), V(0, 0, -1)), new THREE.PerspectiveCamera())).toBe('equipment')
    mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose()
  })
})

describe('equipment-aware suggestions', () => {
  it('rejects new rails inside bodies or reserved space', () => {
    const candidate = buildProfile(V(0, 0), V(0, 100), '2020', 'candidate')!
    const doc: SuggestDoc = { profiles: [], connectors: [], panels: [], fittings: [] }
    expect(vet(candidate, { kind: 'open' }, doc).ok).toBe(true)
    expect(vet(candidate, { kind: 'open' }, { ...doc, equipment: [equipment()] })).toMatchObject({ ok: false, why: expect.stringContaining('equipment-body') })
    const offset = equipment({ width: 20, position: [40, 50, 0], clearance: { ...noClearance(), left: 35 } })
    expect(vet(candidate, { kind: 'open' }, { ...doc, equipment: [offset] })).toMatchObject({ ok: false, why: expect.stringContaining('equipment-clearance') })
  })

  it('discards a displayed suggestion after equipment changes', () => {
    const profiles: ProfileData[] = []
    const add = (a: number[], b: number[]) => profiles.push(prepareProfile(V(a[0], a[1], a[2]), V(b[0], b[1], b[2]), '2020', profiles)!)
    add([0, 10, 0], [600, 10, 0])
    add([0, 10, 0], [0, 10, 400])
    add([0, 0, 0], [0, 700, 0])
    add([600, 0, 0], [600, 700, 0])
    useStore.getState().loadDocument({ profiles, connectors: [], panels: [], fittings: [], equipment: [], throughRule: 'rails' })
    expect(nextSuggestion()).not.toBeNull()
    useStore.getState().addEquipment(equipment())
    expect(useToolStore.getState().suggestion).toBeNull()
  })
})
