import { afterEach, expect, it } from 'vitest'
import * as THREE from 'three'
import type { ProfileData, ProfileSpec } from '../store/useStore'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { constrainDrawingFaces } from '../utils/faceAlign'
import { buildProfile, prepareProfilePlacement, tryAddProfile } from '../utils/profileFactory'
import { drawingInput, prepareDrawingPreview } from '../utils/drawPreview'
import { drawingContacts } from '../utils/drawContacts'
import { computeTrims, setThroughRule, trimmedBox } from '../utils/jointUtils'
import { profileFace, profileFaceForWorldAxis } from '../utils/profileFaces'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const fixed = (start: THREE.Vector3, end: THREE.Vector3, id: string, spec: ProfileSpec = '4040'): ProfileData => ({
  ...buildProfile(start, end, spec, id)!, fixedTrims: { start: 0, end: 0 },
})
const corner = () => [
  { ...fixed(V(0, 400, 0), V(500, 400, 0), 'horizontal'), fixedTrims: { start: 0, end: 20 } },
  fixed(V(500, 400, 0), V(500, 400, 500), 'return'),
]
const edgeOptions = (p: ProfileData, side: -1 | 1 = 1) => ({
  startFace: profileFaceForWorldAxis(p, 1, 1)!,
  startAlignmentFace: { profileId: p.id, axis: 2 as const, side },
})
afterEach(() => { setThroughRule('rails'); useToolStore.getState().putDown() })

it('seats a new upright on the rail top and aligns its side to the real trimmed corner end', () => {
  const profiles = corner()
  const before = JSON.stringify(profiles)
  const preview = prepareDrawingPreview(V(500, 400, 0), V(500, 800, 0), '2020', profiles, edgeOptions(profiles[0]))!
  expect(preview.blocked).toBe(false)
  expect(preview.issue).toBeNull()
  expect(preview.position.x).toBeCloseTo(470)
  expect(preview.position.y).toBeCloseTo(420)
  const newSide = profileFaceForWorldAxis(preview.profile, 0, 1, preview.trims)!
  expect(newSide.corners.every((point) => Math.abs(point[0] - 480) < 0.001)).toBe(true)
  expect(preview.contacts).toHaveLength(2)
  expect(preview.contacts[0]).toMatchObject({ end: 'start', kind: 'contact' })
  expect(preview.contacts[0].purpose).toBeUndefined()
  expect(preview.contacts[0].patch!.length).toBeGreaterThanOrEqual(3)
  expect(preview.contacts[0].referenceAnchor[1]).toBeCloseTo(420)
  const alignment = preview.contacts[1]
  expect(alignment).toMatchObject({ end: 'start', kind: 'align', purpose: 'alignment', patch: null })
  expect(alignment.referenceAnchor[0]).toBeCloseTo(480)
  expect(alignment.memberAnchor[0]).toBeCloseTo(480)
  expect(alignment.referenceAnchor[1]).toBeCloseTo(420)
  expect(alignment.memberAnchor[1]).toBeCloseTo(420)
  expect(JSON.stringify(profiles)).toBe(before)
})

it.each([-1, 1] as const)('chooses the inside of the selected horizontal member at a collinear seam, side %s', (side) => {
  const left = fixed(V(0, 400, 0), V(500, 400, 0), 'left')
  const right = fixed(V(500, 400, 0), V(1000, 400, 0), 'right')
  const selected = side > 0 ? left : right
  const preview = prepareDrawingPreview(V(500, 400, 0), V(500, 800, 0), '2020', [left, right], edgeOptions(selected, side))!
  expect(preview.position.x).toBeCloseTo(side > 0 ? 490 : 510)
  expect(preview.position.y).toBeCloseTo(420)
  expect(profileFaceForWorldAxis(preview.profile, 0, side, preview.trims)!.center[0]).toBeCloseTo(500)
  expect(preview.contacts.map((c) => c.kind)).toEqual(['contact', 'align'])
  expect(preview.contacts[0].referenceFace.profileId).toBe(selected.id)
})

