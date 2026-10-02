import { beforeEach, expect, it } from 'vitest'
import * as THREE from 'three'
import kitchen from '../../examples/flat/01-kitchen-base.json'
import { useStore, type ProfileData, type ProfileSpec } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { parseProjectDocument } from '../utils/document'
import { addFittingFromSelection } from '../utils/fittingOps'
import { buildProfile } from '../utils/profileFactory'
import { fittingParts, leafObb } from '../utils/fittingGeometry'
import { obbCorners } from '../utils/obb'
import { computeAllTrims } from '../utils/jointUtils'
import { findConflicts } from '../utils/analysis'
import { getProfileDir } from '../utils/geometryCore'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const cabinet = (x0: number, z0 = 0, width = 600, spec: ProfileSpec = '2020') => {
  const profiles: ProfileData[] = []
  const add = (from: THREE.Vector3, to: THREE.Vector3) => profiles.push(buildProfile(from, to, spec)!)
  for (const x of [x0, x0 + width]) for (const z of [z0, z0 + 600]) add(V(x, 0, z), V(x, 880, z))
  for (const y of [20, 860]) {
    for (const z of [z0, z0 + 600]) add(V(x0, y, z), V(x0 + width, y, z))
    for (const x of [x0, x0 + width]) add(V(x, y, z0), V(x, y, z0 + 600))
  }
  return profiles
}
const select = (profiles: ProfileData[]) => useStore.getState().selectItems(profiles.map((p) => p.id))
const posts = (profiles: ProfileData[], z?: number) => profiles.filter((p) => p.length === 880 && (z === undefined || p.position[2] === z))
const lastFacing = () => {
  const fitting = useStore.getState().fittings.at(-1)!
  return V(0, 0, 1).applyQuaternion(new THREE.Quaternion(...fitting.quaternion))
}
beforeEach(() => {
  useToolStore.setState({ viewMode: false })
  useStore.getState().loadDocument({ profiles: [], connectors: [], panels: [], fittings: [], throughRule: 'rails' })
})

it.each([[1430, 1905], [1905, 2380]])('draws new drawers toward the existing doors in kitchen bay %s–%s', (left, right) => {
  const document = parseProjectDocument(kitchen)
  useStore.getState().loadDocument({ ...document, fittings: document.fittings.filter((f) => f.kind === 'door') })
  const chosen = document.profiles.filter((p) => Math.abs(getProfileDir(p).y) > 0.999
    && (p.position[0] === left || p.position[0] === right))
  expect(chosen).toHaveLength(4)
  select(chosen)
  expect(addFittingFromSelection({ kind: 'drawer', frontHeight: 310, count: 2 })).toBe(true)
  expect(lastFacing().z).toBeGreaterThan(0.9)
  const drawers = useStore.getState().fittings.filter((f) => f.kind === 'drawer')
  expect(drawers).toHaveLength(2)
  for (const drawer of drawers) expect(drawer.width).toBeCloseTo(455)
})

it.each([[1430, 1905], [1905, 2380]])('keeps kitchen bay %s–%s facing out before any fitting establishes a front', (left, right) => {
  const document = parseProjectDocument(kitchen)
  useStore.getState().loadDocument({ ...document, fittings: [] })
  const chosen = document.profiles.filter((p) => Math.abs(getProfileDir(p).y) > 0.999
    && (p.position[0] === left || p.position[0] === right))
  expect(chosen).toHaveLength(4)
  select(chosen)
  expect(addFittingFromSelection({ kind: 'drawer', frontHeight: 310, count: 2 })).toBe(true)
  expect(lastFacing().z).toBeGreaterThan(0.9)
  expect(useStore.getState().fittings.every((f) => Math.abs(f.width - 455) < 1e-7)).toBe(true)
})

it('does not inherit the opposite front of a nearby separate cabinet', () => {
  const own = cabinet(0), neighbour = cabinet(900)
  useStore.getState().loadDocument({ profiles: [...own, ...neighbour], connectors: [], panels: [], fittings: [], throughRule: 'rails' })
  select(posts(neighbour, 0))
  expect(addFittingFromSelection({ kind: 'door' })).toBe(true)
  expect(lastFacing().z).toBeLessThan(-0.9)
  select(posts(own, 600))
  expect(addFittingFromSelection({ kind: 'door' })).toBe(true)
  expect(lastFacing().z).toBeGreaterThan(0.9)
})

it('a door explicitly selected on the back stays on the back despite an existing front door', () => {
  const own = cabinet(0)
  useStore.getState().loadDocument({ profiles: own, connectors: [], panels: [], fittings: [], throughRule: 'rails' })
  select(posts(own, 600)); expect(addFittingFromSelection({ kind: 'door' })).toBe(true)
  expect(lastFacing().z).toBeGreaterThan(0.9)
  select(posts(own, 0)); expect(addFittingFromSelection({ kind: 'door' })).toBe(true)
  expect(lastFacing().z).toBeLessThan(-0.9)
})

it('selecting every member still keeps a separate cabinet out of drawer orientation and depth', () => {
  const own = cabinet(0, 0, 800), neighbour = cabinet(1100)
  useStore.getState().loadDocument({ profiles: [...own, ...neighbour], connectors: [], panels: [], fittings: [], throughRule: 'rails' })
  select(posts(neighbour, 0)); expect(addFittingFromSelection({ kind: 'door' })).toBe(true)
  select(own); expect(addFittingFromSelection({ kind: 'drawer', frontHeight: 200 })).toBe(true)
  const drawer = useStore.getState().fittings.at(-1)!
  expect(lastFacing().z).toBeGreaterThan(0.9)
  expect(drawer.depth).toBeCloseTo(580)
  expect(drawer.width).toBeCloseTo(780)
})

