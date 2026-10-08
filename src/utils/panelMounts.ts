import * as THREE from 'three'
import type { ConnectorData, PanelData, ProfileData } from '../store/useStore'
import { panelOBB, trimmedOBB } from './analysis'
import { computeAllTrims, type ProfileTrims } from './jointUtils'
import { seriesOf } from './connectorCatalog'
import { slotOffsets } from './specUtils'
import type { HardwareFastener } from './connectorHardware'
import { accessoryNutDimensions } from './connectorAccessoryReferences'
import type { ConnectorSeries } from './connectorCatalog'
import type { OBB } from './obb'

export type PanelMount = NonNullable<ConnectorData['panelMount']>
const down = new THREE.Vector3(0, -1, 0)
const eps = .05
export function validPanelMount(value: unknown): value is PanelMount {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const m = value as PanelMount
  return [m.panelId, m.profileId].every((id) => typeof id === 'string' && !!id.trim())
    && (m.mode === undefined || m.mode === 'direct')
    && (m.mode !== 'direct' || m.spacer === 0)
    && Number.isFinite(m.spacer) && m.spacer >= 0 && m.spacer <= 20
    && Number.isFinite(m.boardThickness) && m.boardThickness >= 6 && m.boardThickness <= 40
}
export function panelFastenerSizes(series: ConnectorSeries = 20) {
  return series === 30 ? { thread: 'M6', diameter: 6, clearance: 6.6, washer: 1.6, washerBore: 6.4, washerRadius: 6,
    headHeight: 6, headRadius: 5, nut: 5, engagement: 7, railBolt: 12 }
    : { thread: 'M5', diameter: 5, clearance: 5.5, washer: 1, washerBore: 5.3, washerRadius: 5,
      headHeight: 5, headRadius: 4.25, nut: 4, engagement: 5, railBolt: 10 }
}
export function panelBoltLength(m: PanelMount, series: ConnectorSeries = 20): number {
  const d = panelFastenerSizes(series)
  return Math.ceil((m.mode === 'direct' ? m.boardThickness + d.washer + d.engagement
    : 4 + m.spacer + m.boardThickness + 2 * d.washer + d.nut + 2) / 5) * 5
}
/** Cut sleeve outside a directly mounted board makes a standard bolt engage the full T-nut without bottoming out. */
export function directStackExtra(m: PanelMount, series: ConnectorSeries = 20) {
  const d = panelFastenerSizes(series)
  return Math.round((panelBoltLength(m, series) - m.boardThickness - d.washer - d.engagement) * 1000) / 1000
}
export function panelMountFasteners(m: PanelMount, series: ConnectorSeries = 20): HardwareFastener[] {
  const d = panelFastenerSizes(series), direct = m.mode === 'direct'
  const extra = direct ? directStackExtra(m, series) : 0
  const washers = direct ? 1 + Math.floor((extra + 1e-6) / d.washer) : 3
  const sleeve = direct ? Math.max(0, Math.round((extra - (washers - 1) * d.washer) * 1000) / 1000) : m.spacer
  return [
    ...(!direct ? [
      { kind: 'bolt' as const, count: 1, thread: d.thread, length: d.railBolt, standard: 'DIN 912' },
      { kind: 't-nut' as const, count: 1, thread: d.thread, descriptionZh: series === 30 ? 'B 型槽 8' : 'B 型槽 6', descriptionEn: series === 30 ? 'B-type slot 8' : 'B-type slot 6' },
    ] : []),
    { kind: 'bolt', count: 1, thread: d.thread, length: panelBoltLength(m, series), standard: 'DIN 912' },
    { kind: 'washer', count: washers, thread: d.thread, standard: 'ISO 7089', descriptionZh: `厚 ${d.washer} mm`, descriptionEn: `${d.washer} mm thick` },
    ...(!direct ? [{ kind: 'nut' as const, count: 1, thread: d.thread, standard: 'DIN 934' }] : []),
    ...(sleeve > 0 ? [{ kind: 'other' as const, count: 1, length: sleeve,
      descriptionZh: `定长垫套，外径 ${d.washerRadius * 2} / 内径 ${d.clearance} mm`,
      descriptionEn: `Cut spacer, OD ${d.washerRadius * 2} / ID ${d.clearance} mm` }] : []),
  ]
}
export function panelMountFrame(c: ConnectorData) {
  const q = new THREE.Quaternion(...c.quaternion).normalize(), origin = new THREE.Vector3(...c.position)
  const normal = new THREE.Vector3(1, 0, 0).applyQuaternion(q)
  const across = new THREE.Vector3(0, 0, 1).applyQuaternion(q)
  const offset = c.panelMount?.mode === 'direct' ? 0 : (c.series ?? 20) / 2
  return { origin, normal, across, railHole: origin.clone().addScaledVector(across, -offset),
    boardHole: origin.clone().addScaledVector(across, offset) }
}
/** Board hole must pass through the face, with room for a 10 mm washer and edge margin. */
export function panelMountBoardFits(c: ConnectorData, body: OBB): boolean {
  const m = c.panelMount
  if (!m) return false
  const { normal, boardHole } = panelMountFrame(c)
  if (Math.abs(normal.dot(body.axes[2])) < .999999 || Math.abs(body.half.z * 2 - m.boardThickness) > eps) return false
  const face = boardHole.addScaledVector(normal, m.mode === 'direct' ? m.boardThickness : -m.spacer), delta = face.sub(body.center)
  return Math.abs(delta.dot(normal) - body.half.z) < eps
    && Math.abs(delta.dot(body.axes[0])) <= body.half.x - 10 + eps
    && Math.abs(delta.dot(body.axes[1])) <= body.half.y - 10 + eps
}
export function panelMountSupports(c: ConnectorData, profiles: ProfileData[], panels: PanelData[],
  trims: Map<string, ProfileTrims> = computeAllTrims(profiles)): string[] | null {
  const m = c.panelMount
  if (!validPanelMount(m) || c.type !== (m.mode === 'direct' ? 't-nut' : 'joining-plate') || ![20, 30].includes(c.series ?? 20)) return null
  const panel = panels.find((p) => p.id === m.panelId), profile = profiles.find((p) => p.id === m.profileId)
  if (!panel || !['ply', 'mdf'].includes(panel.material) || !profile || profile.spec === '3040' || seriesOf(profile.spec) !== (c.series ?? 20) || profile.miterCuts.length) return null
  const { normal, across, railHole } = panelMountFrame(c)
  if ((m.mode !== 'direct' && normal.dot(down) < .999999) || !panelMountBoardFits(c, panelOBB(panel))) return null
  const body = trimmedOBB(profile, trims.get(profile.id)!)
  const faceAxis = [0, 1].find((i) => Math.abs(normal.dot(body.axes[i])) > .999999)
  if (faceAxis === undefined || (m.mode !== 'direct' && Math.abs(body.axes[2].y) > 1e-6)) return null
  const lateral = 1 - faceAxis, delta = railHole.sub(body.center)
  if (Math.abs(across.dot(body.axes[lateral])) < .999999
    || Math.abs(delta.dot(normal) - body.half.getComponent(faceAxis)) > eps
    || Math.abs(delta.dot(body.axes[2])) > body.half.z - 10) return null
  if (!slotOffsets(body.half.getComponent(lateral) * 2, c.series ?? 20).some((s) => Math.abs(delta.dot(body.axes[lateral]) - s) < eps)) return null
  return [profile.id]
}

