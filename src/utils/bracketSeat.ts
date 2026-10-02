import * as THREE from 'three'
import type { ConnectorData, ProfileData } from '../store/useStore'
import { getProfileDir, getProfileEndpoints, closestOnSegment, crossExtentAlong } from './geometryCore'
import { flushFace, sharedEdge } from './specCompat'
import { nearestSlot, slotOffsets } from './specUtils'
import { connectorEntry, connectorExtent, connectorScale, seriesOf, type ConnectorSeries } from './connectorCatalog'
import { fitConnector, jointPairsAt, membersAt } from './connectorFit'
import { computeAllTrims, type ProfileTrims } from './jointUtils'
import { trimmedOBB } from './analysis'
import type { OBB } from './obb'

/**
 * Connector seats aligned to the members' mounting faces and slot lines.
 * Inside angles use perpendicular faces; flat plates use a shared outside face.
 * Corner seats are checked against bolt positions and the trimmed member bodies.
 */

/** how close an end has to be to the other member's centreline to be its joint (mm) */
const JOINT_TOL = 30
/** how near a corner the pointer has to be for a bracket in hand to settle onto it (mm) */
const REACH = 70
/** the plate lies on the face, not in it: its back is at zero, so nothing to offset by */
const HALF_THICK = 0

/** First shared slot line, or null when the mounting faces have no matching slots. */
export function sharedSlotLine(
  aCentre: number, aFaceWidth: number, bCentre: number, bFaceWidth: number, tol = 1,
): number | null {
  return sharedSlotLines(aCentre, aFaceWidth, bCentre, bFaceWidth, tol)[0] ?? null
}

/** All bolt lines shared by the two mounting faces, nearest the origin first. */
export function sharedSlotLines(
  aCentre: number, aFaceWidth: number, bCentre: number, bFaceWidth: number, tol = 1,
): number[] {
  const lines: number[] = []
  for (const sa of slotOffsets(aFaceWidth)) {
    for (const sb of slotOffsets(bFaceWidth)) {
      const d = Math.abs((aCentre + sa) - (bCentre + sb))
      if (d > tol) continue
      const at = (aCentre + sa + bCentre + sb) / 2
      if (!lines.some((line) => Math.abs(line - at) < 1e-6)) lines.push(at)
    }
  }
  return lines.sort((a, b) => Math.abs(a) - Math.abs(b) || a - b)
}

export interface BracketSeat {
  position: [number, number, number]
  quaternion: [number, number, number, number]
  series: ConnectorSeries
  /** the member each leg bolts into, in the order the part's +X and +Y legs take */
  legs: [string, string]
  /** how far each bolt sits from the middle of the face it lands on (mm) */
  slotOffsets: [number, number]
}

/** The direction from `at` that has member metal in it */
function into(p: ProfileData, at: THREE.Vector3): THREE.Vector3 {
  const { start, end } = getProfileEndpoints(p)
  const dir = getProfileDir(p)
  const dStart = at.distanceTo(start)
  const dEnd = at.distanceTo(end)
  if (dStart <= JOINT_TOL) return dir.clone()            // at the start: the body is ahead
  if (dEnd <= JOINT_TOL) return dir.clone().negate()     // at the end: the body is behind
  return dEnd >= dStart ? dir.clone() : dir.clone().negate()   // mid-span: the longer way
}

/** First inside-angle seat for compatible perpendicular mounting faces. */
export function seatAngle(a: ProfileData, b: ProfileData, at: THREE.Vector3): BracketSeat | null {
  return angleSeats(a, b, at, into(a, at), into(b, at))[0] ?? null
}

