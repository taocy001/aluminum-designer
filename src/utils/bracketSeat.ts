import * as THREE from 'three'
import type { ConnectorData, ProfileData } from '../store/useStore'
import { getProfileDir, getProfileEndpoints, closestOnSegment, crossExtentAlong } from './geometryCore'
import { flushFace } from './specCompat'
import { nearestSlot } from './specUtils'
import { connectorEntry, connectorScale, seriesOf, type ConnectorSeries } from './connectorCatalog'
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
/** half the thickness of the modelled part, so it rests on the face instead of in it (mm) */
const HALF_THICK = 2

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
export function seatBracket(a: ProfileData, b: ProfileData, at: THREE.Vector3): BracketSeat | null {
  const face = flushFace(a, b, at)
  if (!face) return null

  const n = face.normal.clone()
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
  const planePoint = at.clone().addScaledVector(n, face.offset)
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

function round1(v: number): number { return Math.round(v * 10) / 10 }

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
  if (entry?.isCornerBracket) {
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
      const seat = seatBracket(butting.profile, partner.profile, joint)
      if (seat) return { ...seat, seated: true }
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
        if (at.distanceTo(here) > JOINT_TOL * 2) continue
        for (const { p: q } of ends) {
          if (q.id === p.id) continue
          const { start: qs, end: qe } = getProfileEndpoints(q)
          if (closestOnSegment(at, qs, qe).point.distanceTo(at) > JOINT_TOL) continue
          const seat = seatBracket(p, q, at)
          if (!seat) continue
          const d = new THREE.Vector3(...seat.position).distanceTo(here)
          if (!best || d < best.d) best = { seat, d }
        }
      }
    }
    if (!best) { faults.push({ id: c.id, off: Infinity, reason: 'no-joint', at: here }); continue }
    if (best.d > SEAT_TOL) faults.push({ id: c.id, off: Math.round(best.d * 10) / 10, reason: 'off-seat', at: here })
  }
  return faults
}
