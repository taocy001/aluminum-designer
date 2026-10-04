import * as THREE from 'three'
import type { ConnectorData, ProfileData } from '../store/useStore'
import { connectorEntry, connectorMounts, connectorScale, seriesOf } from './connectorCatalog'
import { hardwareReference } from './connectorHardware'
import { alignAxes } from './connectorFit'
import { computeAllTrims } from './jointUtils'
import { trimmedOBB } from './analysis'
import { slotOffsets } from './specUtils'

const V = (axis: string) => new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0)
const near = (a: THREE.Vector3, b: THREE.Vector3) => a.distanceTo(b) < 0.6
export type HardwareSeat = Pick<ConnectorData, 'position' | 'quaternion' | 'profileSpec'> & {
  series: 20 | 30 | 40; seated: true; legs: [string, string]; slotOffsets: [number, number]
}

export function mountingEnds(profiles: ProfileData[], trims = computeAllTrims(profiles)) {
  return profiles.flatMap((p) => {
    const body = trimmedOBB(p, trims.get(p.id)!)
    return ([-1, 1] as const).map((side) => ({ p, body, side,
      at: body.center.clone().addScaledVector(body.axes[2], side * body.half.z),
      outward: body.axes[2].clone().multiplyScalar(side),
      square: !p.miterCuts.some((cut) => cut.side === (side < 0 ? 'start' : 'end') && Math.abs(cut.angle) > 1e-6),
    }))
  })
}

/** Every mounting hole has to land on a real slot on its assigned member. */
export function surfaceMountSupports(part: ConnectorData, profiles: ProfileData[], trims = computeAllTrims(profiles)): string[][] {
  const q = new THREE.Quaternion(...part.quaternion).normalize(), origin = new THREE.Vector3(...part.position)
  const k = connectorScale(part.series ?? 20)
  return connectorMounts(part.type, part.series ?? 20).map((mount) => {
    const axis = V(mount.axis).applyQuaternion(q), normal = V(mount.normal).applyQuaternion(q)
    const points = mount.bolts.map((p) => new THREE.Vector3(...p).multiplyScalar(k).applyQuaternion(q).add(origin))
    return profiles.filter((p) => {
      if (p.spec === '3040' || seriesOf(p.spec) !== (part.series ?? 20)) return false
      const body = trimmedOBB(p, trims.get(p.id)!)
      if (Math.abs(body.axes[2].dot(axis)) < 0.999) return false
      return ([0, 1] as const).some((face) => {
        const facing = normal.dot(body.axes[face])
        if (Math.abs(facing) < 0.999) return false
        const across = 1 - face
        const slots = slotOffsets(body.half.getComponent(across) * 2, seriesOf(p.spec))
        return points.every((point) => {
          const delta = point.clone().sub(body.center)
          return Math.abs(delta.dot(body.axes[face]) - Math.sign(facing) * body.half.getComponent(face)) < 0.6
            && Math.abs(delta.dot(body.axes[2])) <= body.half.z + 0.5
            && slots.some((s) => Math.abs(s - delta.dot(body.axes[across])) < 0.6)
        })
      })
    }).map((p) => p.id)
  })
}

function distinctSupports(groups: string[][]): string[] | null {
  if (!groups.length) return null
  const visit = (i: number, ids: string[]): string[] | null => {
    if (i === groups.length) return ids
    for (const id of groups[i]) {
      if (ids.includes(id)) continue
      const result = visit(i + 1, [...ids, id])
      if (result) return result
    }
    return null
  }
  return visit(0, [])
}

export function nonCornerSupports(part: ConnectorData, profiles: ProfileData[], trims = computeAllTrims(profiles)): string[] | null {
  const ref = hardwareReference(part.type, part.series ?? 20)
  if (!ref?.verified || !ref.supportedSeries.includes(part.series ?? 20)) return null
  const origin = new THREE.Vector3(...part.position), q = new THREE.Quaternion(...part.quaternion).normalize()
  if (part.type === 'end-cap') {
    const end = mountingEnds(profiles, trims).find((end) => end.p.spec !== '3040' && end.square && near(end.at, origin)
      && seriesOf(end.p.spec) === (part.series ?? 20)
      && (part.profileSpec ?? `${part.series ?? 20}${part.series ?? 20}`) === end.p.spec
      && V('z').applyQuaternion(q).dot(end.outward) > 0.999
      && (Math.abs(V('x').applyQuaternion(q).dot(end.body.axes[0])) > 0.999
        || (end.body.half.x === end.body.half.y && Math.abs(V('x').applyQuaternion(q).dot(end.body.axes[1])) > 0.999)))
    return end ? [end.p.id] : null
  }
  if (part.type === 'corner-3way') {
    const ends = mountingEnds(profiles, trims)
    const selected = ['x', 'y', 'z'].map((a) => {
      const axis = V(a).applyQuaternion(q), contact = origin.clone().addScaledVector(axis, -20)
      return ends.find((e) => e.square && e.p.spec === '4040' && near(e.at, contact) && e.outward.dot(axis) > 0.999)?.p.id
    })
    return selected.every((id) => id !== undefined) && new Set(selected).size === 3 ? selected as string[] : null
  }
  if (part.type === 'foot' || part.type === 'caster-mount') {
    if (part.type === 'caster-mount') return null
    const spec = part.series === 30 ? '3030' : '4040'
    if (part.series !== 30 && part.series !== 40) return null
    const into = V('y').applyQuaternion(q)
    const end = mountingEnds(profiles, trims).find((end) => end.square && end.outward.y < -0.999
      && end.outward.dot(into) < -0.999 && near(origin, end.at) && end.p.spec === spec)
    return end ? [end.p.id] : null
  }
  return distinctSupports(surfaceMountSupports(part, profiles, trims))
}