it('a nearby separate cabinet back board cannot reverse this drawer', () => {
  const own = cabinet(0, 0, 800), neighbour = cabinet(0, 750, 800)
  useStore.getState().loadDocument({ profiles: [...own, ...neighbour], connectors: [], fittings: [], throughRule: 'rails',
    panels: [{ id: 'other-back', width: 820, height: 880, thickness: 18, material: 'mdf',
      position: [400, 440, 731], quaternion: [0, 0, 0, 1] }] })
  select(posts(own)); expect(addFittingFromSelection({ kind: 'drawer', frontHeight: 200 })).toBe(true)
  expect(lastFacing().z).toBeGreaterThan(0.9)
})

it('a back board mounted to this frame still makes its drawer face away from it', () => {
  const own = cabinet(0, 0, 800)
  useStore.getState().loadDocument({ profiles: own, connectors: [], fittings: [], throughRule: 'rails',
    panels: [{ id: 'own-back', width: 820, height: 880, thickness: 18, material: 'mdf',
      position: [400, 440, 619], quaternion: [0, 0, 0, 1] }] })
  select(posts(own)); expect(addFittingFromSelection({ kind: 'drawer', frontHeight: 200 })).toBe(true)
  expect(lastFacing().z).toBeLessThan(-0.9)
})

it.each((['2020', '4040'] as const).flatMap((spec) =>
  (['full', 'half', 'inset'] as const).flatMap((overlay) => [0, 0.5, 1].map((open) => ({ spec, overlay, open }))),
))('a $spec rear door with $overlay overlay at open=$open keeps its drawer rear-facing', ({ spec, overlay, open }) => {
  const own = cabinet(0, 0, 600, spec)
  useStore.getState().loadDocument({ profiles: own, connectors: [], panels: [], fittings: [], throughRule: 'rails' })
  select(posts(own, 0)); expect(addFittingFromSelection({ kind: 'door', overlay })).toBe(true)
  expect(lastFacing().z).toBeLessThan(-0.9)
  useStore.getState().updateFitting(useStore.getState().fittings[0].id, { open }, false)
  select(posts(own)); expect(addFittingFromSelection({ kind: 'drawer', frontHeight: 200 })).toBe(true)
  expect(lastFacing().z).toBeLessThan(-0.9)
})

it.each([0, 600])('an inset door at depth %s fits between the horizontal rails with 3 mm gaps', (z) => {
  const profiles = cabinet(0)
  useStore.getState().loadDocument({ profiles, connectors: [], panels: [], fittings: [], throughRule: 'rails' })
  select(posts(profiles, z))
  expect(addFittingFromSelection({ kind: 'door', overlay: 'inset' })).toBe(true)
  const door = useStore.getState().fittings[0]
  expect(door.height).toBeCloseTo(820)
  expect(door.width).toBeCloseTo(580)
  const leaf = fittingParts(door).boards.find((board) => board.role === 'panel')!
  expect(leaf.height).toBeCloseTo(814)
  expect(leaf.width).toBeCloseTo(574)
  const bounds = new THREE.Box3().setFromPoints(obbCorners(leafObb(door, 0)!))
  expect(bounds.min.y - 30).toBeCloseTo(3)
  expect(850 - bounds.max.y).toBeCloseTo(3)
  expect(bounds.min.x - 10).toBeCloseTo(3)
  expect(590 - bounds.max.x).toBeCloseTo(3)
  expect(findConflicts(profiles, computeAllTrims(profiles), [], [], [door])).toEqual([])
})

it.each([0, 600])('an inset side door at x=%s keeps the same rail clearance', (x) => {
  const profiles = cabinet(0)
  useStore.getState().loadDocument({ profiles, connectors: [], panels: [], fittings: [], throughRule: 'rails' })
  select(posts(profiles).filter((p) => p.position[0] === x))
  expect(addFittingFromSelection({ kind: 'door', overlay: 'inset' })).toBe(true)
  const door = useStore.getState().fittings[0]
  expect(lastFacing().x).toBeCloseTo(x === 0 ? -1 : 1)
  const bounds = new THREE.Box3().setFromPoints(obbCorners(leafObb(door, 0)!))
  expect(bounds.min.y - 30).toBeCloseTo(3)
  expect(850 - bounds.max.y).toBeCloseTo(3)
  expect(bounds.min.z - 10).toBeCloseTo(3)
  expect(590 - bounds.max.z).toBeCloseTo(3)
  expect(findConflicts(profiles, computeAllTrims(profiles), [], [], [door])).toEqual([])
})

it('selecting the front rails as well as the posts retains the inset door clearance', () => {
  const profiles = cabinet(0)
  useStore.getState().loadDocument({ profiles, connectors: [], panels: [], fittings: [], throughRule: 'rails' })
  select(profiles.filter((p) => p.position[2] === 600 && (p.length === 880 || p.position[0] === 0)))
  expect(addFittingFromSelection({ kind: 'door', overlay: 'inset' })).toBe(true)
  const door = useStore.getState().fittings[0]
  expect(door.height).toBeCloseTo(820)
  expect(findConflicts(profiles, computeAllTrims(profiles), [], [], [door])).toEqual([])
})

it('overlay doors retain their original opening height', () => {
  const profiles = cabinet(0)
  useStore.getState().loadDocument({ profiles, connectors: [], panels: [], fittings: [], throughRule: 'rails' })
  select(posts(profiles, 600))
  expect(addFittingFromSelection({ kind: 'door', overlay: 'full' })).toBe(true)
  expect(useStore.getState().fittings[0].height).toBeCloseTo(840)
})