it.each([0, 1])('uses the actual rolled rectangular half-width for a quarter turn of %s', (quarters) => {
  const profiles = corner()
  const upright = buildProfile(V(500, 400, 0), V(500, 800, 0), '2040', 'new')!
  const q = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), quarters * Math.PI / 2)
    .multiply(new THREE.Quaternion(...upright.quaternion))
  upright.quaternion = q.toArray()
  const placement = constrainDrawingFaces(upright, profiles, edgeOptions(profiles[0]))
  expect(placement.blocked).toBe(false)
  expect(placement.profile.position[0]).toBeCloseTo(480 - (quarters ? 20 : 10))
  const trims = computeTrims(placement.profile, [...placement.referenceProfiles!, placement.profile])
  expect(profileFaceForWorldAxis(placement.profile, 0, 1, trims)!.center[0]).toBeCloseTo(480)
  expect(profileFace(placement.profile, { profileId: 'new', axis: 2, side: -1 }, trims).center[1]).toBeCloseTo(420)
})

it('keeps typed physical length, the seat and edge alignment identical in preview and commit', () => {
  const profiles = corner()
  useStore.getState().loadDocument({ profiles, connectors: [], panels: [], fittings: [], throughRule: 'rails' })
  const start = V(500, 400, 0), end = V(500, 800, 0), faces = edgeOptions(profiles[0])
  const preview = prepareDrawingPreview(start, end, '2020', profiles, faces, '365')!
  const input = drawingInput(start, end, faces, '365')!
  expect(preview.cutLength).toBe(365)
  expect(preview.position.x).toBeCloseTo(470)
  expect(preview.position.y).toBeCloseTo(420)
  expect(tryAddProfile(start, input.end, '2020', input.faces)).toBe(true)
  const placed = useStore.getState().profiles
  const newMember = placed[2]
  expect(newMember.position).toEqual(preview.profile.position)
  expect(newMember.quaternion).toEqual(preview.profile.quaternion)
  expect(newMember.fixedTrims).toEqual(preview.profile.fixedTrims)
  expect(computeTrims(newMember, placed).cutLength).toBe(preview.cutLength)
})

it('freezes the old automatic solids in one undoable change without changing any of their faces', () => {
  const a = buildProfile(V(0, 400, 0), V(500, 400, 0), '4040', 'a')!
  const b = buildProfile(V(500, 400, 0), V(500, 400, 500), '4040', 'b')!
  useStore.getState().loadDocument({ profiles: [a, b], connectors: [], panels: [], fittings: [], throughRule: 'rails' })
  const before = useStore.getState().profiles
  const bounds = before.map((p) => trimmedBox(p, computeTrims(p, before)))
  const past = useStore.getState().past.length
  const faces = edgeOptions(a)
  const edge = profileFace(a, faces.startAlignmentFace, computeTrims(a, before))
  expect(tryAddProfile(V(500, 400, 0), V(500, 800, 0), '2020', faces)).toBe(true)
  const placed = useStore.getState().profiles
  expect(useStore.getState().past.length).toBe(past + 1)
  for (let i = 0; i < before.length; i++) {
    const actual = trimmedBox(placed[i], computeTrims(placed[i], placed))
    expect(actual.min.distanceTo(bounds[i].min)).toBeLessThan(0.001)
    expect(actual.max.distanceTo(bounds[i].max)).toBeLessThan(0.001)
    expect(placed[i].position).toEqual(before[i].position)
    expect(placed[i].length).toEqual(before[i].length)
  }
  expect(profileFaceForWorldAxis(placed[2], 0, 1, computeTrims(placed[2], placed))!.center[0]).toBeCloseTo(edge.center[0])
  useStore.getState().undo()
  expect(useStore.getState().profiles).toEqual(before)
  expect(before.every((p) => !p.fixedTrims)).toBe(true)
  useStore.getState().redo()
  expect(useStore.getState().profiles).toEqual(placed)
})

