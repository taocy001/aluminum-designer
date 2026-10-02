import * as THREE from 'three'
import type { ProjectGeometry } from './document'
import type { OpeningRef } from './openingBindings'
import { profileBodyEndpoints } from './profileFaces'

const roles = ['left', 'right', 'bottom', 'top', 'front', 'back'] as const

/** Remap one copied assembly. Each source array corresponds to its copy in the same order. */
export function remapCopiedBindings(
  source: ProjectGeometry, copies: ProjectGeometry, options: { mirror?: boolean } = {},
): ProjectGeometry {
  const mapping = <T extends { id: string }>(before: T[], after: T[]) => {
    if (before.length !== after.length) throw new Error('Copied part arrays must have matching lengths')
    return new Map(before.map((part, i) => [part.id, after[i].id]))
  }
  const profiles = mapping(source.profiles, copies.profiles)
  const fittings = mapping(source.fittings, copies.fittings)
  mapping(source.panels, copies.panels)
  mapping(source.connectors, copies.connectors)
  const mirror = !!options.mirror
  const openingCopy = (opening: OpeningRef): OpeningRef | undefined => {
    const result = { ...opening }
    for (const role of roles) {
      const ref = opening[role]
      if (!ref) continue
      const profileId = profiles.get(ref.profileId)
      if (!profileId) return undefined
      result[role] = { ...ref, profileId, side: mirror && ref.axis === 0 ? (ref.side === 1 ? -1 : 1) : ref.side }
    }
    if (mirror) [result.left, result.right] = [result.right, result.left]
    return result
  }
  const profileCopies = copies.profiles.map((part, i) => {
    const { runnerBinding: omitted, ...copy } = part
    const binding = source.profiles[i].runnerBinding
    const fittingId = binding && fittings.get(binding.fittingId)
    if (!binding || !fittingId) return copy
    return { ...copy, runnerBinding: { ...binding, fittingId,
      side: mirror ? (binding.side === 'left' ? 'right' : 'left') : binding.side } }
  }) as ProjectGeometry['profiles']
  const copiedProfiles = new Map(profileCopies.map((part) => [part.id, part]))
  return {
    ...(copies.equipment !== undefined ? { equipment: copies.equipment.map((e) => ({ ...e, clearance: { ...e.clearance } })) } : {}),
    profiles: profileCopies,
    fittings: copies.fittings.map((part, i) => {
      const { openingBinding: omitted, ...copy } = part
      const binding = source.fittings[i].openingBinding
      const opening = binding && openingCopy(binding.opening)
      if (!binding || !opening) return copy
      return { ...copy, openingBinding: binding.mode === 'door'
        ? { ...binding, opening, start: mirror ? 1 - binding.end : binding.start, end: mirror ? 1 - binding.start : binding.end }
        : { ...binding, opening } }
    }),
    panels: copies.panels.map((part, i) => {
      const { openingBinding: omitted, ...copy } = part
      const binding = source.panels[i].openingBinding
      const opening = binding && openingCopy(binding.opening)
      if (!binding || !opening) return copy
      const margins = { ...binding.margins }
      if (mirror) [margins.left, margins.right] = [margins.right, margins.left]
      const mode = mirror && binding.mode === 'left' ? 'right' : mirror && binding.mode === 'right' ? 'left' : binding.mode
      return { ...copy, openingBinding: { ...binding, opening, margins, mode } }
    }),
    connectors: copies.connectors.map((part, i) => {
      const { supportBinding: omitted, ...copy } = part
      const binding = source.connectors[i].supportBinding
      const profileId = binding && profiles.get(binding.profileId)
      if (!binding || !profileId) return copy
      const remapped = { ...binding, profileId,
        localPosition: [...binding.localPosition] as typeof binding.localPosition,
        localQuaternion: [...binding.localQuaternion] as typeof binding.localQuaternion }
      if (mirror) {
        const rail = copiedProfiles.get(profileId)!
        const endpoint = profileBodyEndpoints(rail)[binding.end]
        const inverse = new THREE.Quaternion(...rail.quaternion).normalize().invert()
        remapped.localPosition = new THREE.Vector3(...part.position).sub(endpoint).applyQuaternion(inverse)
          .toArray() as typeof binding.localPosition
        remapped.localQuaternion = inverse.multiply(new THREE.Quaternion(...part.quaternion).normalize()).normalize()
          .toArray() as typeof binding.localQuaternion
      }
      return { ...copy, supportBinding: remapped }
    }),
  }
}