function angleSeats(a: ProfileData, b: ProfileData, at: THREE.Vector3, intoA: THREE.Vector3, intoB: THREE.Vector3): BracketSeat[] {
  if (Math.abs(intoA.dot(intoB)) > 0.001) return []

  // across the joint: the one direction neither member runs along
  const n = new THREE.Vector3().crossVectors(intoA, intoB).normalize()

  // the flange on A lies on A's face looking towards B, and vice versa
  const faceA = crossExtentAlong(a, intoB)
  const faceB = crossExtentAlong(b, intoA)

  // both bolts sit at the same place across the joint, so that place has to be a slot on
  // both faces — measured from each member's own centreline
  const aAxis = closestOnSegment(at, ...(({ start, end }) => [start, end] as const)(getProfileEndpoints(a))).point
  const bAxis = closestOnSegment(at, ...(({ start, end }) => [start, end] as const)(getProfileEndpoints(b))).point
  const lines = sharedSlotLines(
    aAxis.dot(n), crossExtentAlong(a, n) * 2,
    bAxis.dot(n), crossExtentAlong(b, n) * 2,
  )
  const basis = new THREE.Matrix4().makeBasis(intoA, intoB, n)
  const quat = new THREE.Quaternion().setFromRotationMatrix(basis)
  return lines.map((line) => {
    const position = new THREE.Vector3()
      .addScaledVector(intoA, bAxis.dot(intoA) + faceB)
      .addScaledVector(intoB, aAxis.dot(intoB) + faceA)
      .addScaledVector(n, line)
    return {
      position: [round1(position.x), round1(position.y), round1(position.z)],
      quaternion: [quat.x, quat.y, quat.z, quat.w],
      series: Math.min(seriesOf(a.spec), seriesOf(b.spec)) as ConnectorSeries,
      legs: [a.id, b.id],
      slotOffsets: [line - aAxis.dot(n), line - bAxis.dot(n)],
    }
  })
}

/** Seat a flat plate across the outside face the two members share */
export function seatBracket(a: ProfileData, b: ProfileData, at: THREE.Vector3): BracketSeat | null {
  const face = flushFace(a, b, at)
  if (!face) return null

  // `flushFace` reports the shared plane as a signed distance along its normal, so the side
  // the metal is on — and therefore the way the bracket's back must face — is the sign of
  // that distance, not the normal itself. Taking the normal on trust seats every bracket on
  // a negative-side face two millimetres inside the profile, back to front.
  const n = face.normal.clone().multiplyScalar(face.offset < 0 ? -1 : 1)
  let legA = into(a, at)
  let legB = into(b, at)
  if (Math.abs(legA.dot(legB)) > 0.9) return null        // parallel: a plate's job, not a bracket's

  // The part's back is its local +Z, and the basis built from the two legs sends +Z to
  // legA × legB. If that points into the frame, the legs are the other way round.
  let flipped = false
  if (new THREE.Vector3().crossVectors(legA, legB).dot(n) < 0) {
    ;[legA, legB] = [legB, legA]
    flipped = true
  }
  const [memberX, memberY] = flipped ? [b, a] : [a, b]

  // The plane the legs lie in, and the two centrelines projected onto it
  const planePoint = at.clone().addScaledVector(n, Math.abs(face.offset))
  const onPlane = (v: THREE.Vector3) => v.clone().addScaledVector(n, planePoint.clone().sub(v).dot(n))
  const axisB = closestOnSegment(at, ...(({ start, end }) => [start, end] as const)(getProfileEndpoints(b))).point
  const Pa = onPlane(at)          // a's centreline, at the joint
  const Pb = onPlane(axisB)       // b's centreline, nearest the joint

  // Where the two projected centrelines cross: slide Pa along a until it is level with Pb
  const dirA = legA.clone()
  const dirB = legB.clone()
  const corner = Pa.clone().addScaledVector(dirA, Pb.clone().sub(Pa).dot(dirA))

  // Sliding along B moves the X-leg's bolt across X's face, and the other way round.
  const faceWidthX = crossExtentAlong(memberX, dirB) * 2
  const faceWidthY = crossExtentAlong(memberY, dirA) * 2
  const offAcrossX = nearestSlot(faceWidthX, 0)     // measured along dirB
  const offAcrossY = nearestSlot(faceWidthY, 0)     // measured along dirA

  const position = corner.clone()
    .addScaledVector(dirB, offAcrossX)
    .addScaledVector(dirA, offAcrossY)
    .addScaledVector(n, HALF_THICK * connectorScale(Math.min(seriesOf(a.spec), seriesOf(b.spec)) as ConnectorSeries))

  const basis = new THREE.Matrix4().makeBasis(dirA, dirB, new THREE.Vector3().crossVectors(dirA, dirB).normalize())
  const quat = new THREE.Quaternion().setFromRotationMatrix(basis)

  return {
    position: [round1(position.x), round1(position.y), round1(position.z)],
    quaternion: [quat.x, quat.y, quat.z, quat.w],
    series: Math.min(seriesOf(a.spec), seriesOf(b.spec)) as ConnectorSeries,
    legs: [memberX.id, memberY.id],
    slotOffsets: [offAcrossY, offAcrossX],
  }
}

