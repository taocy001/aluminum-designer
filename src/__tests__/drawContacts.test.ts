import { afterEach, expect, it } from 'vitest'
import * as THREE from 'three'
import { buildProfile } from '../utils/profileFactory'
import { prepareDrawingPreview } from '../utils/drawPreview'
import { closestPointOnFace, drawingContacts, type DrawingContact } from '../utils/drawContacts'
import { computeTrims, setThroughRule } from '../utils/jointUtils'
import { profileFaceForWorldAxis, type ProfileFaceRef } from '../utils/profileFaces'
import type { ProfileData } from '../store/useStore'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const P = (start: THREE.Vector3, end: THREE.Vector3, spec: '2020' | '4040' = '4040') => buildProfile(start, end, spec)!
const fixed = (p: ProfileData): ProfileData => ({ ...p, fixedTrims: { start: 0, end: 0 } })
afterEach(() => setThroughRule('rails'))

function expectRealPatch(contact: DrawingContact) {
  expect(contact.kind).toBe('contact')
  expect(contact.memberFace).not.toBeNull()
  expect(contact.patch!.length).toBeGreaterThanOrEqual(3)
  expect(new THREE.Vector3(...contact.referenceFace.normal).dot(new THREE.Vector3(...contact.memberFace!.normal))).toBeCloseTo(-1)
  for (const point of [...contact.patch!, contact.referenceAnchor, contact.memberAnchor]) {
    for (const face of [contact.referenceFace, contact.memberFace!]) {
      expect(new THREE.Vector3(...closestPointOnFace(face, point)).distanceTo(new THREE.Vector3(...point))).toBeLessThan(0.001)
    }
  }
  const origin = new THREE.Vector3(...contact.patch![0])
  const area = new THREE.Vector3()
  for (let i = 1; i < contact.patch!.length - 1; i++) {
    area.add(new THREE.Vector3(...contact.patch![i]).sub(origin).cross(new THREE.Vector3(...contact.patch![i + 1]).sub(origin)))
  }
  expect(area.length()).toBeGreaterThan(0.001)
}

it.each([1, -1] as const)('reports the true starting butt face when the selected Z side is %s', (side) => {
  const post = P(V(0, 0, 0), V(0, 800, 0))
  const startFace = profileFaceForWorldAxis(post, 2, side)!
  const preview = prepareDrawingPreview(V(0, 400, 0), V(600, 400, 0), '2020', [post], { startFace })!
  expect(preview.contacts).toHaveLength(1)
  const contact = preview.contacts[0]
  expectRealPatch(contact)
  expect(contact.referenceFace.normal[0]).toBeCloseTo(1)
  expect(contact.memberFace).toMatchObject({ axis: 2, side: -1 })
  expect(contact.referenceAnchor[0]).toBeCloseTo(20)
  expect(contact.referenceAnchor[1]).toBeCloseTo(400)
  expect(contact.referenceAnchor[2]).toBeCloseTo(side * 10)
})

it.each([1, -1] as const)('finds the actual contact when drawing outward along X direction %s', (side) => {
  const post = P(V(0, 0, 0), V(0, 800, 0))
  const preview = prepareDrawingPreview(V(0, 400, 0), V(side * 600, 400, 0), '2020', [post], {
    startFace: profileFaceForWorldAxis(post, 0, side)!,
  })!
  expectRealPatch(preview.contacts[0])
  expect(preview.contacts[0].referenceAnchor[0]).toBeCloseTo(side * 20)
})

it('pairs both ends with their actual opposing post faces', () => {
  const a = P(V(0, 0, 0), V(0, 800, 0)), b = P(V(600, 0, 0), V(600, 800, 0))
  const faces = { startFace: profileFaceForWorldAxis(a, 2, 1)!, endFace: profileFaceForWorldAxis(b, 2, 1)! }
  const preview = prepareDrawingPreview(V(0, 400, 0), V(600, 400, 0), '2020', [a, b], faces)!
  expect(preview.contacts.map((c) => c.end)).toEqual(['start', 'end'])
  preview.contacts.forEach(expectRealPatch)
  expect(preview.contacts[0].referenceAnchor[0]).toBeCloseTo(20)
  expect(preview.contacts[1].referenceAnchor[0]).toBeCloseTo(580)
})

it('marks a remote physical end plane as alignment, using its fixed cut rather than the model end', () => {
  const post = { ...P(V(0, 0, 0), V(0, 800, 0)), fixedTrims: { start: 100, end: 200 } }
  const preview = prepareDrawingPreview(V(600, 0, 0), V(600, 600, 0), '2020', [post], {
    endFace: { profileId: post.id, axis: 2, side: 1 },
  })!
  const contact = preview.contacts[0]
  expect(contact.kind).toBe('align')
  expect(contact.patch).toBeNull()
  expect(contact.referenceAnchor[1]).toBeCloseTo(600)
  expect(contact.memberAnchor[1]).toBeCloseTo(600)
  expect(new THREE.Vector3(...contact.referenceAnchor).distanceTo(new THREE.Vector3(...contact.memberAnchor))).toBeGreaterThan(500)
})

it('rejects an unpaired remote target whose physical end is on a different plane', () => {
  const post = { ...P(V(0, 0, 0), V(0, 800, 0)), fixedTrims: { start: 100, end: 200 } }
  const preview = prepareDrawingPreview(V(600, 0, 0), V(600, 800, 0), '2020', [post], {
    endFace: { profileId: post.id, axis: 2, side: 1 },
  })!
  expect(preview.contacts[0]).toMatchObject({ kind: 'rejected', patch: null })
})

