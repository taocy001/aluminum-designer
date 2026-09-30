import { afterEach, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { buildProfile, nextId, prepareProfile, prepareProfilePlacement, tryAddProfile, lowestPointY } from '../utils/profileFactory'
import { prepareDrawingPreview } from '../utils/drawPreview'
import { computeTrims, setThroughRule, trimmedBox } from '../utils/jointUtils'
import { profileFaceForWorldAxis } from '../utils/profileFaces'
import { getProfileEndpoints } from '../utils/geometryCore'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { analyzeFrame } from '../utils/analysis'

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

it.each([1, -1] as const)('uses the chosen Z=%s side for preview and ordinary commit', (side) => {
  const post = buildProfile(V(0, 0, 0), V(0, 800, 0), '4040')!
  const startFace = profileFaceForWorldAxis(post, 2, side)!
  const opts = { startFace }
  const ghost = prepareDrawingPreview(V(0, 400, 0), V(600, 400, 0), '2020', [post], opts)!
  const placed = prepareProfile(V(0, 400, 0), V(600, 400, 0), '2020', [post], opts)!
  expect(ghost.blocked).toBe(false)
  expect(ghost.profile.position[2]).toBe(side * 10)
  expect(placed.position).toEqual(ghost.profile.position)
  expect(placed.quaternion).toEqual(ghost.profile.quaternion)
  expect(computeTrims(placed, [post, placed]).cutLength).toBe(ghost.cutLength)
  // The new outward side is exactly on the selected 4040 face, not on its centreline.
  const outer = profileFaceForWorldAxis(placed, 2, side)!
  expect(outer.center[2]).toBeCloseTo(side * 20)
})

it.each([1, -1] as const)('pins the actual starting end to the chosen outward Z=%s face', (side) => {
  const post = buildProfile(V(0, 0, 0), V(0, 800, 0), '4040')!
  const startFace = profileFaceForWorldAxis(post, 2, side)!
  const ghost = prepareDrawingPreview(V(0, 400, 0), V(0, 400, side * 600), '2020', [post], { startFace })!
  expect(ghost.blocked).toBe(false)
  expect(ghost.position.z).toBeCloseTo(side * 20)
  expect(ghost.profile.fixedTrims?.start).toBe(20)
  expect(ghost.cutLength).toBe(580)
})

it('refuses drawing through the back of the selected face and keeps the drawing available', () => {
  const post = buildProfile(V(0, 0, 0), V(0, 800, 0), '4040')!
  const startFace = profileFaceForWorldAxis(post, 2, 1)!
  const ghost = prepareDrawingPreview(V(0, 400, 0), V(0, 400, -600), '2020', [post], { startFace })!
  expect(ghost.blocked).toBe(true)
  expect(ghost.issue).toBe('face-direction')
  useStore.getState().loadDocument({ profiles: [post], connectors: [], panels: [], fittings: [], throughRule: 'rails' })
  const before = useStore.getState().profiles
  const history = useStore.getState().past
  expect(tryAddProfile(V(0, 400, 0), V(0, 400, -600), '2020', { startFace })).toBe(false)
  expect(useStore.getState().profiles).toBe(before)
  expect(useStore.getState().past).toBe(history)
})

it.each(['rails', 'posts'] as const)('an end-cap pick followed by sideways drawing preserves %s corner trimming', (rule) => {
  setThroughRule(rule)
  const post = buildProfile(V(0, 0, 0), V(0, 800, 0), '4040')!
  const cap = { profileId: post.id, axis: 2 as const, side: 1 as const }
  const automatic = prepareDrawingPreview(V(0, 800, 0), V(600, 800, 0), '2040', [post])!
  const chosen = prepareDrawingPreview(V(0, 800, 0), V(600, 800, 0), '2040', [post], { startFace: cap })!
  expect(chosen.profile.position).toEqual(automatic.profile.position)
  expect(chosen.profile.quaternion).toEqual(automatic.profile.quaternion)
  expect(chosen.trims).toEqual(automatic.trims)
  expect(chosen.profile.fixedTrims).toBeUndefined()
})

it('retains the starting side and reports a conflicting ending side', () => {
  const a = buildProfile(V(0, 0, 0), V(0, 800, 0), '4040')!
  const b = buildProfile(V(600, 0, 0), V(600, 800, 0), '4040')!
  const startFace = profileFaceForWorldAxis(a, 2, 1)!
  const endFace = profileFaceForWorldAxis(b, 2, -1)!
  const placed = prepareProfilePlacement(V(0, 400, 0), V(600, 400, 0), '2020', [a, b], { startFace, endFace })!
  expect(placed.blocked).toBe(false)
  expect(placed.issue).toBe('face-end-conflict')
  expect(placed.profile.position[2]).toBe(10)
})

it('applies compatible side constraints at both ends', () => {
  const a = buildProfile(V(0, 0, 0), V(0, 800, 0), '4040')!
  const b = buildProfile(V(600, 0, 0), V(600, 800, 0), '4040')!
  const placed = prepareProfilePlacement(V(0, 400, 0), V(600, 400, 0), '2020', [a, b], {
    startFace: profileFaceForWorldAxis(a, 2, -1)!, endFace: profileFaceForWorldAxis(b, 2, -1)!,
  })!
  expect(placed.issue).toBeNull()
  expect(placed.profile.position[2]).toBe(-10)
})

it('an end-side choice cannot slide the starting point along its already chosen face', () => {
  const a = buildProfile(V(0, 0, 0), V(0, 800, 0), '4040')!
  const b = buildProfile(V(600, 500, -200), V(600, 500, 200), '4040')!
  const placed = prepareProfilePlacement(V(0, 400, 0), V(600, 400, 0), '2020', [a, b], {
    startFace: profileFaceForWorldAxis(a, 2, 1)!, endFace: profileFaceForWorldAxis(b, 1, 1)!,
  })!
  expect(placed.issue).toBe('face-end-conflict')
  expect(placed.profile.position).toEqual([0, 400, 10])
})

it('treats typed length as the actual cut length when an explicit side is selected', () => {
  const post = buildProfile(V(0, 0, 0), V(0, 800, 0), '4040')!
  for (const normal of [false, true]) {
    const startFace = profileFaceForWorldAxis(post, 2, 1)!
    const p = prepareProfile(V(0, 400, 0), normal ? V(0, 400, 600) : V(600, 400, 0), '2020', [post], { startFace, exactLength: 600 })!
    expect(computeTrims(p, [post, p]).cutLength).toBe(600)
    expect(p.fixedTrims).toBeDefined()
    if (normal) expect(new THREE.Vector3(...p.position).addScaledVector(getProfileEndpoints(p).end.sub(new THREE.Vector3(...p.position)).normalize(), p.fixedTrims!.start).z).toBeCloseTo(20)
    else expect(p.position[2]).toBe(10)
  }
  const automatic = prepareProfile(V(0, 400, 0), V(600, 400, 0), '2020', [post], { exactLength: 600 })!
  expect(automatic.length).toBe(600)
  expect(computeTrims(automatic, [post, automatic]).cutLength).toBe(580)
})

it('an unrelated remote endpoint remains an alignment reference instead of moving the member', () => {
  const post = buildProfile(V(0, 0, 0), V(0, 800, 0), '4040')!
  const selectedEnd = profileFaceForWorldAxis(post, 1, 1)!
  const p = prepareProfilePlacement(V(600, 0, 0), V(600, 800, 0), '2020', [post], { endFace: selectedEnd })!
  expect(p.issue).toBeNull()
  expect(p.profile.position).toEqual([600, 0, 0])
  expect(p.profile.length).toBe(800)
  expect(p.profile.fixedTrims).toBeUndefined()
})

it('uses fixed actual endpoints when keeping a sloping member above the floor', () => {
  const p = buildProfile(V(0, -20, 0), V(100, 80, 0), '2020')!
  p.fixedTrims = { start: 40, end: 0 }
  const physical = { ...p, position: getProfileEndpoints(p).start.addScaledVector(new THREE.Vector3(1, 1, 0).normalize(), 40).toArray() as [number, number, number], length: p.length - 40, fixedTrims: undefined }
  expect(lowestPointY(p)).toBeCloseTo(lowestPointY(physical))
})

it('does not call edge contact with an oblique reference face a flush side attachment', () => {
  const post = buildProfile(V(0, 0, 0), V(0, 800, 0), '4040')!
  post.quaternion = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), Math.PI / 4)
    .multiply(new THREE.Quaternion(...post.quaternion)).toArray()
  const chosen = prepareProfilePlacement(V(0, 400, 0), V(0, 600, 0), '2020', [post], {
    startFace: { profileId: post.id, axis: 0, side: 1 },
  })!
  expect(chosen.blocked).toBe(true)
  expect(chosen.issue).toBe('face-oblique')
})

