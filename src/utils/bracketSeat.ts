import * as THREE from 'three'
import type { ConnectorData, ProfileData } from '../store/useStore'
import { getProfileDir, getProfileEndpoints, closestOnSegment, crossExtentAlong } from './geometryCore'
import { flushFace, sharedEdge } from './specCompat'
import { nearestSlot, slotOffsets } from './specUtils'
import { connectorEntry, connectorExtent, connectorScale, seriesOf, type ConnectorSeries } from './connectorCatalog'
import { fitConnector, membersAt } from './connectorFit'

/**
 * Where a corner bracket actually goes.
 *
 * A bracket is not decoration on a joint, it is two bolts. Each bolt drops a T-nut into a
 * slot, so the hole has to land on a slot line or the bolt lands on solid metal and the part
 * cannot be fitted at all. That is the whole of this file.
 *
 * Three things decide the seat:
 *
 *  1. **The plane.** Both legs lie in one plane, so that plane is perpendicular to both
 *     member axes — the cross product, and nothing else. It has to be a face the two members
 *     share, which is what `flushFace` finds.
 *  2. **The two lateral offsets.** In that plane the bracket has two degrees of freedom: how
 *     far it sits along A, and how far along B. Sliding along B moves the A-leg's bolt across
 *     A's face; sliding along A moves the B-leg's bolt across B's face. So each offset is set
 *     by the *other* member's slot lines. On a 20 face that is the middle; on a 40 face it is
 *     ten to one side, because the middle of a 40 face is metal.
 *  3. **Which leg is which.** The part is modelled with its legs along +X and +Y and its back
 *     on +Z, so the legs have to be handed to the two members in the order that puts +Z on the
 *     outside. Getting this backwards buries the bracket inside the frame.
 *
 * The size follows the smaller of the two members. A 20-series bracket bolts to a 40-series
 * profile through an M5 nut made for the 8 mm slot; a 40-series bracket on a 20 profile hangs
 * off both sides of it.
 */

/** how close an end has to be to the other member's centreline to be its joint (mm) */
const JOINT_TOL = 30
/** how near a corner the pointer has to be for a bracket in hand to settle onto it (mm) */
const REACH = 70
/** the plate lies on the face, not in it: its back is at zero, so nothing to offset by */
const HALF_THICK = 0

/**
 * A lateral position that is a slot on both faces, or null when there is none.
 *
 * This is the real rule behind "the two sections must share an edge" and behind pushing a
 * member flush with the outside of a bigger one. A bracket is one rigid part: its two bolts
 * are at the same position across the joint, so that one position has to land on a slot in
 * each member. A 20 face has a slot down its middle; a 40 face has two, ten either side.
 * Centre a 2020 on a 4040 and there is no such position — the 2020's only slot line lands on
 * the 4040's solid middle. Push it flush to one side and there is.
 */
