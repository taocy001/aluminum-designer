import { expect, it } from 'vitest'
import * as THREE from 'three'
import { buildProfile } from '../utils/profileFactory'
import { computeAllTrims } from '../utils/jointUtils'
import { profileFace } from '../utils/profileFaces'
import { connectorSupportVisible } from '../utils/connectorVisibility'

it('uses the actual trimmed body when a section completely removes a support', () => {
  const profile = buildProfile(new THREE.Vector3(), new THREE.Vector3(0, 0, 200), '4040-B6', 'host')!
  profile.fixedTrims = { start: 40, end: 60 }
  const trims = computeAllTrims([profile]).get(profile.id)!
  expect(connectorSupportVisible(profile, trims, null)).toBe(true)
  expect(connectorSupportVisible(profile, trims, { axis: 'z', at: 30, flip: false })).toBe(false)
  expect(connectorSupportVisible(profile, trims, { axis: 'z', at: 40, flip: false })).toBe(true)
  expect(connectorSupportVisible(profile, trims, { axis: 'z', at: 80, flip: false })).toBe(true)
  expect(connectorSupportVisible(profile, trims, { axis: 'z', at: 150, flip: true })).toBe(false)
  expect(connectorSupportVisible(profile, trims, { axis: 'z', at: 140, flip: true })).toBe(true)
})

it('tests the full rolled section against either retained half-space on every world axis', () => {
  const profile = buildProfile(new THREE.Vector3(-80, 90, -130), new THREE.Vector3(-80, 90, 70), '2040', 'rotated')!
  profile.quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(.43, -.71, 1.14)).toArray()
  profile.fixedTrims = { start: 30, end: 45 }
  const trims = computeAllTrims([profile]).get(profile.id)!
  const points = ([-1, 1] as const).flatMap((side) => profileFace(profile,
    { profileId: profile.id, axis: 2, side }, trims).corners)
  for (const [index, axis] of (['x', 'y', 'z'] as const).entries()) {
    const low = Math.min(...points.map((point) => point[index])), high = Math.max(...points.map((point) => point[index]))
    expect(connectorSupportVisible(profile, trims, { axis, at: low - .001, flip: false })).toBe(false)
    expect(connectorSupportVisible(profile, trims, { axis, at: high + .001, flip: true })).toBe(false)
    for (const flip of [false, true]) {
      expect(connectorSupportVisible(profile, trims, { axis, at: (low + high) / 2, flip })).toBe(true)
    }
    expect(connectorSupportVisible(profile, trims, { axis, at: high + 1, flip: false })).toBe(true)
    expect(connectorSupportVisible(profile, trims, { axis, at: low - 1, flip: true })).toBe(true)
  }
})
