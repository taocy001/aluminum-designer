import * as THREE from 'three'
import { useStore, type ConnectorData, type FittingData, type ProfileData, type ProfileSpec } from '../store/useStore'
import { drawerLayout } from './drawerLayout'
import { validFitting } from './fittingValidation'
import { runnerFaults } from './runnerMount'
import { computeAllTrims, withFixedProfileCuts } from './jointUtils'
import { connectorOBB, panelOBB, trimmedOBB } from './analysis'
import { fittingSolids } from './fittingGeometry'
import { obbCorners, obbPenetration, type OBB } from './obb'
import { getProfileDir } from './geometryCore'
import { auditBrackets, seatsFor } from './bracketSeat'
import { nextId } from './profileFactory'
import { ALL_SPECS, specDims } from './specUtils'
import { noteNext } from './opLog'
import { reportEditResult } from './editFeedback'
import { profileBodyEndpoints } from './profileFaces'

export type DrawerSide = 'left' | 'right'
export type DrawerSupportFailure = 'locked' | 'invalid-drawer' | 'no-mount' | 'collision' | 'no-connection' | 'edit-rejected'
export interface DrawerSupportsResult {
  generated: Array<{ fittingId: string; side: DrawerSide; profileId: string; connectorIds: string[] }>
  failed: Array<{ fittingId: string; side: DrawerSide; reason: DrawerSupportFailure }>
}

/** Build a depth rail between physical end faces; the caller supplies the mounting span. */
export function buildDrawerSupport(f: FittingData, side: DrawerSide, spec: ProfileSpec,
  span: { back: number; front: number }, id: string): ProfileData | null {
  const length = span.front - span.back
  if (!validFitting(f) || f.kind !== 'drawer' || !ALL_SPECS.includes(spec)
    || !Number.isFinite(span.back) || !Number.isFinite(span.front) || !Number.isFinite(length) || length < 10) return null
  const { hw, hh } = specDims(spec)
  const layout = drawerLayout(f)
  if (hh * 2 > layout.boxHeight) return null
  const q = new THREE.Quaternion(...f.quaternion).normalize()
  const position = new THREE.Vector3((side === 'left' ? -1 : 1) * (f.width / 2 + hw), layout.boxY, span.back)
    .applyQuaternion(q).add(new THREE.Vector3(...f.position))
  if (!position.toArray().every(Number.isFinite)) return null
  return { id, spec, length, position: position.toArray() as ProfileData['position'],
    quaternion: q.toArray() as ProfileData['quaternion'], miterCuts: [], holes: [], fixedTrims: { start: 0, end: 0 } }
}

function localBounds(body: OBB, f: FittingData): THREE.Box3 {
  const inv = new THREE.Quaternion(...f.quaternion).normalize().invert()
  const origin = new THREE.Vector3(...f.position)
  return new THREE.Box3().setFromPoints(obbCorners(body).map((p) => p.sub(origin).applyQuaternion(inv)))
}