it('refuses drawing into the chosen top face before applying its edge alignment', () => {
  const profiles = corner()
  const preview = prepareDrawingPreview(V(500, 400, 0), V(500, 200, 0), '2020', profiles, edgeOptions(profiles[0]))!
  expect(preview.blocked).toBe(true)
  expect(preview.issue).toBe('face-direction')
  expect(preview.contacts).toHaveLength(1)
  expect(preview.contacts[0].kind).toBe('rejected')
  expect(preview.referenceProfiles).toBe(profiles)
})

it('aligns the same actual rail end when drawing down from its underside', () => {
  const profiles = corner()
  const faces = { ...edgeOptions(profiles[0]), startFace: profileFaceForWorldAxis(profiles[0], 1, -1)! }
  const preview = prepareDrawingPreview(V(500, 400, 0), V(500, 100, 0), '2020', profiles, faces)!
  expect(preview.blocked).toBe(false)
  expect(preview.position.x).toBeCloseTo(470)
  expect(preview.position.y).toBeCloseTo(380)
  expect(profileFaceForWorldAxis(preview.profile, 0, 1, preview.trims)!.center[0]).toBeCloseTo(480)
  expect(preview.contacts.map((c) => c.kind)).toEqual(['contact', 'align'])
  expect(preview.contacts[0].referenceAnchor[1]).toBeCloseTo(380)
})

it.each(['rails', 'posts'] as const)('keeps sideways cap creation under %s unchanged even with an inapplicable edge hint', (rule) => {
  setThroughRule(rule)
  const rail = buildProfile(V(0, 400, 0), V(500, 400, 0), '4040', 'rail')!
  const start = V(500, 400, 0), end = V(500, 800, 0)
  const startFace = { profileId: rail.id, axis: 2 as const, side: 1 as const }
  const automatic = prepareProfilePlacement(start, end, '2020', [rail], { startFace, id: 'new' })!
  const hinted = prepareProfilePlacement(start, end, '2020', [rail], { startFace, startAlignmentFace: startFace, id: 'new' })!
  expect(hinted).toEqual(automatic)
  expect(hinted.referenceProfiles).toBeUndefined()
})

it('does not label a supplementary plane that the final new side did not reach', () => {
  const profiles = corner()
  const faces = edgeOptions(profiles[0])
  const preview = prepareDrawingPreview(V(500, 400, 0), V(500, 800, 0), '2020', profiles, faces)!
  const moved = { ...preview.profile, position: [...preview.profile.position] as [number, number, number] }
  moved.position[0] -= 1
  const contacts = drawingContacts(moved, preview.trims, preview.referenceProfiles, faces)
  expect(contacts.every((c) => !c.purpose)).toBe(true)
})

it('ignores a supplementary cap whose normal follows the new drawing direction', () => {
  const profiles = corner()
  const vertical = fixed(V(500, 0, 0), V(500, 400, 0), 'vertical')
  const faces = { ...edgeOptions(profiles[0]), startAlignmentFace: { profileId: vertical.id, axis: 2 as const, side: 1 as const } }
  const plain = prepareDrawingPreview(V(500, 400, 0), V(500, 800, 0), '2020', [...profiles, vertical], { startFace: faces.startFace })!
  const hinted = prepareDrawingPreview(V(500, 400, 0), V(500, 800, 0), '2020', [...profiles, vertical], faces)!
  expect(hinted.profile).toEqual(plain.profile)
  expect(hinted.contacts.every((c) => !c.purpose)).toBe(true)
})

it('ignores a stale alignment from a different member instead of moving off the chosen support', () => {
  const profiles = corner()
  const distant = fixed(V(1000, 400, 0), V(1500, 400, 0), 'distant')
  const startFace = edgeOptions(profiles[0]).startFace
  const faces = { startFace, startAlignmentFace: { profileId: distant.id, axis: 2 as const, side: 1 as const } }
  const start = V(450, 400, 0), end = V(450, 800, 0), scene = [...profiles, distant]
  const plain = prepareDrawingPreview(start, end, '2020', scene, { startFace })!
  const hinted = prepareDrawingPreview(start, end, '2020', scene, faces)!
  expect(hinted.profile).toEqual(plain.profile)
  expect(hinted.contacts).toEqual(plain.contacts)
  expect(hinted.contacts[0].kind).toBe('contact')
})