it('an exact-length conflict keeps the start contact and rejects the ending target', () => {
  const a = P(V(0, 0, 0), V(0, 800, 0)), b = P(V(600, 0, 0), V(600, 800, 0))
  const preview = prepareDrawingPreview(V(0, 400, 0), V(600, 400, 0), '2020', [a, b], {
    startFace: profileFaceForWorldAxis(a, 0, 1)!, endFace: profileFaceForWorldAxis(b, 0, -1)!,
  }, '600')!
  expect(preview.issue).toBe('face-end-conflict')
  expect(preview.cutLength).toBe(600)
  expectRealPatch(preview.contacts[0])
  expect(preview.contacts[1]).toMatchObject({ end: 'end', kind: 'rejected', patch: null })
})

it('a blocked backwards draw never emits a successful contact', () => {
  const post = P(V(0, 0, 0), V(0, 800, 0))
  const preview = prepareDrawingPreview(V(0, 400, 0), V(-600, 400, 0), '2020', [post], {
    startFace: profileFaceForWorldAxis(post, 0, 1)!,
  })!
  expect(preview.blocked).toBe(true)
  expect(preview.contacts[0]).toMatchObject({ kind: 'rejected', patch: null })
})

it.each(['rails', 'posts'] as const)('describes the real cap/side attachment for sideways cap drawing under %s', (rule) => {
  setThroughRule(rule)
  const post = P(V(0, 0, 0), V(0, 800, 0))
  const preview = prepareDrawingPreview(V(0, 800, 0), V(600, 800, 0), '4040', [post], {
    startFace: { profileId: post.id, axis: 2, side: 1 },
  })!
  const contact = preview.contacts[0]
  expectRealPatch(contact)
  if (rule === 'rails') {
    expect(contact.referenceFace.axis).toBe(2)
    expect(contact.referenceAnchor[1]).toBeCloseTo(780)
    expect(contact.memberFace!.axis).not.toBe(2)
  } else {
    expect(contact.referenceFace.normal[0]).toBeCloseTo(1)
    expect(contact.memberFace!.axis).toBe(2)
  }
  expect(post.fixedTrims).toBeUndefined()
  expect(preview.profile.fixedTrims).toBeUndefined()
})

it('never describes line-only corner touching as a contact patch', () => {
  const a = fixed(P(V(0, 10, 0), V(400, 10, 0), '2020'))
  const b = fixed(P(V(410, 10, 10), V(410, 10, 310), '2020'))
  const contact = drawingContacts(b, computeTrims(b, [a, b]), [a], {
    startFace: { profileId: a.id, axis: 2, side: 1 },
  })[0]
  expect(contact.kind).not.toBe('contact')
  expect(contact.patch).toBeNull()
})

it('rejects a false cap intersection caused only by a rolled section AABB', () => {
  const a = fixed(P(V(0, 0, 0), V(0, 0, 100), '2020'))
  const b = fixed(P(V(23, 23, 100), V(23, 23, 200), '2020'))
  b.quaternion = new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), Math.PI / 4).toArray()
  const contact = drawingContacts(b, computeTrims(b, [a, b]), [a], {
    startFace: { profileId: a.id, axis: 2, side: 1 },
  })[0]
  expect(contact.kind).toBe('align')
  expect(contact.patch).toBeNull()
})

it('clips a rotated cap to a true finite overlap polygon', () => {
  const a = fixed(P(V(0, 0, 0), V(0, 0, 100), '2020'))
  const b = fixed(P(V(10, 0, 100), V(10, 0, 200), '2020'))
  b.quaternion = new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), Math.PI / 4).toArray()
  const contact = drawingContacts(b, computeTrims(b, [a, b]), [a], {
    startFace: { profileId: a.id, axis: 2, side: 1 },
  })[0]
  expectRealPatch(contact)
})

it('uses the closest actual trimmed face point when projecting a hover marker', () => {
  const p = { ...P(V(400, 0, 0), V(0, 0, 0)), fixedTrims: { start: 50, end: 100 } }
  const face = profileFaceForWorldAxis(p, 2, 1)!
  const point = closestPointOnFace(face, [600, 100, 100])
  expect(point[0]).toBeCloseTo(350)
  expect(point[1]).toBeCloseTo(20)
  expect(point[2]).toBeCloseTo(20)
})

it('does not invent a reference for a free drawing', () => {
  expect(prepareDrawingPreview(V(0, 10, 0), V(100, 10, 0), '2020', [])!.contacts).toEqual([])
})

it('reports selected same-facing coplanar sides as flush rather than a butt contact', () => {
  const a = fixed(P(V(0, 0, 0), V(0, 800, 0)))
  const b = fixed(P(V(0, 100, 10), V(0, 600, 10), '2020'))
  const startFace: ProfileFaceRef = profileFaceForWorldAxis(a, 2, 1)!
  const contact = drawingContacts(b, computeTrims(b, [a, b]), [a], { startFace })[0]
  expect(contact.kind).toBe('flush')
  expect(contact.referenceAnchor[2]).toBeCloseTo(20)
  expect(contact.memberAnchor[2]).toBeCloseTo(20)
  expect(contact.patch).toBeNull()
})
