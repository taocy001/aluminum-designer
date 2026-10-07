import * as THREE from 'three'
import type { ConnectorData, PanelData, ProfileData } from '../store/useStore'
import { panelOBB, trimmedOBB } from './analysis'
import { computeAllTrims, type ProfileTrims } from './jointUtils'
import { seriesOf } from './connectorCatalog'
import { slotOffsets } from './specUtils'
import type { HardwareFastener } from './connectorHardware'
import type { OBB } from './obb'

export type PanelMount = NonNullable<ConnectorData['panelMount']>
const down = new THREE.Vector3(0, -1, 0)
const eps = .05
export function validPanelMount(value: unknown): value is PanelMount {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const m = value as PanelMount
  return [m.panelId, m.profileId].every((id) => typeof id === 'string' && !!id.trim())
    && Number.isFinite(m.spacer) && m.spacer >= 0 && m.spacer <= 20
    && Number.isFinite(m.boardThickness) && m.boardThickness >= 6 && m.boardThickness <= 40
}
export function panelBoltLength(m: PanelMount): number {
  return Math.ceil((4 + m.spacer + m.boardThickness + 2 + 4 + 2) / 5) * 5
}
export function panelMountFasteners(m: PanelMount): HardwareFastener[] {
  return [
    { kind: 'bolt', count: 1, thread: 'M5', length: 10, standard: 'DIN 912' },
    { kind: 't-nut', count: 1, thread: 'M5', descriptionZh: 'B 型槽 6', descriptionEn: 'B-type slot 6' },
    { kind: 'bolt', count: 1, thread: 'M5', length: panelBoltLength(m), standard: 'DIN 912' },
    { kind: 'washer', count: 3, thread: 'M5', standard: 'ISO 7089', descriptionZh: '厚 1 mm', descriptionEn: '1 mm thick' },
    { kind: 'nut', count: 1, thread: 'M5', standard: 'DIN 934' },
    ...(m.spacer > 0 ? [{ kind: 'other' as const, count: 1, length: m.spacer,
      descriptionZh: '定长垫套，外径 10 / 内径 5.5 mm', descriptionEn: 'Cut spacer, OD 10 / ID 5.5 mm' }] : []),
  ]
}
export function panelMountFrame(c: ConnectorData) {
  const q = new THREE.Quaternion(...c.quaternion).normalize(), origin = new THREE.Vector3(...c.position)
  const normal = new THREE.Vector3(1, 0, 0).applyQuaternion(q)
  const across = new THREE.Vector3(0, 0, 1).applyQuaternion(q)
  return { origin, normal, across, railHole: origin.clone().addScaledVector(across, -10),
    boardHole: origin.clone().addScaledVector(across, 10) }
}
/** Board hole must pass through the face, with room for a 10 mm washer and edge margin. */
export function panelMountBoardFits(c: ConnectorData, body: OBB): boolean {
  const m = c.panelMount
  if (!m) return false
  const { normal, boardHole } = panelMountFrame(c)
  if (Math.abs(normal.dot(body.axes[2])) < .999999 || Math.abs(body.half.z * 2 - m.boardThickness) > eps) return false
  const face = boardHole.addScaledVector(normal, -m.spacer), delta = face.sub(body.center)
  return Math.abs(delta.dot(normal) - body.half.z) < eps
    && Math.abs(delta.dot(body.axes[0])) <= body.half.x - 10 + eps
    && Math.abs(delta.dot(body.axes[1])) <= body.half.y - 10 + eps
}
export function panelMountSupports(c: ConnectorData, profiles: ProfileData[], panels: PanelData[],
  trims: Map<string, ProfileTrims> = computeAllTrims(profiles)): string[] | null {
  const m = c.panelMount
  if (!validPanelMount(m) || c.type !== 'joining-plate' || (c.series ?? 20) !== 20) return null
  const panel = panels.find((p) => p.id === m.panelId), profile = profiles.find((p) => p.id === m.profileId)
  if (!panel || !['ply', 'mdf'].includes(panel.material) || !profile || seriesOf(profile.spec) !== 20 || profile.miterCuts.length) return null
  const { normal, across, railHole } = panelMountFrame(c)
  if (normal.dot(down) < .999999 || !panelMountBoardFits(c, panelOBB(panel))) return null
  const body = trimmedOBB(profile, trims.get(profile.id)!)
  const faceAxis = [0, 1].find((i) => Math.abs(normal.dot(body.axes[i])) > .999999)
  if (faceAxis === undefined || Math.abs(body.axes[2].y) > 1e-6) return null
  const lateral = 1 - faceAxis, delta = railHole.sub(body.center)
  if (Math.abs(across.dot(body.axes[lateral])) < .999999
    || Math.abs(delta.dot(normal) - body.half.getComponent(faceAxis)) > eps
    || Math.abs(delta.dot(body.axes[2])) > body.half.z - 10) return null
  if (!slotOffsets(body.half.getComponent(lateral) * 2, 20).some((s) => Math.abs(delta.dot(body.axes[lateral]) - s) < eps)) return null
  return [profile.id]
}

/** Two locations on each eligible rail; caller checks obstructions and duplicate installations. */
export function panelMountCandidates(panel: PanelData, profiles: ProfileData[],
  trims = computeAllTrims(profiles)): ConnectorData[] {
  if (panel.locked || !['ply', 'mdf'].includes(panel.material) || panel.thickness < 6 || panel.thickness > 40) return []
  const board = panelOBB(panel)
  if (Math.abs(board.axes[2].y) < .999999) return []
  const result: ConnectorData[] = []
  for (const profile of profiles) {
    if (seriesOf(profile.spec) !== 20 || profile.miterCuts.length) continue
    const body = trimmedOBB(profile, trims.get(profile.id)!)
    if (Math.abs(body.axes[2].y) > 1e-6) continue
    const faceAxis = [0, 1].find((i) => Math.abs(body.axes[i].y) > .999999)
    if (faceAxis === undefined) continue
    const lateral = 1 - faceAxis, axis = body.axes[lateral]
    const faceY = body.center.y - body.half.getComponent(faceAxis)
    const spacer = board.center.y - board.half.z - faceY
    if (spacer < -eps || spacer > 20) continue
    const longitudinal = body.axes[2]
    const boardLength = Math.abs(longitudinal.dot(board.axes[0])) * board.half.x
      + Math.abs(longitudinal.dot(board.axes[1])) * board.half.y
    const mid = board.center.clone().sub(body.center).dot(longitudinal)
    for (const slot of slotOffsets(body.half.getComponent(lateral) * 2, 20)) for (const sign of [-1, 1]) {
      const across = axis.clone().multiplyScalar(sign)
      const y = new THREE.Vector3().crossVectors(across, down)
      const quaternion = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(down, y, across)).toArray()
      for (const along of [mid - boardLength / 2, mid + boardLength / 2]) {
        const hole = body.center.clone().addScaledVector(longitudinal, along).addScaledVector(axis, slot)
        hole.y = faceY
        const candidate: ConnectorData = { id: 'panel-mount-candidate', type: 'joining-plate', series: 20,
          position: hole.addScaledVector(across, 10).toArray(), quaternion,
          panelMount: { panelId: panel.id, profileId: profile.id, spacer: Math.max(0, Math.round(spacer * 1000) / 1000), boardThickness: panel.thickness } }
        if (panelMountSupports(candidate, profiles, [panel], trims)) result.push(candidate)
      }
    }
  }
  return result
}