export function sharedSlotLine(
  aCentre: number, aFaceWidth: number, bCentre: number, bFaceWidth: number, tol = 1,
): number | null {
  let best: { at: number; d: number } | null = null
  for (const sa of slotOffsets(aFaceWidth)) {
    for (const sb of slotOffsets(bFaceWidth)) {
      const d = Math.abs((aCentre + sa) - (bCentre + sb))
      if (d > tol) continue
      const at = (aCentre + sa + bCentre + sb) / 2
      if (!best || Math.abs(at) < Math.abs(best.at)) best = { at, d }
    }
  }
  return best ? best.at : null
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

/**
 * Seat a corner bracket at the point where `a`'s end meets `b`.
 *
 * Returns null when no flat bracket can be bolted there — the two members present no shared
 * face, which is the same thing the amber joint markers are complaining about.
 */
/**
 * Seat a cast corner bracket: two flanges at ninety degrees, in the inside of the corner.
 *
 * Take a rail running +X that ends against a post running +Y. The inside of the L is the
 * quadrant they enclose, and the bracket sits in it: one flange flat on the rail's face that
 * looks towards the post, the other flat on the post's face that looks towards the rail.
 * So the two mounting faces are the ones whose normals are the *other* member's direction —
 * which is the whole of the geometry, and is nothing like a plate lying across an outside
 * face. Both are real parts; they are not the same part.
 */
export function seatAngle(a: ProfileData, b: ProfileData, at: THREE.Vector3): BracketSeat | null {
  const intoA = into(a, at)
  const intoB = into(b, at)
  if (Math.abs(intoA.dot(intoB)) > 0.9) return null       // parallel: not a corner

  // across the joint: the one direction neither member runs along
  const n = new THREE.Vector3().crossVectors(intoA, intoB).normalize()

  // the flange on A lies on A's face looking towards B, and vice versa
  const faceA = crossExtentAlong(a, intoB)
  const faceB = crossExtentAlong(b, intoA)

  // both bolts sit at the same place across the joint, so that place has to be a slot on
  // both faces — measured from each member's own centreline
  const aAxis = closestOnSegment(at, ...(({ start, end }) => [start, end] as const)(getProfileEndpoints(a))).point
  const bAxis = closestOnSegment(at, ...(({ start, end }) => [start, end] as const)(getProfileEndpoints(b))).point
  const line = sharedSlotLine(
    aAxis.dot(n), crossExtentAlong(a, n) * 2,
    bAxis.dot(n), crossExtentAlong(b, n) * 2,
  )
  if (line === null) return null

  // the inside vertex: on A's face along intoB, and on B's face along intoA
  const position = new THREE.Vector3()
    .addScaledVector(intoA, bAxis.dot(intoA) + faceB)
    .addScaledVector(intoB, aAxis.dot(intoB) + faceA)
    .addScaledVector(n, line)

  const basis = new THREE.Matrix4().makeBasis(intoA, intoB, n)
  const quat = new THREE.Quaternion().setFromRotationMatrix(basis)
  return {
    position: [round1(position.x), round1(position.y), round1(position.z)],
    quaternion: [quat.x, quat.y, quat.z, quat.w],
    series: Math.min(seriesOf(a.spec), seriesOf(b.spec)) as ConnectorSeries,
    legs: [a.id, b.id],
    slotOffsets: [line - aAxis.dot(n), line - bAxis.dot(n)],
  }
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

/**
 * Where the part in hand would actually land, for both the ghost and the click.
 *
 * A bracket dropped near a corner does not belong where the pointer is — it belongs on the
 * joint, seated on its slots. Showing the ghost anywhere else means the part jumps when the
 * button goes down, and then nobody trusts the ghost. So the preview and the placement ask
 * the same question and get the same answer.
 */
export function connectorSeatAt(
  type: string, point: THREE.Vector3, profiles: ProfileData[], surfaceNormal?: THREE.Vector3 | null,
): { position: [number, number, number]; quaternion: [number, number, number, number]; series: ConnectorSeries; seated: boolean } {
  const entry = connectorEntry(type)
  // anything that meets two members at a corner has a seat to find; the rest is placed where
  // it was dropped, because which face a plate or a foot goes on is nobody's inference
  if (entry?.seat === 'angle' || entry?.seat === 'plate') {
    // Generous on purpose. The part is twenty millimetres on a frame metres across, so
    // asking for the pointer to be on the joint is asking for pixel work; anywhere in the
    // neighbourhood of a corner can only have meant that corner.
    const contacts = membersAt(point, profiles, REACH)
    // the member whose end is here is the one butting in; the other is what it butts into
    const butting = contacts.find((c) => c.atEnd) ?? contacts[0]
    const partner = contacts.find((c) => c !== butting && Math.abs(c.away.dot(butting?.away ?? c.away)) < 0.9)
    if (butting && partner) {
      // Seat it at the joint, not at the pointer. Being generous about where the pointer has
      // to be only works if everything downstream still measures from the corner itself.
      const { start, end } = getProfileEndpoints(butting.profile)
      const joint = point.distanceTo(start) <= point.distanceTo(end) ? start : end
      const seat = seatFor(type, butting.profile, partner.profile, joint)
      if (seat) return { ...seat, seated: true }
    }
  }
  // A part that stands under a post has one place it can go, and that is under the end —
  // not wherever the pointer happened to be on the way there. Dropped at the click, sixty-
  // eight levelling feet ended up inside the posts they were meant to hold up, and every one
  // of them was reported as metal through metal, which is exactly what it was.
  if (entry?.fit === 'inline' && entry.axes.towards === 'in') {
    const near = membersAt(point, profiles, REACH)
      .map((c) => {
        const { start, end } = getProfileEndpoints(c.profile)
        const at = point.distanceTo(start) <= point.distanceTo(end) ? start : end
        return { c, at, atStart: point.distanceTo(start) <= point.distanceTo(end), d: point.distanceTo(at) }
      })
      .sort((x, y) => x.d - y.d)[0]
    if (near) {
      const fit = fitConnector(type, near.at, profiles, surfaceNormal)
      const outward = getProfileDir(near.c.profile)
      if (near.atStart) outward.negate()
      const reach = connectorExtent(type).half[AXIS_INDEX[entry.axes.primary]] * connectorScale(fit.series)
      const at = near.at.clone().addScaledVector(outward, reach)
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

/**
 * Seat whichever kind of part this is.
 *
 * An angle bracket and a plate are both "the thing you put on a corner", and they go in
 * completely different places — inside the corner with perpendicular flanges, or flat across
 * an outside face. Asking one function for "the bracket seat" and getting the plate answer is
 * what put every cast bracket in this drawing on the wrong side of the metal.
 */
export function seatFor(type: string, a: ProfileData, b: ProfileData, at: THREE.Vector3): BracketSeat | null {
  // Sections with no edge in common are not joined end-to-face, whatever the slots would
  // allow. A 20-series bracket will bolt a flush 2020 to a 4040, and it covers half the face
  // it is holding; a 40-series one has the wrong hole pitch for the 2020. Neither is a joint
  // anybody builds, so none of these parts offers it.
  if (!sharedEdge(a.spec, b.spec)) return null
  const kind = connectorEntry(type)?.seat
  if (kind === 'angle') return seatAngle(a, b, at)
  if (kind === 'plate') return seatBracket(a, b, at)
  return null
}

export interface BracketFault {
  id: string
  /** how far it is from where it should be (mm) */
  off: number
  reason: 'off-seat' | 'no-joint'
  at: THREE.Vector3
}

/** how far a fitted bracket may sit from its seat before it is wrong (mm) */
const SEAT_TOL = 3

/**
 * Brackets that are not where they could be bolted.
 *
 * Worth checking because nothing else will: a bracket floating beside a joint renders
 * exactly like one bolted to it, and the cut list counts it either way. The seat is the
 * same calculation the placement uses, so this asks whether each part is where the tool
 * would put it now — which catches parts left behind by a member that has since moved, and
 * anything placed by hand in a spot that has no slots under it.
 */
export function auditBrackets(profiles: ProfileData[], connectors: ConnectorData[]): BracketFault[] {
  const faults: BracketFault[] = []
  const ends = profiles.map((p) => ({ p, ...getProfileEndpoints(p) }))
  for (const c of connectors) {
    if (!connectorEntry(c.type)?.isCornerBracket) continue
    const here = new THREE.Vector3(...c.position)
    // the joint it belongs to: the nearest end of any member that butts into another
    let best: { seat: BracketSeat; d: number } | null = null
    for (const { p, start, end } of ends) {
      for (const at of [start, end]) {
        // Wide enough to still find the joint a bracket was stepped along a post to reach,
        // which is a legitimate placement and can be a few section widths from the corner.
        if (at.distanceTo(here) > JOINT_TOL * 6) continue
        for (const { p: q } of ends) {
          if (q.id === p.id) continue
          const { start: qs, end: qe } = getProfileEndpoints(q)
          if (closestOnSegment(at, qs, qe).point.distanceTo(at) > JOINT_TOL) continue
          const seat = seatFor(c.type, p, q, at)
          if (!seat) continue
          // Sliding along the member a bracket is bolted to is free: a slot runs the whole
          // length of a profile, so the bolt is still on its slot line. It is what stepping
          // two brackets apart at a shared post does. Only the offset across the member is
          // a bracket that is not where it can be bolted.
          const along = getProfileDir(q)
          const off = new THREE.Vector3(...seat.position).sub(here)
          const d = off.clone().addScaledVector(along, -off.dot(along)).length()
          if (!best || d < best.d) best = { seat, d }
        }
      }
    }
    if (!best) { faults.push({ id: c.id, off: Infinity, reason: 'no-joint', at: here }); continue }
    if (best.d > SEAT_TOL) faults.push({ id: c.id, off: Math.round(best.d * 10) / 10, reason: 'off-seat', at: here })
  }
  return faults
}