it.each([790, 800])('preserves positive face contact near the reference end at y=%s in preview, commit and undo', (y) => {
  for (const axis of [0, 2] as const) for (const exactLength of [undefined, 600]) {
    const post = buildProfile(V(0, 0, 0), V(0, 800, 0), '4040')!
    useStore.getState().loadDocument({ profiles: [post], connectors: [], panels: [], fittings: [], throughRule: 'rails' })
    const source = useStore.getState().profiles
    const historySize = useStore.getState().past.length
    const startFace = profileFaceForWorldAxis(post, axis, 1)!
    const opts = { startFace, exactLength }
    const ghost = prepareDrawingPreview(V(0, y, 0), V(600, y, 0), '2020', source, opts)!
    expect(ghost.issue).toBeNull()
    expect(ghost.referenceProfiles[0].fixedTrims).toEqual({ start: 0, end: 0 })
    expect(post.fixedTrims).toBeUndefined()
    expect(useStore.getState().profiles).toBe(source)

    expect(tryAddProfile(V(0, y, 0), V(600, y, 0), '2020', opts)).toBe(true)
    const placed = useStore.getState().profiles
    expect(useStore.getState().past.length).toBe(historySize + 1)
    const a = trimmedBox(placed[0], computeTrims(placed[0], placed))
    const b = trimmedBox(placed[1], computeTrims(placed[1], placed))
    expect(a.max.y).toBeCloseTo(800)
    expect(a.max.x).toBeCloseTo(b.min.x)
    const area = (Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y))
      * (Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z))
    expect(area).toBeGreaterThan(0)
    expect(analyzeFrame(placed).conflictIds.size).toBe(0)
    expect(computeTrims(placed[1], placed).cutLength).toBe(ghost.cutLength)
    expect(placed[1].fixedTrims).toEqual(ghost.profile.fixedTrims)

    useStore.getState().undo()
    expect(useStore.getState().profiles).toEqual([post])
    expect(useStore.getState().profiles[0].fixedTrims).toBeUndefined()
    useStore.getState().redo()
    expect(useStore.getState().profiles).toEqual(placed)
  }
})

