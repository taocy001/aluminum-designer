import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { remapCopiedBindings } from '../utils/bindingCopies'
import type { ProjectGeometry } from '../utils/document'
import { profileBodyEndpoints } from '../utils/profileFaces'
import { boundProject } from './fixtures/bindings'

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
const empty = (): ProjectGeometry => ({ profiles: [], connectors: [], panels: [], fittings: [] })
const copiesOf = (source: ProjectGeometry, suffix = '-copy'): ProjectGeometry => ({
  profiles: source.profiles.map((part) => ({ ...clone(part), id: part.id + suffix })),
  connectors: source.connectors.map((part) => ({ ...clone(part), id: part.id + suffix })),
  panels: source.panels.map((part) => ({ ...clone(part), id: part.id + suffix })),
  fittings: source.fittings.map((part) => ({ ...clone(part), id: part.id + suffix })),
})

describe('copied assembly bindings', () => {
  it('maps every dependency to the corresponding copy without mutating inputs', () => {
    const source = boundProject(), copies = copiesOf(source)
    const beforeSource = clone(source), beforeCopies = clone(copies)
    const result = remapCopiedBindings(source, copies)
    for (const part of [...result.fittings, ...result.panels]) {
      const opening = part.openingBinding!.opening
      expect(Object.values(opening).map((ref) => ref.profileId)).toEqual(['left-copy', 'right-copy', 'bottom-copy', 'top-copy', 'left-copy', 'back-copy'])
    }
    expect(result.profiles.at(-1)!.runnerBinding).toEqual({ fittingId: 'drawer-copy', side: 'left', backOffset: 20, frontOffset: 20 })
    expect(result.connectors[0].supportBinding).toEqual({ ...source.connectors[0].supportBinding, profileId: 'runner-copy' })
    expect(source).toEqual(beforeSource)
    expect(copies).toEqual(beforeCopies)
    result.fittings[0].openingBinding!.opening.left.side = -1
    result.panels[0].openingBinding!.margins.left = 99
    result.connectors[0].supportBinding!.localPosition[0] = 99
    expect(source).toEqual(beforeSource)
    expect(copies).toEqual(beforeCopies)
  })

  it.each(['profiles', 'fittings', 'panels', 'connectors'] as const)('detaches an isolated derived %s copy', (kind) => {
    const project = boundProject(), source = empty()
    if (kind === 'profiles') source.profiles = [project.profiles.at(-1)!]
    else if (kind === 'fittings') source.fittings = [project.fittings[0]]
    else if (kind === 'panels') source.panels = project.panels
    else source.connectors = project.connectors
    const copies = copiesOf(source), result = remapCopiedBindings(source, copies)
    const actual = result[kind][0]
    expect(actual).not.toHaveProperty('openingBinding')
    expect(actual).not.toHaveProperty('runnerBinding')
    expect(actual).not.toHaveProperty('supportBinding')
    expect(actual.position).toEqual(copies[kind][0].position)
  })

  it('detaches an opening if any face is absent, while retaining complete internal dependencies', () => {
    const source = boundProject()
    source.profiles = source.profiles.filter((part) => part.id !== 'back')
    const result = remapCopiedBindings(source, copiesOf(source))
    expect(result.fittings.every((part) => part.openingBinding === undefined)).toBe(true)
    expect(result.panels[0].openingBinding).toBeUndefined()
    expect(result.profiles.at(-1)!.runnerBinding!.fittingId).toBe('drawer-copy')
    expect(result.connectors[0].supportBinding!.profileId).toBe('runner-copy')
  })

  it('preserves fixed opening depth without requiring a back source', () => {
    const source = boundProject()
    const opening = source.fittings[0].openingBinding!.opening
    delete opening.back
    opening.fixedDepth = 480
    source.profiles = source.profiles.filter((part) => part.id !== 'back')
    const result = remapCopiedBindings(source, copiesOf(source))
    expect(result.fittings[0].openingBinding!.opening).toMatchObject({ fixedDepth: 480, left: { profileId: 'left-copy' } })
    expect(result.fittings[0].openingBinding!.opening.back).toBeUndefined()
  })

  it('keeps each array instance internally linked', () => {
    const source = boundProject()
    for (const suffix of ['-1', '-2', '-3']) {
      const result = remapCopiedBindings(source, copiesOf(source, suffix))
      expect(result.fittings[0].openingBinding!.opening.left.profileId).toBe(`left${suffix}`)
      expect(result.profiles.at(-1)!.runnerBinding!.fittingId).toBe(`drawer${suffix}`)
      expect(result.connectors[0].supportBinding!.profileId).toBe(`runner${suffix}`)
    }
  })

  it.each(['profiles', 'fittings', 'panels', 'connectors'] as const)('rejects mismatched %s correspondence', (kind) => {
    const source = boundProject(), copies = copiesOf(source)
    copies[kind].pop()
    expect(() => remapCopiedBindings(source, copies)).toThrow('matching lengths')
  })
})

