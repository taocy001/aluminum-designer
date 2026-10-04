import { beforeEach, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore, type ProfileData, type ProfileSpec } from '../store/useStore'
import { buildProfile } from '../utils/profileFactory'
import { autoConnect } from '../utils/autoConnect'
import { connectorSeatAt } from '../utils/bracketSeat'
import { fitConnector } from '../utils/connectorFit'
import { computeAllTrims, setThroughRule } from '../utils/jointUtils'
import { findConflicts } from '../utils/analysis'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const profile = (id: string, from: THREE.Vector3, to: THREE.Vector3, spec: ProfileSpec = '2020', start = 0, end = 0): ProfileData =>
  ({ ...buildProfile(from, to, spec, id)!, fixedTrims: { start, end } })
const direction = (quaternion: [number, number, number, number]) => V(0, 0, 1).applyQuaternion(new THREE.Quaternion(...quaternion))
const load = (profiles: ProfileData[]) => useStore.getState().loadDocument({ profiles, connectors: [], panels: [], fittings: [], throughRule: 'rails' })
beforeEach(() => { setThroughRule('rails'); useStore.setState({ profiles: [], connectors: [], panels: [], fittings: [], past: [], future: [], selectedIds: [] }) })

it('caps the four exposed post ends, without a sideways rail offset or false metal conflicts', () => {
  const posts = [0, 600].map((x) => profile(`post-${x}`, V(x, 0, 0), V(x, 800, 0)))
  const rails = [10, 800].map((y) => profile(`rail-${y}`, V(0, y, 0), V(600, y, 0), '2020', 10, 10))
  const profiles = [...rails, ...posts] // nearest design endpoint order must not choose a rail
  load(profiles)
  expect(autoConnect('end-cap').placed).toBe(4)
  const caps = useStore.getState().connectors
  for (const p of posts) for (const y of [0, 800]) {
    const at = V(p.position[0], y, 0), normal = V(0, y === 0 ? -1 : 1, 0)
    const cap = caps.find((cap) => new THREE.Vector3(...cap.position).distanceTo(at) < 1e-5)!
    expect(cap).toBeDefined()
    expect(direction(cap.quaternion).dot(normal)).toBeCloseTo(1)
    const manual = connectorSeatAt('end-cap', at, profiles, normal)
    expect(manual.position).toEqual(cap.position)
    expect(manual.quaternion).toEqual(cap.quaternion)
  }
  expect(findConflicts(profiles, computeAllTrims(profiles), caps)).toEqual([])
  const past = useStore.getState().past.length
  expect(autoConnect('end-cap').placed).toBe(0)
  expect(useStore.getState().connectors).toEqual(caps)
  expect(useStore.getState().past).toHaveLength(past)
})

for (const [spec, series] of [['2020', 20], ['3030', 30], ['4040', 40]] as const) {
  it.each([[35, 80], [-90, -120]])(`uses actual cut/extended ends and the host series for ${spec} trims %s/%s`, (start, end) => {
    const p = profile('rail', V(50, 100, 0), V(450, 100, 0), spec, start, end)
    load([p])
    expect(autoConnect('end-cap').placed).toBe(2)
    const caps = useStore.getState().connectors
    for (const [index, x] of [50 + start, 450 - end].entries()) {
      const cap = caps[index], normal = V(index === 0 ? -1 : 1, 0, 0)
      expect(new THREE.Vector3(...cap.position).distanceTo(V(x, 100, 0))).toBeLessThan(1e-5)
      expect(cap.series).toBe(series)
      expect(direction(cap.quaternion).dot(normal)).toBeCloseTo(1)
      for (const cursor of [V(x, 100, 0), V(index === 0 ? 50 : 450, 100, 0)]) {
        const manual = connectorSeatAt('end-cap', cursor, [p], normal)
        expect(manual.position).toEqual(cap.position)
        expect(manual.quaternion).toEqual(cap.quaternion)
        expect(manual.series).toBe(series)
      }
    }
    const trims = computeAllTrims([p])
    expect(findConflicts([p], trims, caps)).toEqual([])
    const buried = { ...caps[0], position: new THREE.Vector3(...caps[0].position)
      .addScaledVector(direction(caps[0].quaternion), -20).toArray() as [number, number, number] }
    expect(findConflicts([p], trims, [buried]).some((conflict) => conflict.a === p.id || conflict.b === p.id)).toBe(true)
    expect(autoConnect('end-cap').placed).toBe(0)
    expect(useStore.getState().connectors).toEqual(caps) // long extensions must not be removed as stale
  })
}