it.each([
  { alongX: true, side: 1 as const }, { alongX: true, side: -1 as const },
  { alongX: false, side: 1 as const }, { alongX: false, side: -1 as const },
])('seats an upright on the through member at a T joint: %o', ({ alongX, side }) => {
  const through = fixed(alongX ? V(-500, 400, 0) : V(0, 400, -500), alongX ? V(500, 400, 0) : V(0, 400, 500), 'through')
  const branch = { ...fixed(V(0, 400, 0), alongX ? V(0, 400, side * 500) : V(side * 500, 400, 0), 'branch'),
    fixedTrims: { start: 20, end: 0 } }
  const axis = alongX ? 2 : 0
  const faces = { startFace: profileFaceForWorldAxis(through, 1, 1)!, startAlignmentFace: profileFaceForWorldAxis(through, axis, side)! }
  const profiles = [through, branch]
  const preview = prepareDrawingPreview(V(0, 400, 0), V(0, 800, 0), '2020', profiles, faces, '365')!
  expect(preview.blocked).toBe(false)
  expect(preview.issue).toBeNull()
  expect(preview.position.y).toBeCloseTo(420)
  expect(preview.position.getComponent(axis)).toBeCloseTo(side * 10)
  expect(preview.cutLength).toBe(365)
  const contact = preview.contacts.find((c) => c.kind === 'contact')!
  expect(contact.referenceFace.profileId).toBe('through')
  expect(contact.patch!.length).toBeGreaterThanOrEqual(3)
  expect(contact.patch!.every((point) => Math.abs(point[1] - 420) < 0.001)).toBe(true)
  const aligned = preview.contacts.find((c) => c.purpose === 'alignment')!
  expect(aligned.referenceFace.profileId).toBe('through')
  expect(aligned.memberFace!.corners.every((point) => Math.abs(point[axis] - side * 20) < 0.001)).toBe(true)
  expect(profileFace(branch, { profileId: 'branch', axis: 2, side: -1 }).center[axis]).toBeCloseTo(side * 20)
  expect(preview.referenceProfiles).toEqual(profiles)
})

it('commits a T-joint upright once, preserving both original solids and the preview', () => {
  const through = fixed(V(-500, 400, 0), V(500, 400, 0), 'through')
  const branch = { ...fixed(V(0, 400, 0), V(0, 400, 500), 'branch'), fixedTrims: { start: 20, end: 0 } }
  const profiles = [through, branch]
  useStore.getState().loadDocument({ profiles, connectors: [], panels: [], fittings: [], throughRule: 'rails' })
  const before = useStore.getState().past.length
  const start = V(0, 400, 0), end = V(0, 800, 0)
  const faces = { startFace: profileFaceForWorldAxis(through, 1, 1)!, startAlignmentFace: profileFaceForWorldAxis(through, 2, 1)! }
  const preview = prepareDrawingPreview(start, end, '4040', profiles, faces, '365')!
  const input = drawingInput(start, end, faces, '365')!
  expect(tryAddProfile(start, input.end, '4040', input.faces)).toBe(true)
  const placed = useStore.getState().profiles
  expect(placed.slice(0, 2)).toEqual(profiles)
  expect(placed[2].position).toEqual(preview.profile.position)
  expect(placed[2].length).toEqual(preview.profile.length)
  expect(placed[2].fixedTrims).toEqual(preview.profile.fixedTrims)
  expect(useStore.getState().past.length).toBe(before + 1)
  useStore.getState().undo()
  expect(useStore.getState().profiles).toEqual(profiles)
})