/** Two locations on each eligible rail; caller checks obstructions and duplicate installations. */
export function panelMountCandidates(panel: PanelData, profiles: ProfileData[],
  trims = computeAllTrims(profiles)): ConnectorData[] {
  if (panel.locked || !['ply', 'mdf'].includes(panel.material) || panel.thickness < 6 || panel.thickness > 40) return []
  const board = panelOBB(panel)
  if (Math.abs(board.axes[2].y) < .999999) return directPanelCandidates(panel, profiles, trims)
  const result: ConnectorData[] = []
  for (const profile of profiles) {
    const series = seriesOf(profile.spec)
    if (profile.spec === '3040' || ![20, 30].includes(series) || profile.miterCuts.length) continue
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
    for (const slot of slotOffsets(body.half.getComponent(lateral) * 2, series)) for (const sign of [-1, 1]) {
      const across = axis.clone().multiplyScalar(sign)
      const y = new THREE.Vector3().crossVectors(across, down)
      const quaternion = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(down, y, across)).toArray()
      for (const along of [mid - boardLength / 2, mid + boardLength / 2]) {
        const hole = body.center.clone().addScaledVector(longitudinal, along).addScaledVector(axis, slot)
        hole.y = faceY
        const candidate: ConnectorData = { id: 'panel-mount-candidate', type: 'joining-plate', series,
          position: hole.addScaledVector(across, series / 2).toArray(), quaternion,
          panelMount: { panelId: panel.id, profileId: profile.id, spacer: Math.max(0, Math.round(spacer * 1000) / 1000), boardThickness: panel.thickness } }
        if (panelMountSupports(candidate, profiles, [panel], trims)) result.push(candidate)
      }
    }
  }
  return result
}

