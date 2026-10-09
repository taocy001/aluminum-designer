import * as THREE from 'three'
import type { ConnectorData } from '../store/useStore'
import type { BindingDocument } from './openingBindings'
import { panelOBB } from './analysis'
import { computeAllTrims } from './jointUtils'
import { panelMountFrame, panelMountSupports } from './panelMounts'
import { createConnectorPlacementValidator } from './connectorPlacement'

type Result = { status: 'resolved'; connectors: ConnectorData[] }
  | { status: 'blocked'; reason: 'panel-mount'; partIds: string[] }
  | { status: 'rejected'; reason: 'locked-dependent'; partIds: string[] }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const point = (p: THREE.Vector3) => p.toArray().map(n => Math.round(n * 1e6) / 1e6) as ConnectorData['position']

/** Follow the recorded board and rail; retain the slot and the hole's fraction along the board. */
export function resizePanelMounts(before: BindingDocument, after: BindingDocument): Result {
  const affected = after.connectors.filter(c => c.panelMount && (
    !same(before.profiles.find(p => p.id === c.panelMount!.profileId), after.profiles.find(p => p.id === c.panelMount!.profileId))
    || !same(before.panels.find(p => p.id === c.panelMount!.panelId), after.panels.find(p => p.id === c.panelMount!.panelId))))
  if (!affected.length) return { status: 'resolved', connectors: after.connectors }
  const oldTrims = computeAllTrims(before.profiles, before.throughRule)
  const trims = computeAllTrims(after.profiles, after.throughRule)
  const replacements = new Map<string, ConnectorData>()
  const invalid: string[] = [], locked: string[] = []
  for (const c of affected) {
    const mount = c.panelMount!
    const old = before.connectors.find(p => p.id === c.id)
    const oldRail = before.profiles.find(p => p.id === mount.profileId), rail = after.profiles.find(p => p.id === mount.profileId)
    const oldPanel = before.panels.find(p => p.id === mount.panelId), panel = after.panels.find(p => p.id === mount.panelId)
    if (!old || !oldRail || !rail || !oldPanel || !panel || !panelMountSupports(old, before.profiles, before.panels, oldTrims)) {
      invalid.push(c.id); continue
    }
    const oldQ = new THREE.Quaternion(...oldRail.quaternion).normalize(), q = new THREE.Quaternion(...rail.quaternion).normalize()
    const rotation = q.clone().multiply(oldQ.clone().invert())
    const oldAxis = new THREE.Vector3(0, 0, 1).applyQuaternion(oldQ), axis = new THREE.Vector3(0, 0, 1).applyQuaternion(q)
    const oldBoard = panelOBB(oldPanel), board = panelOBB(panel)
    const extent = (body: ReturnType<typeof panelOBB>, along: THREE.Vector3) =>
      Math.abs(body.axes[0].dot(along)) * body.half.x + Math.abs(body.axes[1].dot(along)) * body.half.y
    const fraction = panelMountFrame(old).boardHole.sub(oldBoard.center).dot(oldAxis) / extent(oldBoard, oldAxis)
    const derived: ConnectorData = { ...c,
      position: point(new THREE.Vector3(...old.position).sub(new THREE.Vector3(...oldRail.position))
        .applyQuaternion(rotation).add(new THREE.Vector3(...rail.position))),
      quaternion: rotation.multiply(new THREE.Quaternion(...old.quaternion)).normalize().toArray(),
      panelMount: { ...mount, boardThickness: panel.thickness },
    }
    const frame = panelMountFrame(derived)
    const along = board.center.dot(axis) + fraction * extent(board, axis) - frame.boardHole.dot(axis)
    derived.position = point(new THREE.Vector3(...derived.position).addScaledVector(axis, along))
    if (mount.mode !== 'direct') {
      const gap = panelMountFrame(derived).boardHole.sub(board.center).dot(frame.normal) - board.half.z
      derived.panelMount!.spacer = Math.round(gap * 1e6) / 1e6
    }
    if (!panelMountSupports(derived, after.profiles, after.panels, trims)) { invalid.push(c.id); continue }
    const moved = new THREE.Vector3(...old.position).distanceTo(new THREE.Vector3(...derived.position)) > 1e-6
      || Math.abs(new THREE.Quaternion(...old.quaternion).normalize().dot(new THREE.Quaternion(...derived.quaternion))) < 1 - 1e-10
      || !same(old.panelMount, derived.panelMount)
    if (old.locked && moved) { locked.push(c.id); continue }
    replacements.set(c.id, moved ? derived : c)
  }
  if (locked.length) return { status: 'rejected', reason: 'locked-dependent', partIds: locked }
  if (invalid.length) return { status: 'blocked', reason: 'panel-mount', partIds: invalid }
  const connectors = after.connectors.map(c => replacements.get(c.id) ?? c)
  const validate = createConnectorPlacementValidator(after.profiles, after, trims)
  for (const c of connectors) if (replacements.has(c.id) && !validate(c, connectors.filter(other => other.id !== c.id)).allowed) invalid.push(c.id)
  return invalid.length ? { status: 'blocked', reason: 'panel-mount', partIds: invalid } : { status: 'resolved', connectors }
}