/** rounded to a tenth, and never negative zero: a coordinate of −0 is noise that compares unequal to 0 */
function round1(v: number): number {
  const r = Math.round(v * 10) / 10
  return r === 0 ? 0 : r
}

/** An end cap follows its host's actual cut plane and section roll, never a neighbouring side. */
export function endCapSeat(profile: ProfileData, side: -1 | 1, trims: ProfileTrims) {
  const quaternion = new THREE.Quaternion(...profile.quaternion).normalize()
  const dir = getProfileDir(profile)
  const at = new THREE.Vector3(...profile.position).addScaledVector(dir,
    side === -1 ? trims.start.trim : profile.length - trims.end.trim)
  if (side === -1) quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI))
  return { position: at.toArray() as [number, number, number],
    quaternion: quaternion.toArray() as [number, number, number, number], series: seriesOf(profile.spec), seated: true }
}

/** Compute the connector seat shared by placement previews and committed placement. */
export function connectorSeatAt(
  type: string, point: THREE.Vector3, profiles: ProfileData[], surfaceNormal?: THREE.Vector3 | null,
): { position: [number, number, number]; quaternion: [number, number, number, number]; series: ConnectorSeries; seated: boolean } {
  const entry = connectorEntry(type)
  if (type === 'end-cap') {
    const trims = computeAllTrims(profiles)
    const ends = profiles.flatMap((profile) => {
      const design = getProfileEndpoints(profile)
      return ([-1, 1] as const).map((side) => {
        const seat = endCapSeat(profile, side, trims.get(profile.id)!)
        const normal = getProfileDir(profile).multiplyScalar(side)
        const actualDistance = point.distanceTo(new THREE.Vector3(...seat.position))
        // The picker can still return a design endpoint for a cut/extended cap hit.
        const distance = Math.min(actualDistance, point.distanceTo(side === -1 ? design.start : design.end))
        return { seat, distance, actualDistance, matchesNormal: !!surfaceNormal && normal.dot(surfaceNormal) > 0.9 }
      })
    }).filter((end) => end.distance <= REACH)
      .sort((a, b) => Number(b.matchesNormal) - Number(a.matchesNormal) || a.distance - b.distance || a.actualDistance - b.actualDistance)
    if (ends[0]) return ends[0].seat
  }
  // Infer seats for corner-mounted types; preserve the drop position for other types.
  if (entry?.seat === 'angle' || entry?.seat === 'plate') {
    const seat = connectorSeatsAt(type, point, profiles, surfaceNormal)[0]
    if (seat) return { ...seat, seated: true }
  }
  // Seat inward-facing inline parts beyond the selected member end.
  if (entry?.fit === 'inline' && entry.axes.towards === 'in') {
    // Prefer a downward-facing member end for a foot; fall back to the nearest end.
    const ends = membersAt(point, profiles, REACH)
      .map((c) => {
        const { start, end } = getProfileEndpoints(c.profile)
        const atStart = point.distanceTo(start) <= point.distanceTo(end)
        const at = atStart ? start : end
        const outward = getProfileDir(c.profile)
        if (atStart) outward.negate()
        return { c, at, atStart, outward, d: point.distanceTo(at) }
      })
      .sort((x, y) => x.d - y.d)
    const near = ends.find((e) => e.outward.y < -0.9) ?? ends[0]
    if (near) {
      const fit = fitConnector(type, near.at, profiles, surfaceNormal)
      const reach = connectorExtent(type).half[AXIS_INDEX[entry.axes.primary]] * connectorScale(fit.series)
      const at = near.at.clone().addScaledVector(near.outward, reach)
      return {
        position: [round1(at.x), round1(at.y), round1(at.z)],
        quaternion: fit.quaternion,
        series: fit.series,
        seated: true,
      }
    }
  }

  const fit = fitConnector(type, point, profiles, surfaceNormal)
  return {
    position: [round1(point.x), round1(point.y), round1(point.z)],
    quaternion: fit.quaternion,
    series: fit.series,
    seated: false,
  }
}

