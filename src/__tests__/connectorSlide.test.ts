import { beforeEach, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore, type ConnectorData, type PanelData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { buildProfile } from '../utils/profileFactory'
import { resolveConnectorPlacement } from '../utils/connectorPlacement'
import { connectorSlide, connectorSlideRange, moveConnectorAlongSlot } from '../utils/connectorSlide'
import { deriveSupport } from '../utils/openingBindings'
import { attachPanels } from '../utils/attachPanels'
import { panelMountSupports } from '../utils/panelMounts'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
beforeEach(() => {
  useStore.setState({ profiles: [], connectors: [], panels: [], fittings: [], equipment: [], past: [], future: [], selectedIds: [] })
  useToolStore.setState({ viewMode: false })
})
function nut() {
  const p = buildProfile(V(0, 100, 0), V(0, 100, 400), '2020', 'host')!
  const seat = resolveConnectorPlacement('t-nut', V(0, 110, 200), [p], [], V(0, 1, 0))
  expect(seat.allowed).toBe(true)
  const c: ConnectorData = { id: 'nut', type: 't-nut', ...seat.seat }
  useStore.setState({ profiles: [p], connectors: [c] })
  return { p, c }
}
it('shows actual mounting bounds and keeps collision checks separate from support limits', () => {
  const { c } = nut()
  const doc = useStore.getState()
  const range = connectorSlideRange(c, doc)!
  expect(range.min).toBeLessThan(-100)
  expect(range.max).toBeGreaterThan(100)
  expect(connectorSlide(c, range.min, doc).allowed).toBe(true)
  expect(connectorSlide(c, range.max, doc).allowed).toBe(true)
  expect(connectorSlide(c, range.min - 1, doc).reason).toBe('no-joint')
  expect(connectorSlide(c, range.max + 1, doc).reason).toBe('no-joint')
  const blocked = { ...doc, connectors: [c, { ...c, id: 'obstacle', position: [c.position[0], c.position[1], c.position[2] + 20] as [number, number, number] }] }
  expect(connectorSlideRange(c, blocked)).toEqual(range)
  expect(connectorSlide(c, 20, blocked).allowed).toBe(false)
  expect(connectorSlideRange({ ...c, type: 'inside-corner' }, doc)).toBeNull()
})
it('slides fractional distances along a rotated rail, preserves orientation, and undoes once', () => {
  const { p, c } = nut()
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(.4, .3, .2))
  const rotate = (v: number[]) => new THREE.Vector3(...v as [number, number, number]).applyQuaternion(q).toArray() as [number, number, number]
  const rotated = { ...c, position: rotate(c.position), quaternion: q.clone().multiply(new THREE.Quaternion(...c.quaternion)).toArray() as ConnectorData['quaternion'] }
  useStore.setState({ profiles: [{ ...p, position: rotate(p.position), quaternion: q.clone().multiply(new THREE.Quaternion(...p.quaternion)).toArray() }], connectors: [rotated] })
  expect(moveConnectorAlongSlot(c.id, .1)).toBe(true)
  const moved = useStore.getState().connectors[0]
  expect(new THREE.Vector3(...moved.position).distanceTo(new THREE.Vector3(...rotated.position))).toBeCloseTo(.1)
  expect(moved.quaternion).toEqual(rotated.quaternion)
  expect(useStore.getState().past).toHaveLength(1)
  useStore.getState().undo()
  expect(useStore.getState().connectors[0]).toEqual(rotated)
})
it('retains and updates support binding offsets', () => {
  const { p, c } = nut()
  c.supportBinding = { profileId: p.id, end: 'start', localPosition: new THREE.Vector3(...c.position).sub(new THREE.Vector3(...p.position)).toArray(), localQuaternion: c.quaternion }
  useStore.setState({ connectors: [{ ...c }] })
  expect(moveConnectorAlongSlot(c.id, 5)).toBe(true)
  const moved = useStore.getState().connectors[0]
  expect(moved.supportBinding?.localPosition[2]).toBeCloseTo(c.supportBinding.localPosition[2] + 5)
  expect(deriveSupport(moved, p)?.position).toEqual(moved.position)
})
it('rejects a collision, passing the end, invalid input, locked and view-only edits without history', () => {
  const { c } = nut()
  useStore.setState({ connectors: [c, { ...c, id: 'other', position: [c.position[0], c.position[1], c.position[2] + 20] }] })
  expect(connectorSlide(c, 20, useStore.getState())).toMatchObject({ allowed: false, conflicts: ['other'] })
  expect(moveConnectorAlongSlot(c.id, 20)).toBe(false)
  expect(moveConnectorAlongSlot(c.id, 500)).toBe(false)
  expect(moveConnectorAlongSlot(c.id, NaN)).toBe(false)
  useToolStore.setState({ viewMode: true })
  expect(moveConnectorAlongSlot(c.id, 1)).toBe(false)
  useToolStore.setState({ viewMode: false })
  useStore.setState({ connectors: [{ ...c, locked: true }] })
  expect(moveConnectorAlongSlot(c.id, 1)).toBe(false)
  expect(useStore.getState().past).toHaveLength(0)
})
it('does not detach corner brackets or end-mounted accessories for slot movement', () => {
  const { c } = nut()
  for (const type of ['inside-corner', 'end-cap', 'foot', 'caster-mount']) {
    expect(connectorSlide({ ...c, type }, .1, useStore.getState())).toMatchObject({ allowed: false, reason: 'fixed' })
  }
})
it('keeps panel mount metadata and both mounting surfaces while moving', () => {
  const rail = (id: string, x: number, z: number, ex: number, ez: number, wide = false) => {
    const p = buildProfile(V(x, 350, z), V(ex, 350, ez), wide ? '2040' : '2020', id)!
    if (wide) p.quaternion = [.5, .5, .5, .5]
    return p
  }
  const panel: PanelData = { id: 'board', width: 860, height: 240, thickness: 18, position: [450, 355, 160], quaternion: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], material: 'ply' }
  const doc = { profiles: [rail('front', 0, 20, 900, 20, true), rail('back', 0, 300, 900, 300, true), rail('left', 10, 40, 10, 280), rail('right', 890, 40, 890, 280)], panels: [panel], connectors: [], fittings: [], equipment: [] }
  let n = 0
  const mounts = attachPanels(doc, ['board'], () => `c${n++}`).made
  expect(mounts.length).toBeGreaterThan(0)
  useStore.setState({ ...doc, connectors: mounts })
  expect(moveConnectorAlongSlot(mounts[0].id, 5)).toBe(true)
  const moved = useStore.getState().connectors[0]
  expect(moved.panelMount).toEqual(mounts[0].panelMount)
  expect(panelMountSupports(moved, doc.profiles, doc.panels)).toEqual([moved.panelMount!.profileId])
})

