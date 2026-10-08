import * as THREE from 'three'
import { useStore, type ConnectorData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { connectorEntry } from './connectorCatalog'
import { nonCornerSupports } from './connectorMounting'
import { panelMountSupports } from './panelMounts'
import { getProfileDir } from './geometryCore'
import { validateConnectorPlacement } from './connectorPlacement'
import { placementObstacles } from './placementObstacles'
import { deriveSupport } from './openingBindings'
import { reportEditResult } from './editFeedback'

type Document = Pick<ReturnType<typeof useStore.getState>, 'profiles' | 'connectors' | 'panels' | 'equipment' | 'fittings'>
export function slideSupports(c: ConnectorData, doc: Document): string[] | null {
  if (c.panelMount) return panelMountSupports(c, doc.profiles, doc.panels)
  if (connectorEntry(c.type)?.fit !== 'face') return null
  return nonCornerSupports(c, doc.profiles)
}

/** Move along the existing slot; all original hosts must still support the same mounting faces. */
export function connectorSlide(c: ConnectorData, distance: number, doc: Document, includeConflicts = true) {
  const legs = slideSupports(c, doc)
  const hosts = doc.profiles.filter(p => legs?.includes(p.id))
  const axis = hosts[0] && getProfileDir(hosts[0])
  const supported = !!axis && !!legs?.length && hosts.every(p => Math.abs(getProfileDir(p).dot(axis)) > 0.999999)
  if (!supported) return { allowed: false, part: c, legs: legs ?? [], reason: 'fixed' as const, conflicts: [] as string[] }
  if (!Number.isFinite(distance)) return { allowed: false, part: c, legs, reason: 'invalid-distance' as const, conflicts: [] as string[] }
  const source = c.supportBinding && doc.profiles.find(p => p.id === c.supportBinding!.profileId)
  if (c.supportBinding && !source) return { allowed: false, part: c, legs, reason: 'no-joint' as const, conflicts: [] as string[] }
  const position = new THREE.Vector3(...c.position).addScaledVector(axis, distance).toArray() as ConnectorData['position']
  const binding = c.supportBinding
  const localDelta = axis.clone().multiplyScalar(distance).applyQuaternion(new THREE.Quaternion(...(source?.quaternion ?? [0, 0, 0, 1]) as [number, number, number, number]).normalize().invert())
  let part: ConnectorData = { ...c, position, ...(binding ? { supportBinding: { ...binding,
    localPosition: new THREE.Vector3(...binding.localPosition).add(localDelta).toArray() as [number, number, number] } } : {}) }
  if (binding && source) {
    const derived = deriveSupport(part, source)
    if (!derived || new THREE.Vector3(...derived.position).distanceTo(new THREE.Vector3(...position)) > .01
      || Math.abs(new THREE.Quaternion(...derived.quaternion).dot(new THREE.Quaternion(...c.quaternion).normalize())) < .999999) {
      return { allowed: false, part, legs, reason: 'no-joint' as const, conflicts: [] as string[] }
    }
    part = derived
  }
  const next = slideSupports(part, doc)
  if (!next || legs.some(id => !next.includes(id))) return { allowed: false, part, legs, reason: 'no-joint' as const, conflicts: [] as string[] }
  const status = validateConnectorPlacement(part, doc.profiles, doc.connectors, { ...doc, excludeConnectorId: c.id })
  return { ...status, part, legs, conflicts: status.allowed || !includeConflicts ? [] : placementObstacles(part, doc).map(o => o.id) }
}

export function moveConnectorAlongSlot(id: string, distance: number): boolean {
  if (useToolStore.getState().viewMode || !distance || !Number.isFinite(distance)) return false
  const doc = useStore.getState(), c = doc.connectors.find(p => p.id === id)
  if (!c || c.locked) return false
  const result = connectorSlide(c, distance, doc)
  if (!result.allowed) return false
  return reportEditResult(doc.commitTransform({ connectors: [{ id, updates: {
    position: result.part.position, supportBinding: result.part.supportBinding,
  } }] }))
}