it('an end-cap sideways commit retains automatic through cuts without freezing its reference', () => {
  const post = buildProfile(V(0, 0, 0), V(0, 800, 0), '4040')!
  useStore.getState().loadDocument({ profiles: [post], connectors: [], panels: [], fittings: [], throughRule: 'rails' })
  const startFace = { profileId: post.id, axis: 2 as const, side: 1 as const }
  expect(tryAddProfile(V(0, 800, 0), V(600, 800, 0), '4040', { startFace })).toBe(true)
  const placed = useStore.getState().profiles
  expect(placed[0].fixedTrims).toBeUndefined()
  expect(placed[1].fixedTrims).toBeUndefined()
  expect(computeTrims(placed[0], placed).cutLength).toBe(780)
  expect(computeTrims(placed[1], placed).cutLength).toBe(620)
})

it('accepting a reference face preserves its existing automatic neighbours in the same transaction', () => {
  const post = buildProfile(V(0, 0, 0), V(0, 800, 0), '4040')!
  const rail = buildProfile(V(0, 800, 0), V(600, 800, 0), '4040')!
  useStore.getState().loadDocument({ profiles: [post, rail], connectors: [], panels: [], fittings: [], throughRule: 'rails' })
  const before = useStore.getState().profiles
  const beforeBodies = before.map((p) => trimmedBox(p, computeTrims(p, before)))
  expect(before.map((p) => computeTrims(p, before).cutLength)).toEqual([780, 620])
  const startFace = profileFaceForWorldAxis(post, 2, 1)!
  const preview = prepareDrawingPreview(V(0, 400, 0), V(0, 400, 600), '2020', before, { startFace })!
  expect(preview.referenceProfiles.every((p) => p.fixedTrims)).toBe(true)
  expect(tryAddProfile(V(0, 400, 0), V(0, 400, 600), '2020', { startFace })).toBe(true)
  const placed = useStore.getState().profiles
  for (let i = 0; i < before.length; i++) {
    const body = trimmedBox(placed[i], computeTrims(placed[i], placed))
    expect(body.min.distanceTo(beforeBodies[i].min)).toBeLessThan(1e-6)
    expect(body.max.distanceTo(beforeBodies[i].max)).toBeLessThan(1e-6)
  }
  useStore.getState().undo()
  expect(useStore.getState().profiles).toEqual(before)
  expect(useStore.getState().profiles.every((p) => !p.fixedTrims)).toBe(true)
})