it('uses the actual rotated binding source even when it is not a mounting host', () => {
  const { p, c } = nut()
  const source = buildProfile(V(1000, 100, 0), V(1400, 100, 0), '2020', 'source')!
  const inverse = new THREE.Quaternion(...source.quaternion).normalize().invert()
  c.supportBinding = { profileId: source.id, end: 'start',
    localPosition: new THREE.Vector3(...c.position).sub(new THREE.Vector3(...source.position)).applyQuaternion(inverse).toArray(),
    localQuaternion: inverse.clone().multiply(new THREE.Quaternion(...c.quaternion)).toArray() }
  useStore.setState({ profiles: [p, source], connectors: [{ ...c }] })
  expect(moveConnectorAlongSlot(c.id, .1)).toBe(true)
  const moved = useStore.getState().connectors[0]
  expect(moved.position).toEqual([c.position[0], c.position[1], c.position[2] + .1])
  expect(deriveSupport(moved, source)?.position).toEqual(moved.position)
  expect(connectorSlide(moved, 0, useStore.getState()).allowed).toBe(true)
})
it('keeps editable slot capability when the draft distance is empty', () => {
  const { c } = nut()
  expect(connectorSlide(c, NaN, useStore.getState())).toMatchObject({ allowed: false, reason: 'invalid-distance' })
})
