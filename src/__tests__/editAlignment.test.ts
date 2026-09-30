import { expect, it } from 'vitest'
import * as THREE from 'three'
import { buildProfile } from '../utils/profileFactory'
import { computeTrims, createTrimResolver } from '../utils/jointUtils'
import { editAlignments, type EditAlignmentRequest } from '../utils/editAlignment'
import { computeDragSnap } from '../utils/dragSnap'
import type { ProfileData } from '../store/useStore'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const P = (id: string, from: THREE.Vector3, to: THREE.Vector3): ProfileData => ({
  ...buildProfile(from, to, '2020', id)!, fixedTrims: { start: 0, end: 0 },
})
const feedback = (profiles: ProfileData[], request: EditAlignmentRequest) => {
  const resolve = createTrimResolver(profiles)
  return editAlignments(profiles, new Map(profiles.map((p) => [p.id, resolve(p)])), request)
}

it('shows a first exact grid alignment without changing the existing snap decision', () => {
  const fixed = P('ref', V(0, 10, 0), V(600, 10, 0))
  const moving = P('moving', V(0, 10, 200), V(560, 10, 200))
  const snap = computeDragSnap([moving], new Map([[moving.id, moving.position]]), [fixed], 20, [], [0])
  expect(snap.guides).toEqual([])
  expect(snap.offset.length()).toBe(0)
  const lines = feedback([fixed, moving], { movingIds: [moving.id], axes: [0], guides: snap.guides })
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ kind: 'end', axis: 0, movingId: 'moving', refId: 'ref' })
  for (const point of [...lines[0].line, lines[0].from, lines[0].to]) expect(point[0]).toBeCloseTo(0)
  expect(new THREE.Vector3(...lines[0].line[0]).distanceTo(new THREE.Vector3(...lines[0].line[1]))).toBeGreaterThan(200)
})

it('draws a visible extended guide when the contacting face centres coincide', () => {
  const a = P('a', V(0, 10, 0), V(400, 10, 0))
  const b = P('b', V(400, 10, 0), V(700, 10, 0))
  const lines = feedback([a, b], { movingIds: ['b'], axes: [0], guides: [{
    axis: 0, kind: 'face', coord: 400, movingId: 'b', refId: 'a', movingSide: -1, refSide: 1,
  }] })
  expect(lines).toHaveLength(1)
  expect(new THREE.Vector3(...lines[0].from).distanceTo(new THREE.Vector3(...lines[0].to))).toBeLessThan(0.001)
  expect(new THREE.Vector3(...lines[0].line[0]).distanceTo(new THREE.Vector3(...lines[0].line[1]))).toBeGreaterThanOrEqual(40)
  expect(lines[0].movingFace?.profileId).toBe('b')
  expect(lines[0].referenceFace?.profileId).toBe('a')
})

it.each(['start', 'end'] as const)('shows only the grabbed %s cap against a remote actual end plane', (end) => {
  const reference = P('ref', V(0, 10, 0), V(600, 10, 0))
  const moving = P('moving', V(0, 10, 300), V(600, 10, 300))
  const lines = feedback([reference, moving], { movingIds: ['moving'], resize: { id: 'moving', end } })
  expect(lines).toHaveLength(1)
  const expected = end === 'start' ? 0 : 600
  expect(lines[0].from[0]).toBeCloseTo(expected)
  expect(lines[0].to[0]).toBeCloseTo(expected)
  expect(lines[0].movingFace?.side).toBe(end === 'start' ? -1 : 1)
})

it('uses the fixed physical ends instead of the stored construction length during resizing', () => {
  const reference = { ...P('ref', V(0, 10, 0), V(600, 10, 0)), fixedTrims: { start: 25, end: 75 } }
  const moving = { ...P('moving', V(0, 10, 300), V(550, 10, 300)), fixedTrims: { start: 10, end: 25 } }
  const before = JSON.stringify([reference, moving])
  const lines = feedback([reference, moving], { movingIds: ['moving'], resize: { id: 'moving', end: 'end' } })
  expect(lines).toHaveLength(1)
  expect(lines[0].from[0]).toBeCloseTo(525)
  expect(lines[0].to[0]).toBeCloseTo(525)
  expect(JSON.stringify([reference, moving])).toBe(before)
  expect(computeTrims(moving, [reference, moving]).cutLength).toBe(515)
})