/** Fill continuous mounting faces for selected drawers, with connected rails and one history entry. */
export function addDrawerSupports(ids: string[], spec?: ProfileSpec, options?: { linked?: boolean }): DrawerSupportsResult {
  const state = useStore.getState()
  const result: DrawerSupportsResult = { generated: [], failed: [] }
  let profiles = withFixedProfileCuts(state.profiles)
  let connectors = state.connectors
  for (const f of state.fittings.filter((v) => ids.includes(v.id) && v.kind === 'drawer')) {
    const initialTrims = computeAllTrims(profiles)
    const missing = runnerFaults(profiles, initialTrims, [f], state.panels, false)
    if (!missing.length) continue
    if (f.locked || !validFitting(f) || (spec !== undefined && !ALL_SPECS.includes(spec))) {
      result.failed.push(...missing.map(({ side }) => ({ fittingId: f.id, side, reason: f.locked ? 'locked' as const : 'invalid-drawer' as const })))
      continue
    }
    const stagedProfiles: ProfileData[] = [], stagedConnectors: ConnectorData[] = []
    const stagedResults: DrawerSupportsResult['generated'] = []
    const layout = drawerLayout(f)
    const inv = new THREE.Quaternion(...f.quaternion).normalize().invert()
    const hosts = profiles.flatMap((p) => {
      if (Math.abs(getProfileDir(p).applyQuaternion(inv).y) < 1 - 1e-6) return []
      return [{ p, box: localBounds(trimmedOBB(p, initialTrims.get(p.id)!), f) }]
    })
    let failed = false
    for (const { side } of missing) {
      let reason: DrawerSupportFailure = 'no-mount'
      let made: { rail: ProfileData; brackets: ConnectorData[] } | null = null
      for (const candidateSpec of spec ? [spec] : ['2020', '3030', '4040'] as const) {
        if (made) break
        const { hw, hh } = specDims(candidateSpec)
        const x = (side === 'left' ? -1 : 1) * (f.width / 2 + hw)
        const aligned = hosts.filter(({ box }) => box.min.x <= x - hw + 1 && box.max.x >= x + hw - 1
          && box.min.y <= layout.boxY - hh && box.max.y >= layout.boxY + hh)
        const backs = aligned.filter(({ box }) => box.max.z <= layout.runnerBack + 25 && box.max.z >= -f.depth / 2 - 120)
          .sort((a, b) => b.box.max.z - a.box.max.z)
        const fronts = aligned.filter(({ box }) => box.min.z >= layout.runnerFront - 25 && box.min.z <= f.depth / 2 + 120)
          .sort((a, b) => a.box.min.z - b.box.min.z)
        for (const back of backs) for (const front of fronts) {
          if (made || back.p.id === front.p.id) continue
          const rail = buildDrawerSupport(f, side, candidateSpec, { back: back.box.max.z, front: front.box.min.z }, nextId('p'))
          if (!rail) continue
          const all = [...profiles, ...stagedProfiles, rail], trims = computeAllTrims(all)
          const body = trimmedOBB(rail, trims.get(rail.id)!)
          const otherBodies = [...profiles, ...stagedProfiles].map((p) => trimmedOBB(p, trims.get(p.id)!))
          const boards = [...state.panels.map(panelOBB), ...state.fittings.flatMap((v) => fittingSolids(v, 0))]
          if ([...otherBodies, ...boards, ...connectors.map(connectorOBB), ...stagedConnectors.map(connectorOBB)]
            .some((b) => obbPenetration(body, b, 1) > 1)) { reason = 'collision'; continue }
          const brackets: ConnectorData[] = []
          for (const [host, end] of [[back.p, 0], [front.p, rail.length]] as const) {
            const at = new THREE.Vector3(...rail.position).addScaledVector(getProfileDir(rail), end)
            const candidates = seatsFor('bracket', rail, host, at)
            const bracket = candidates.map((seat) => ({ id: nextId('c'), type: 'bracket', series: seat.series,
              position: seat.position, quaternion: seat.quaternion })).find((c) => {
              if (auditBrackets(all, [c], trims).length) return false
              const b = connectorOBB(c)
              return ![...connectors, ...stagedConnectors, ...brackets].some((v) => obbPenetration(b, connectorOBB(v), 1) > 1)
                && ![...otherBodies, body].some((v) => obbPenetration(b, v, 3) > 3)
                && !boards.some((v) => obbPenetration(b, v, 1) > 1)
            })
            if (bracket) brackets.push(bracket)
          }
          if (brackets.length !== 2) { reason = 'no-connection'; continue }
          if (runnerFaults(all, trims, [f], state.panels, false).some((v) => v.side === side)) continue
          made = { rail, brackets }
        }
      }
      if (!made) {
        result.failed.push({ fittingId: f.id, side, reason })
        failed = true
        break
      }
      if (options?.linked) {
        const inverse = new THREE.Quaternion(...f.quaternion).normalize().invert()
        const span = profileBodyEndpoints(made.rail)
        const origin = new THREE.Vector3(...f.position)
        made.rail.runnerBinding = { fittingId: f.id, side,
          backOffset: span.start.clone().sub(origin).applyQuaternion(inverse).z + f.depth / 2,
          frontOffset: span.end.clone().sub(origin).applyQuaternion(inverse).z - f.depth / 2 }
        const local = new THREE.Quaternion(...made.rail.quaternion).normalize().invert()
        made.brackets = made.brackets.map((c, index) => {
          const end = index === 0 ? 'start' : 'end'
          return { ...c, supportBinding: { profileId: made!.rail.id, end,
            localPosition: new THREE.Vector3(...c.position).sub(span[end]).applyQuaternion(local).toArray() as [number, number, number],
            localQuaternion: local.clone().multiply(new THREE.Quaternion(...c.quaternion).normalize()).normalize().toArray() as [number, number, number, number] } }
        })
      }
      stagedProfiles.push(made.rail)
      stagedConnectors.push(...made.brackets)
      stagedResults.push({ fittingId: f.id, side, profileId: made.rail.id, connectorIds: made.brackets.map((c) => c.id) })
    }
    if (!failed) {
      profiles = [...profiles, ...stagedProfiles]
      connectors = [...connectors, ...stagedConnectors]
      result.generated.push(...stagedResults)
    }
  }
  if (result.generated.length) {
    noteNext('add drawer supports')
    if (!reportEditResult(state.commitDocument({ profiles, connectors }))) {
      result.failed.push(...result.generated.map(({ fittingId, side }) => ({ fittingId, side, reason: 'edit-rejected' as const })))
      result.generated = []
    }
  }
  return result
}