describe('mirrored bindings', () => {
  it('reflects profile-local X faces, opening sides, door interval and runner side', () => {
    const source = boundProject()
    const result = remapCopiedBindings(source, copiesOf(source), { mirror: true })
    const binding = result.fittings[1].openingBinding!
    expect(binding.opening.left).toEqual({ profileId: 'right-copy', axis: 0, side: 1 })
    expect(binding.opening.right).toEqual({ profileId: 'left-copy', axis: 0, side: -1 })
    expect(binding.opening.bottom).toEqual({ profileId: 'bottom-copy', axis: 1, side: 1 })
    expect(binding.opening.back).toEqual({ profileId: 'back-copy', axis: 0, side: 1 })
    expect(binding).toMatchObject({ mode: 'door', start: 0.6, end: 0.9 })
    expect(result.fittings[0].openingBinding).toMatchObject({ mode: 'drawer', bottomOffset: 0 })
    expect(result.profiles.at(-1)!.runnerBinding).toMatchObject({ side: 'right', backOffset: 20, frontOffset: 20 })
  })

  it.each(['front', 'back', 'left', 'right', 'top', 'bottom'] as const)('reflects the margins of a %s panel', (mode) => {
    const source = boundProject()
    source.panels[0].openingBinding!.mode = mode
    const result = remapCopiedBindings(source, copiesOf(source), { mirror: true })
    expect(result.panels[0].openingBinding).toMatchObject({
      mode: mode === 'left' ? 'right' : mode === 'right' ? 'left' : mode,
      margins: { left: 5, right: 2, bottom: 2, top: 1 }, normalOffset: -2,
    })
  })

  it.each(['start', 'end'] as const)('reconstructs connector pose relative to the actual copied %s face', (end) => {
    const source = boundProject(), copies = copiesOf(source)
    source.connectors[0].supportBinding!.end = end
    const rail = copies.profiles.at(-1)!, connector = copies.connectors[0]
    rail.position = [100, 300, 50]
    rail.quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.7, -0.2)).toArray()
    rail.fixedTrims = { start: 15, end: 25 }
    connector.position = [240, 320, -60]
    connector.quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.8, 0.1, 1.2)).toArray()
    const result = remapCopiedBindings(source, copies, { mirror: true })
    const binding = result.connectors[0].supportBinding!
    const restoredPosition = new THREE.Vector3(...binding.localPosition).applyQuaternion(new THREE.Quaternion(...rail.quaternion))
      .add(profileBodyEndpoints(rail)[end])
    const restoredQuaternion = new THREE.Quaternion(...rail.quaternion).multiply(new THREE.Quaternion(...binding.localQuaternion))
    expect(restoredPosition.distanceTo(new THREE.Vector3(...connector.position))).toBeLessThan(1e-9)
    expect(restoredQuaternion.angleTo(new THREE.Quaternion(...connector.quaternion))).toBeLessThan(1e-7)
    expect(binding.profileId).toBe('runner-copy')
    expect(binding.end).toBe(end)
  })
})