/** Flush exterior boards are through-bolted to slots on their supporting faces. */
function directPanelCandidates(panel: PanelData, profiles: ProfileData[], trims: Map<string, ProfileTrims>) {
  const board = panelOBB(panel), result: ConnectorData[] = []
  for (const profile of profiles) {
    const series = seriesOf(profile.spec)
    if (profile.spec === '3040' || ![20, 30].includes(series) || profile.miterCuts.length) continue
    const body = trimmedOBB(profile, trims.get(profile.id)!)
    const faceAxis = [0, 1].find(i => Math.abs(body.axes[i].dot(board.axes[2])) > .999999)
    if (faceAxis === undefined) continue
    const delta = board.center.clone().sub(body.center)
    const normal = body.axes[faceAxis].clone().multiplyScalar(Math.sign(delta.dot(body.axes[faceAxis])))
    if (Math.abs(delta.dot(normal) - body.half.getComponent(faceAxis) - board.half.z) > eps) continue
    const across = body.axes[1 - faceAxis], along = body.axes[2]
    const y = new THREE.Vector3().crossVectors(across, normal)
    const quaternion = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(normal, y, across)).toArray()
    const nut = accessoryNutDimensions(series)
    const extent = Math.abs(along.dot(board.axes[0])) * board.half.x + Math.abs(along.dot(board.axes[1])) * board.half.y
    const mid = delta.dot(along)
    // Use the overlap of board and cut rail, with clearance from member ends.
    const low = Math.max(-body.half.z + nut.length + 10, mid - extent + 15)
    const high = Math.min(body.half.z - nut.length - 10, mid + extent - 15)
    if (high - low < 40) continue
    for (const slot of slotOffsets(body.half.getComponent(1 - faceAxis) * 2, series)) {
      for (const distance of [low + (high - low) / 5, high - (high - low) / 5]) {
        const candidate: ConnectorData = { id: 'panel-mount-candidate', type: 't-nut', series,
          position: body.center.clone().addScaledVector(normal, body.half.getComponent(faceAxis))
            .addScaledVector(across, slot).addScaledVector(along, distance).toArray(), quaternion,
          panelMount: { mode: 'direct', panelId: panel.id, profileId: profile.id, spacer: 0, boardThickness: panel.thickness } }
        if (panelMountSupports(candidate, profiles, [panel], trims)) result.push(candidate)
      }
    }
  }
  return result
}