/** which component of a part's own half-extent runs along its primary axis */
const AXIS_INDEX: Record<string, 0 | 1 | 2> = { x: 0, y: 1, z: 2 }

/** Dispatch seating by connector type: cast brackets use inner perpendicular faces; plates use an outer face. */
export function seatFor(type: string, a: ProfileData, b: ProfileData, at: THREE.Vector3): BracketSeat | null {
  // Reject end-to-face pairs whose section dimensions share no edge.
  if (!sharedEdge(a.spec, b.spec)) return null
  const kind = connectorEntry(type)?.seat
  if (kind === 'angle') return seatAngle(a, b, at)
  if (kind === 'plate') return seatBracket(a, b, at)
  return null
}

/** Try either side of each member; bolt auditing decides which have actual metal beneath. */
export function seatsFor(type: string, a: ProfileData, b: ProfileData, at: THREE.Vector3): BracketSeat[] {
  if (!sharedEdge(a.spec, b.spec)) return []
  if (connectorEntry(type)?.seat !== 'angle') {
    const seat = seatFor(type, a, b, at)
    return seat ? [seat] : []
  }
  const aDir = into(a, at), bDir = into(b, at)
  const out: BracketSeat[] = []
  for (const sa of [1, -1]) for (const sb of [1, -1]) {
    out.push(...angleSeats(a, b, at, aDir.clone().multiplyScalar(sa), bDir.clone().multiplyScalar(sb)))
  }
  return out
}

/** Discover joints around the model point; rank their seats by the picked face and surface point. */
export function connectorSeatsAt(
  type: string, point: THREE.Vector3, profiles: ProfileData[], surfaceNormal?: THREE.Vector3 | null,
  searchPoint = point,
): BracketSeat[] {
  const kind = connectorEntry(type)?.seat
  if (kind !== 'angle' && kind !== 'plate') return []
  const trims = computeAllTrims(profiles)
  const candidates = jointPairsAt(searchPoint, profiles, REACH).flatMap(({ a, b, at }) => seatsFor(type, a, b, at))
    .filter((seat) => auditBrackets(profiles, [{ id: 'candidate', type, ...seat }], trims).length === 0)
  const normal = surfaceNormal?.clone().normalize()
  const alignment = (seat: BracketSeat) => {
    if (!normal) return 0
    const q = new THREE.Quaternion(...seat.quaternion)
    return kind === 'plate' ? new THREE.Vector3(0, 0, 1).applyQuaternion(q).dot(normal)
      : Math.max(new THREE.Vector3(1, 0, 0).applyQuaternion(q).dot(normal),
        new THREE.Vector3(0, 1, 0).applyQuaternion(q).dot(normal))
  }
  return candidates.sort((a, b) => alignment(b) - alignment(a)
    || new THREE.Vector3(...a.position).distanceToSquared(point) - new THREE.Vector3(...b.position).distanceToSquared(point)
    || a.position[0] - b.position[0] || a.position[1] - b.position[1] || a.position[2] - b.position[2]
    || a.legs.join('\0').localeCompare(b.legs.join('\0')))
}

export interface BracketFault {
  id: string
  /** how far it is from where it should be (mm) */
  off: number
  reason: 'off-seat' | 'no-joint' | 'wrong-series'
  at: THREE.Vector3
}

/** A bolt has to meet the face and its slot, not just lie near the joint. */
const FACE_TOL = 0.5

