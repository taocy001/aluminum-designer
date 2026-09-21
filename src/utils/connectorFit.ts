import * as THREE from 'three'
import type { ProfileData } from '../store/useStore'
import { getProfileEndpoints, getProfileDir, closestOnSegment } from './geometryCore'
import { connectorEntry, seriesOf, type ConnectorSeries } from './connectorCatalog'

/** How close a placement point has to be to a member to count as "on" it (mm) */
const ON_MEMBER_MM = 12

export interface MemberContact {
  profile: ProfileData
  /** unit direction pointing away from the contact point, along the member */
  away: THREE.Vector3
  /** true when the contact sits at one of the member's ends */
  atEnd: boolean
}

/** Members whose body or endpoints touch `point` */
export function membersAt(point: THREE.Vector3, profiles: ProfileData[], tol = ON_MEMBER_MM): MemberContact[] {
  const out: MemberContact[] = []
  for (const p of profiles) {
    const { start, end } = getProfileEndpoints(p)
    const { point: closest } = closestOnSegment(point, start, end)
    if (closest.distanceTo(point) > tol) continue
    const dir = getProfileDir(p)
    const atStart = point.distanceTo(start) <= tol
    const atEnd = point.distanceTo(end) <= tol
    // at an end the part faces back along the member; mid-span either way works
    const away = atStart ? dir.clone() : atEnd ? dir.clone().negate() : dir.clone()
    out.push({ profile: p, away, atEnd: atStart || atEnd })
  }
  return out
}

const LOCAL: Record<string, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0), '-x': new THREE.Vector3(-1, 0, 0),
  y: new THREE.Vector3(0, 1, 0), '-y': new THREE.Vector3(0, -1, 0),
  z: new THREE.Vector3(0, 0, 1), '-z': new THREE.Vector3(0, 0, -1),
}

/** A perpendicular to `v`, chosen so it is never degenerate */
function anyPerpendicular(v: THREE.Vector3): THREE.Vector3 {
  const helper = Math.abs(v.y) > 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0)
  return helper.clone().addScaledVector(v, -helper.dot(v)).normalize()
}

/**
 * Rotation that sends the part's own axes onto the world directions they should follow.
 * `localA → worldA` exactly; `localB → worldB` as closely as the first constraint allows.
 */
function alignAxes(
  localA: THREE.Vector3, worldA: THREE.Vector3,
  localB: THREE.Vector3, worldB: THREE.Vector3,
): THREE.Quaternion {
  const a = worldA.clone().normalize()
  let b = worldB.clone().addScaledVector(a, -worldB.dot(a))
  if (b.lengthSq() < 1e-6) b = anyPerpendicular(a)
  b.normalize()
  const worldBasis = new THREE.Matrix4().makeBasis(a, b, new THREE.Vector3().crossVectors(a, b).normalize())

  const la = localA.clone().normalize()
  let lb = localB.clone().addScaledVector(la, -localB.dot(la))
  if (lb.lengthSq() < 1e-6) lb = anyPerpendicular(la)
  lb.normalize()
  const localBasis = new THREE.Matrix4().makeBasis(la, lb, new THREE.Vector3().crossVectors(la, lb).normalize())

  return new THREE.Quaternion().setFromRotationMatrix(worldBasis.multiply(localBasis.invert()))
}

export interface ConnectorPlacement {
  quaternion: [number, number, number, number]
  series: ConnectorSeries
  /** members the part was aligned to */
  refIds: string[]
}

/**
 * Work out how a connector should sit where the user dropped it.
 *
 * The parts are modelled for the 20 series with their arms along +X and +Y, and inline
 * parts (end caps, feet, joining plates) along +Z. Given the members meeting at the drop
 * point, those canonical axes are mapped onto the real directions, so an L-bracket lands
 * in the corner instead of pointing at nothing.
 */
export function fitConnector(
  type: string, point: THREE.Vector3, profiles: ProfileData[], surfaceNormal?: THREE.Vector3 | null,
): ConnectorPlacement {
  const entry = connectorEntry(type)
  const contacts = membersAt(point, profiles)
  // which way the part faces: the surface the pointer was actually over, when we know it
  const faceNormal = surfaceNormal && surfaceNormal.lengthSq() > 1e-6
    ? surfaceNormal.clone().normalize()
    : new THREE.Vector3(0, 1, 0)
  const series: ConnectorSeries = contacts.length > 0 ? seriesOf(contacts[0].profile.spec) : 20
  const identity: [number, number, number, number] = [0, 0, 0, 1]
  if (!entry || entry.fit === 'free' || contacts.length === 0) {
    return { quaternion: identity, series, refIds: contacts.map((c) => c.profile.id) }
  }

  const q = (quat: THREE.Quaternion): ConnectorPlacement => ({
    quaternion: [quat.x, quat.y, quat.z, quat.w],
    series,
    refIds: contacts.map((c) => c.profile.id),
  })

  const primary = LOCAL[entry.axes.primary]
  const secondary = entry.axes.secondary ? LOCAL[entry.axes.secondary] : anyPerpendicular(primary)

  if (entry.fit === 'corner') {
    const [a, b] = contacts
    if (b && Math.abs(a.away.dot(b.away)) < 0.9) {
      // the arm the part calls `primary` goes on the first member it touches, unless the part
      // is a T: then the stem belongs on the branch and the crossbar on the through member
      const throughFirst = entry.type === 't-bracket' && b.atEnd && !a.atEnd
      const [armA, armB] = throughFirst ? [b, a] : [a, b]
      return q(alignAxes(primary, armA.away, secondary, armB.away))
    }
    // only one member: the first arm runs along it and the second points up, or across
    const up = Math.abs(a.away.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)
    return q(alignAxes(primary, a.away, secondary, up))
  }

  if (entry.fit === 'inline') {
    // the part's own axis runs along the member: out of the end for a cap, back into it for
    // the parts that stand under a post
    const a = contacts[0]
    const outward = a.away.clone().negate()
    const target = entry.axes.towards === 'in' ? outward.clone().negate() : outward
    return q(alignAxes(primary, target, secondary, anyPerpendicular(target)))
  }

  // 'face': the plate lies against the member, `primary` being its plate normal
  const a = contacts[0]
  const along = getProfileDir(a.profile)
  const normal = faceNormal.clone()
  normal.addScaledVector(along, -normal.dot(along))
  if (normal.lengthSq() < 1e-6) normal.copy(anyPerpendicular(along))
  normal.normalize()
  return q(alignAxes(primary, normal, secondary, along))

}