export function nonCornerMounted(part: ConnectorData, profiles: ProfileData[], trims = computeAllTrims(profiles)): boolean {
  return nonCornerSupports(part, profiles, trims) !== null
}

/** End connectors occupy the space between three perpendicular, square-cut ends. */
export function endCornerSeats(point: THREE.Vector3, profiles: ProfileData[]): HardwareSeat[] {
  const ends = mountingEnds(profiles).filter((e) => e.square && e.p.spec === '4040' && e.at.distanceTo(point) < 100)
  const seats: HardwareSeat[] = []
  for (const a of ends) for (const b of ends) {
    if (a.p.id === b.p.id || Math.abs(a.outward.dot(b.outward)) > 0.001) continue
    const centre = a.at.clone().addScaledVector(a.outward, 20)
    if (!near(centre, b.at.clone().addScaledVector(b.outward, 20))) continue
    const z = new THREE.Vector3().crossVectors(a.outward, b.outward)
    const c = ends.find((e) => e.p.id !== a.p.id && e.p.id !== b.p.id && e.outward.dot(z) > 0.999
      && near(centre, e.at.clone().addScaledVector(z, 20)))
    if (!c) continue
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(a.outward, b.outward, z))
    seats.push({ position: centre.toArray(), quaternion: q.toArray(), series: 40, seated: true,
      legs: [a.p.id, b.p.id], slotOffsets: [0, 0] })
  }
  return seats
}

/** Snap a face connector's mounting holes to slot lines; splice plates centre on actual butt ends. */
export function surfaceSeats(type: string, point: THREE.Vector3, profiles: ProfileData[], normal?: THREE.Vector3 | null): HardwareSeat[] {
  const entry = connectorEntry(type)
  if (entry?.fit !== 'face') return []
  const trims = computeAllTrims(profiles), seats: HardwareSeat[] = []
  for (const p of profiles) {
    if (p.spec === '3040') continue
    const series = seriesOf(p.spec), ref = hardwareReference(type, series)
    if (!ref?.verified) continue
    const body = trimmedOBB(p, trims.get(p.id)!)
    const mounts = connectorMounts(type, series), k = connectorScale(series)
    if (!mounts.length) continue
    for (const face of [0, 1] as const) for (const sign of [-1, 1]) {
      const n = body.axes[face].clone().multiplyScalar(sign), across = 1 - face
      if (normal && n.dot(normal) < 0.9) continue
      for (const roll of [-1, 1]) {
        const q = alignAxes(V(entry.axes.primary), n, V(entry.axes.secondary ?? 'x'), body.axes[2].clone().multiplyScalar(roll))
        const acrossAxis = body.axes[across]
        const longitudinal = THREE.MathUtils.clamp(point.clone().sub(body.center).dot(body.axes[2]), -body.half.z, body.half.z)
        const lengths = [longitudinal]
        if (type === 'flat-plate' || type === 'joining-plate') lengths.push(-body.half.z, body.half.z)
        for (const slot of slotOffsets(body.half.getComponent(across) * 2, series)) for (const along of lengths) {
          const onFace = body.center.clone().addScaledVector(n, body.half.getComponent(face))
            .addScaledVector(acrossAxis, slot).addScaledVector(body.axes[2], along)
          for (const mount of mounts) {
            const offset = new THREE.Vector3(...mount.bolts[0]).multiplyScalar(k).applyQuaternion(q)
            // The pointer chooses position along the slot, not an individual bolt's longitudinal offset.
            offset.addScaledVector(body.axes[2], -offset.dot(body.axes[2]))
            const position = onFace.clone().sub(offset)
            if (position.distanceTo(point) > 45) continue
            const seat: HardwareSeat = { position: position.toArray(), quaternion: q.toArray(), series,
              seated: true, legs: [p.id, p.id], slotOffsets: [slot, slot] }
            const part = { id: 'candidate', type, ...seat }
            const supported = nonCornerSupports(part, profiles, trims)
            if (!supported) continue
            seat.legs = [supported[0], supported.find((id) => id !== supported[0]) ?? supported[0]]
            seats.push(seat)
          }
        }
      }
    }
  }
  return seats.sort((a, b) => new THREE.Vector3(...a.position).distanceToSquared(point) - new THREE.Vector3(...b.position).distanceToSquared(point))
}
