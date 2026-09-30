import { afterEach, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { buildProfile, nextId } from '../utils/profileFactory'
import { prepareDrawingPreview } from '../utils/drawPreview'
import { setThroughRule } from '../utils/jointUtils'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
afterEach(() => { setThroughRule('rails'); vi.restoreAllMocks(); useToolStore.getState().putDown() })

it.each(['rails', 'posts'] as const)('previews the rotated 2040 section and its actual end cut under %s', (rule) => {
  setThroughRule(rule)
  const post = buildProfile(V(0, 0, 0), V(0, 800, 0), '4040')!
  const ghost = prepareDrawingPreview(V(0, 800, 0), V(600, 800, 0), '2040', [post])!
  const longSide = V(0, 1, 0).applyQuaternion(ghost.quaternion)
  expect(Math.abs(longSide.z)).toBeCloseTo(1)
  expect(ghost.position.x).toBeCloseTo(rule === 'rails' ? -20 : 20)
  expect(ghost.cutLength).toBeCloseTo(rule === 'rails' ? 620 : 580)
  expect(ghost.profile.position).toEqual([0, 800, 0])
  expect(ghost.profile.length).toBe(600)
})

it('moving the preview does not allocate document IDs, change geometry, or add history', () => {
  const post = buildProfile(V(0, 0, 0), V(0, 800, 0), '4040')!
  const original = JSON.stringify(post)
  const history = useStore.getState().past
  const document = useStore.getState().profiles
  vi.spyOn(Date, 'now').mockReturnValue(1000)
  const prefix = `probe-${(1000).toString(36)}`
  const before = parseInt(nextId('probe').slice(prefix.length), 36)
  for (let i = 0; i < 20; i++) prepareDrawingPreview(V(0, 800, 0), V(500 + i, 800, 0), '2040', [post])
  const after = parseInt(nextId('probe').slice(prefix.length), 36)
  expect(after).toBe((before + 1) % 1000)
  expect(JSON.stringify(post)).toBe(original)
  expect(useStore.getState().profiles).toBe(document)
  expect(useStore.getState().past).toBe(history)
})

it('an imported ID cannot hide a neighbour from preview trimming', () => {
  const post = buildProfile(V(0, 0, 0), V(0, 800, 0), '4040', '__drawing_preview__')!
  const ghost = prepareDrawingPreview(V(0, 800, 0), V(600, 800, 0), '2040', [post])!
  expect(ghost.profile.id).not.toBe(post.id)
  expect(ghost.trims.start.partners).toBe(1)
})

it('keeps the chosen start reference face and clears both faces when the gesture ends', () => {
  const face = { profileId: 'target', axis: 2 as const, side: 1 as const }
  const tool = useToolStore.getState()
  tool.setHover(V(0, 800, 0), V(0, 800, 0), 'endpoint', 'target', face)
  tool.beginDraw(V(0, 800, 0), face)
  expect(useToolStore.getState().drawStartFace).toEqual(face)
  expect(useToolStore.getState().drawSnapFace).toBeNull()
  tool.updateDraw({ drawSnapFace: { ...face, side: -1 } })
  tool.cancelDraw()
  expect(useToolStore.getState().drawStartFace).toBeNull()
  expect(useToolStore.getState().drawSnapFace).toBeNull()
})