function boltOnFace(point: THREE.Vector3, normal: THREE.Vector3, body: OBB): boolean {
  const dx = point.x - body.center.x, dy = point.y - body.center.y, dz = point.z - body.center.z
  for (const i of [0, 1] as const) {
    const face = body.axes[i], length = body.axes[2]
    const facing = face.dot(normal)
    if (Math.abs(facing) < 0.999) continue
    if (Math.abs(dx * face.x + dy * face.y + dz * face.z - Math.sign(facing) * body.half.getComponent(i)) > FACE_TOL) continue
    if (Math.abs(dx * length.x + dy * length.y + dz * length.z) > body.half.z + FACE_TOL) continue
    const across = i === 0 ? 1 : 0
    const side = body.axes[across]
    const offset = dx * side.x + dy * side.y + dz * side.z
    if (slotOffsets(body.half.getComponent(across) * 2).some((slot) => Math.abs(offset - slot) <= 1)) return true
  }
  return false
}

/**
 * Brackets that are not where they could be bolted.
 *
 * Worth checking because nothing else will: a bracket floating beside a joint renders
 * exactly like one bolted to it, and the cut list counts it either way. Check its actual
 * bolt contact points independently of the seating calculation: both must lie on a slot
 * of their own member, on the correct face and within that member's cut length.
 */
export function auditBrackets(profiles: ProfileData[], connectors: ConnectorData[], trims = computeAllTrims(profiles)): BracketFault[] {
  const faults: BracketFault[] = []
  const members = profiles.map((p) => ({ p, body: trimmedOBB(p, trims.get(p.id)!) }))
  for (const c of connectors) {
    const kind = connectorEntry(c.type)?.seat
    if (kind !== 'angle' && kind !== 'plate') continue
    const here = new THREE.Vector3(...c.position)
    const quat = new THREE.Quaternion(...c.quaternion).normalize()
    const x = new THREE.Vector3(1, 0, 0).applyQuaternion(quat)
    const y = new THREE.Vector3(0, 1, 0).applyQuaternion(quat)
    const z = new THREE.Vector3(0, 0, 1).applyQuaternion(quat)
    const k = connectorScale(c.series ?? 20)
    const alongX = c.type === 't-bracket' ? [-22, 22] : [kind === 'angle' ? 16 : 18]
    const alongY = c.type === 't-bracket' ? [28] : [kind === 'angle' ? 16 : 18]
    const supports = (dir: THREE.Vector3, normal: THREE.Vector3, offsets: number[]) => {
      const bolts = offsets.map((offset) => here.clone().addScaledVector(dir, offset * k))
      return members.filter(({ body }) => Math.abs(body.axes[2].dot(dir)) > 0.999
        && bolts.every((bolt) => boltOnFace(bolt, normal, body)))
    }
    const a = supports(x, kind === 'angle' ? y : z, alongX)
    const b = supports(y, kind === 'angle' ? x : z, alongY)
    let pairs = a.flatMap((u) => b.filter((v) => v.p.id !== u.p.id && sharedEdge(u.p.spec, v.p.spec)).map((v) => [u.p, v.p]))
    if (c.type === 'corner-3way') {
      // The third arm follows local +Z. Its bolt may enter either adjacent slot face,
      // but it must land on a third actual member, with the arm's own direction and pitch.
      const third = [...supports(z, x, [16]), ...supports(z, y, [16])]
      pairs = pairs.flatMap(([u, v]) => third.filter(({ p }) => p.id !== u.id && p.id !== v.id
        && sharedEdge(u.spec, p.spec) && sharedEdge(v.spec, p.spec)).map(({ p }) => [u, v, p]))
    }
    if (!pairs.length) faults.push({ id: c.id, off: Infinity, reason: 'no-joint', at: here })
    else if (!pairs.some((parts) => Math.min(...parts.map((p) => seriesOf(p.spec))) === (c.series ?? 20))) {
      faults.push({ id: c.id, off: 0, reason: 'wrong-series', at: here })
    }
  }
  return faults
}