it('keeps the section roll and outward normals of a reverse-drawn post', () => {
  const p = profile('post', V(0, 600, 0), V(0, 200, 0), '4040', -100, 60)
  const q = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), 0.37).multiply(new THREE.Quaternion(...p.quaternion))
  p.quaternion = q.toArray()
  load([p]); autoConnect('end-cap')
  const caps = useStore.getState().connectors
  expect(caps).toHaveLength(2)
  expect(caps[0].position[1]).toBeCloseTo(700)
  expect(caps[1].position[1]).toBeCloseTo(260)
  expect(direction(caps[0].quaternion).y).toBeCloseTo(1)
  expect(direction(caps[1].quaternion).y).toBeCloseTo(-1)
  const section = V(1, 0, 0).applyQuaternion(q)
  for (const cap of caps) expect(Math.abs(V(1, 0, 0).applyQuaternion(new THREE.Quaternion(...cap.quaternion)).dot(section))).toBeCloseTo(1)
})

it.each([0, Math.PI / 2])('does not duplicate correctly seated caps saved with the older roll convention plus %s', (roll) => {
  const p = profile('post', V(0, 0, 0), V(0, 800, 0))
  const caps = [0, 800].map((y) => ({ id: `old-${y}`, type: 'end-cap', position: [0, y, 0] as [number, number, number],
    ...fitConnector('end-cap', V(0, y, 0), [p]) }))
  for (const cap of caps) cap.quaternion = new THREE.Quaternion(...cap.quaternion)
    .multiply(new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), roll)).toArray()
  useStore.getState().loadDocument({ profiles: [p], connectors: caps, panels: [], fittings: [], throughRule: 'rails' })
  const before = useStore.getState().connectors
  expect(autoConnect('end-cap').placed).toBe(0)
  expect(useStore.getState().connectors).toEqual(before)
})

it('preserves an existing cap whose arbitrary roll does not fit the host section', () => {
  const p = profile('post', V(0, 0, 0), V(0, 800, 0), '4040')
  p.quaternion = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), 0.37)
    .multiply(new THREE.Quaternion(...p.quaternion)).toArray()
  const caps = [0, 800].map((y) => ({ id: `old-${y}`, type: 'end-cap', position: [0, y, 0] as [number, number, number],
    ...fitConnector('end-cap', V(0, y, 0), [p]) }))
  useStore.getState().loadDocument({ profiles: [p], connectors: caps, panels: [], fittings: [], throughRule: 'rails' })
  const before = useStore.getState()
  expect(autoConnect('end-cap')).toMatchObject({ placed: 0, removed: 0, unbolted: 2 })
  expect(useStore.getState()).toBe(before)
})

it('preserves sideways, wrong-series and locked caps without overlapping them', () => {
  const p = profile('post', V(0, 0, 0), V(0, 800, 0), '4040')
  const old = [0, 800].map((y) => ({ id: `old-${y}`, type: 'end-cap', series: 20 as const,
    position: [0, y, y === 0 ? -20 : 0] as [number, number, number],
    quaternion: fitConnector('end-cap', V(0, y, 0), [p]).quaternion }))
  const locked = { ...old[0], id: 'locked', locked: true }
  const other = { ...old[1], id: 'other', type: 'bracket' }
  useStore.getState().loadDocument({ profiles: [p], connectors: [...old, locked, other], panels: [], fittings: [], throughRule: 'rails' })
  const previous = useStore.getState().connectors
  const before = useStore.getState().past.length
  expect(autoConnect('end-cap')).toMatchObject({ placed: 0, removed: 0, unbolted: 2 })
  const after = useStore.getState().connectors
  expect(after).toHaveLength(4)
  expect(after.find((c) => c.id === locked.id)).toEqual(locked)
  expect(after.find((c) => c.id === other.id)).toEqual(other)
  expect(after).toBe(previous)
  expect(useStore.getState().past).toHaveLength(before)
  expect(autoConnect('end-cap').placed).toBe(0)
  expect(useStore.getState().connectors).toEqual(after)
})