it('does not imply alignment for a nearly aligned cut end or an unchanged fixed end', () => {
  const reference = P('ref', V(0, 10, 0), V(600, 10, 0))
  const moving = P('moving', V(0, 10, 300), V(595, 10, 300))
  expect(feedback([reference, moving], { movingIds: ['moving'], resize: { id: 'moving', end: 'end' } })).toEqual([])
})

it('recognizes a stretched rail end aligned with an upright side', () => {
  const reference = P('ref', V(600, 0, 0), V(600, 800, 0))
  const moving = P('moving', V(0, 400, 0), V(590, 400, 0))
  const lines = feedback([reference, moving], { movingIds: ['moving'], resize: { id: 'moving', end: 'end' } })
  expect(lines).toHaveLength(1)
  expect(lines[0].movingFace?.axis).toBe(2)
  expect(lines[0].referenceFace?.axis).not.toBe(2)
  expect(lines[0].from[0]).toBeCloseTo(590)
  expect(lines[0].to[0]).toBeCloseTo(590)
})

it('handles reversed drawing direction without swapping the grabbed physical cap', () => {
  const reference = P('ref', V(600, 10, 0), V(0, 10, 0))
  const moving = P('moving', V(600, 10, 300), V(0, 10, 300))
  const lines = feedback([reference, moving], { movingIds: ['moving'], resize: { id: 'moving', end: 'start' } })
  expect(lines[0].from[0]).toBeCloseTo(600)
  expect(lines[0].movingFace?.side).toBe(-1)
})

it('keeps oblique true cap planes but never substitutes their axis-aligned bounding box', () => {
  const reference = P('ref', V(0, 10, 0), V(400, 10, 400))
  const moving = P('moving', V(100, 10, -100), V(500, 10, 300))
  const lines = feedback([reference, moving], { movingIds: ['moving'], resize: { id: 'moving', end: 'end' } })
  expect(lines).toHaveLength(1)
  expect(lines[0].axis).toBeNull()
  const normal = new THREE.Vector3(...lines[0].referenceFace!.normal)
  for (const point of lines[0].line) expect(new THREE.Vector3(...point).sub(new THREE.Vector3(...lines[0].to)).dot(normal)).toBeCloseTo(0)
})

it('limits incidental matches to one nearest reference per permitted move axis', () => {
  const moving = P('moving', V(0, 10, 300), V(600, 10, 300))
  const references = Array.from({ length: 20 }, (_, i) => P(`ref-${i}`, V(0, 10, -i * 100), V(600, 10, -i * 100)))
  const lines = feedback([...references, moving], { movingIds: ['moving'], axes: [0] })
  expect(lines).toHaveLength(1)
  expect(lines[0].refId).toBe('ref-0')
})

it('does not use another moving group member as a stationary alignment reference', () => {
  const a = P('a', V(0, 10, 0), V(600, 10, 0))
  const b = P('b', V(0, 10, 300), V(600, 10, 300))
  expect(feedback([a, b], { movingIds: ['a', 'b'], axes: [0, 2] })).toEqual([])
})

it('drops stale snap metadata if the final moved faces no longer share its plane', () => {
  const a = P('a', V(0, 10, 0), V(600, 10, 0))
  const b = P('b', V(17, 10, 300), V(617, 10, 300))
  expect(feedback([a, b], { movingIds: ['b'], axes: [0], guides: [{
    axis: 0, kind: 'end', coord: 0, movingId: 'b', refId: 'a', movingSide: -1, refSide: -1,
  }] })).toEqual([])
})

it('keeps a deliberate centre alignment as a coordinate line without inventing a physical face', () => {
  const a = P('a', V(0, 10, 0), V(600, 10, 0))
  const b = P('b', V(20, 10, 200), V(580, 10, 200))
  const lines = feedback([a, b], { movingIds: ['b'], axes: [0], guides: [{ axis: 0, kind: 'center', coord: 300, refId: 'a' }] })
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ kind: 'center', movingFace: null, referenceFace: null })
  expect(lines[0].line.every((point) => Math.abs(point[0] - 300) < 0.001)).toBe(true)
})
