import * as THREE from 'three'
import type { ConnectorData, ProfileData, ProfileSpec } from '../store/useStore'
import { getProfileDir, getProfileEndpoints, closestOnSegment, crossExtentAlong } from './geometryCore'
import { flushFaces } from './specCompat'
import { slotOffsets, profileSlotDimensions } from './specUtils'
import { connectorEntry, connectorMounts, connectorScale, seriesOf, type ConnectorSeries } from './connectorCatalog'
import { fitConnector, jointPairsAt } from './connectorFit'
import { computeAllTrims, type ProfileTrims } from './jointUtils'
import { trimmedOBB } from './analysis'
import type { OBB } from './obb'
import { hardwareReference, insideCornerDimensions } from './connectorHardware'
import { endCornerSeats, surfaceSeats, mountingEnds, nonCornerMounted, nonCornerSupports } from './connectorMounting'

/**
 * Connector seats aligned to the members' mounting faces and slot lines.
 * Inside angles use perpendicular faces; flat plates use a shared outside face.
 * Corner seats are checked against bolt positions and the trimmed member bodies.
 */

/** how close an end has to be to the other member's centreline to be its joint (mm) */
const JOINT_TOL = 30
/** how near a corner the pointer has to be for a bracket in hand to settle onto it (mm) */
const REACH = 70

/** First shared slot line, or null when the mounting faces have no matching slots. */
export function sharedSlotLine(
  aCentre: number, aFaceWidth: number, bCentre: number, bFaceWidth: number, tol = 1,
): number | null {
  return sharedSlotLines(aCentre, aFaceWidth, bCentre, bFaceWidth, tol)[0] ?? null
}

/** All bolt lines shared by the two mounting faces, nearest the origin first. */
export function sharedSlotLines(
  aCentre: number, aFaceWidth: number, bCentre: number, bFaceWidth: number, tol = 1,
  aSeries: ConnectorSeries = 20, bSeries: ConnectorSeries = 20,
): number[] {
  const lines: number[] = []
  for (const sa of slotOffsets(aFaceWidth, aSeries)) {
    for (const sb of slotOffsets(bFaceWidth, bSeries)) {
      const d = Math.abs((aCentre + sa) - (bCentre + sb))
      if (d > tol) continue
      const at = (aCentre + sa + bCentre + sb) / 2
      if (!lines.some((line) => Math.abs(line - at) < 1e-6)) lines.push(at)
    }
  }
  return lines.sort((a, b) => Math.abs(a) - Math.abs(b) || a - b)
}

export interface BracketSeat {
  profileSpec?: ProfileSpec
  mountSeries?: [ConnectorSeries, ConnectorSeries]
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
    bAxis.dot(n), crossExtentAlong(b, n) * 2, 1, seriesOf(a.spec), seriesOf(b.spec),
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

/** All outside faces, slot combinations, arm directions and through/branch assignments. */
function plateSeats(a: ProfileData, b: ProfileData, at: THREE.Vector3): BracketSeat[] {
  const seats: BracketSeat[] = []
  for (const face of flushFaces(a, b, at)) {
    const n = face.normal
    const planePoint = at.clone().addScaledVector(n, face.offset)
    for (const sx of [1, -1]) for (const sy of [1, -1]) {
      for (const [memberX, memberY] of [[a, b], [b, a]]) {
        const x = into(memberX, at).multiplyScalar(sx), y = into(memberY, at).multiplyScalar(sy)
        if (new THREE.Vector3().crossVectors(x, y).dot(n) < 0.999) continue
        // The intersection is determined by both actual axes, including their offsets.
        const origin = new THREE.Vector3()
          .addScaledVector(x, new THREE.Vector3(...memberY.position).dot(x))
          .addScaledVector(y, new THREE.Vector3(...memberX.position).dot(y))
          .addScaledVector(n, planePoint.dot(n))
        const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, n))
        for (const acrossX of slotOffsets(crossExtentAlong(memberX, y) * 2, seriesOf(memberX.spec))) {
          for (const acrossY of slotOffsets(crossExtentAlong(memberY, x) * 2, seriesOf(memberY.spec))) {
            const position = origin.clone().addScaledVector(y, acrossX).addScaledVector(x, acrossY)
            seats.push({ position: position.toArray().map(round1) as BracketSeat['position'],
              quaternion: q.toArray(), series: Math.min(seriesOf(a.spec), seriesOf(b.spec)) as ConnectorSeries,
              legs: [memberX.id, memberY.id], slotOffsets: [acrossX, acrossY] })
          }
        }
      }
    }
  }
  return seats
}

/** First plate seat; installation callers enumerate and audit every candidate. */
export function seatBracket(a: ProfileData, b: ProfileData, at: THREE.Vector3): BracketSeat | null {
  return plateSeats(a, b, at)[0] ?? null
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
    quaternion: quaternion.toArray() as [number, number, number, number], series: seriesOf(profile.spec), profileSpec: profile.spec, seated: true }
}

/** Compute the connector seat shared by placement previews and committed placement. */
export function connectorSeatAt(
  type: string, point: THREE.Vector3, profiles: ProfileData[], surfaceNormal?: THREE.Vector3 | null,
): { position: [number, number, number]; quaternion: [number, number, number, number]; series: ConnectorSeries; profileSpec?: ProfileSpec; mountSeries?: [ConnectorSeries, ConnectorSeries]; seated: boolean } {
  const entry = connectorEntry(type)
  if (type === 'corner-3way') {
    const seat = endCornerSeats(point, profiles)[0]
    if (seat) return seat
  }
  if (entry?.fit === 'face') {
    const seat = surfaceSeats(type, point, profiles, surfaceNormal)[0]
    if (seat) return seat
  }
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
  if (entry?.fit === 'inline' && entry.axes.towards === 'in') {
    const ends = mountingEnds(profiles).filter((e) => e.square && e.outward.y < -0.999 && e.at.distanceTo(point) <= REACH)
      .sort((a, b) => a.at.distanceToSquared(point) - b.at.distanceToSquared(point))
    for (const end of ends) {
      const into = end.outward.clone().negate(), across = end.body.axes[0]
      const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
        across, into, new THREE.Vector3().crossVectors(across, into)))
      const seat = { position: end.at.toArray() as [number, number, number], quaternion: q.toArray(),
        series: seriesOf(end.p.spec), profileSpec: end.p.spec, seated: true }
      if (nonCornerMounted({ id: 'candidate', type, ...seat }, profiles)) return seat
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

/** Dispatch seating by connector type: cast brackets use inner perpendicular faces; plates use an outer face. */
export function seatFor(type: string, a: ProfileData, b: ProfileData, at: THREE.Vector3): BracketSeat | null {
  const kind = connectorEntry(type)?.seat
  if (kind === 'angle') return seatsFor(type, a, b, at)[0] ?? null
  if (kind === 'plate') return seatsFor(type, a, b, at)[0] ?? null
  return null
}

/** Try either side of each member; bolt auditing decides which have actual metal beneath. */
export function seatsFor(type: string, a: ProfileData, b: ProfileData, at: THREE.Vector3): BracketSeat[] {
  if (type === 'corner-3way' || a.spec === '3040' || b.spec === '3040') return []
  if (type !== 'inside-corner' && seriesOf(a.spec) !== seriesOf(b.spec)) return []
  if (type === 'inside-corner' && (seriesOf(a.spec) === 20) !== (seriesOf(b.spec) === 20)) return []
  if (connectorEntry(type)?.seat === 'plate') return plateSeats(a, b, at)
  if (connectorEntry(type)?.seat !== 'angle') return []
  const aDir = into(a, at), bDir = into(b, at)
  const out: BracketSeat[] = []
  for (const sa of [1, -1]) for (const sb of [1, -1]) {
    out.push(...angleSeats(a, b, at, aDir.clone().multiplyScalar(sa), bDir.clone().multiplyScalar(sb)))
    // The inner casting has asymmetric arms and shoulder relief. Reversing the
    // assignment also reverses local Z and can change whether the real body fits.
    if (type === 'inside-corner') out.push(...angleSeats(b, a, at, bDir.clone().multiplyScalar(sb), aDir.clone().multiplyScalar(sa)))
  }
  if (type === 'inside-corner') {
    for (const seat of out) {
      const q = new THREE.Quaternion(...seat.quaternion)
      const xMember = seat.legs[0] === a.id ? a : b, yMember = seat.legs[1] === b.id ? b : a
      seat.mountSeries = [seriesOf(xMember.spec), seriesOf(yMember.spec)]
      const dx = innerInset(seriesOf(yMember.spec), 'x'), dy = innerInset(seriesOf(xMember.spec), 'y')
      const position = new THREE.Vector3(...seat.position)
        .add(new THREE.Vector3(-dx, -dy, 0).applyQuaternion(q))
      seat.position = position.toArray()
    }
  }
  return out
}

/** Discover joints around the model point; rank their seats by the picked face and surface point. */
export function connectorSeatsAt(
  type: string, point: THREE.Vector3, profiles: ProfileData[], surfaceNormal?: THREE.Vector3 | null,
  searchPoint = point,
): BracketSeat[] {
  if (type === 'corner-3way') return endCornerSeats(point, profiles)
  if (connectorEntry(type)?.fit === 'face') return surfaceSeats(type, point, profiles, surfaceNormal)
  const kind = connectorEntry(type)?.seat
  if (kind !== 'angle' && kind !== 'plate') return []
  const trims = computeAllTrims(profiles)
  const candidates = jointPairsAt(searchPoint, profiles, REACH).flatMap(({ a, b, at }) => seatsFor(type, a, b, at))
    .filter((seat) => hardwareReference(type, seat.series)?.verified && auditBrackets(profiles, [{ id: 'candidate', type, ...seat }], trims).length === 0)
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

function boltOnFace(point: THREE.Vector3, normal: THREE.Vector3, body: OBB, slots: number[][]): boolean {
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
    if (slots[across].some((slot) => Math.abs(offset - slot) <= 1)) return true
  }
  return false
}

type MountGeometry = { axis: THREE.Vector3; normal: THREE.Vector3; bolts: THREE.Vector3[] }
const mountGeometryCache = new WeakMap<ConnectorData, {
  type: string; series: number; pose: number[]; mounts: MountGeometry[]
}>()

export function innerInset(series: ConnectorSeries, normal: 'x' | 'y' = 'y'): number {
  const dims = insideCornerDimensions(series)
  return Math.max(0, profileSlotDimensions(series).lipDepth - (normal === 'x' ? dims.verticalNeckProjection : dims.neckProjection))
}

function worldMounts(c: ConnectorData): MountGeometry[] {
  const series = c.series ?? 20, cached = mountGeometryCache.get(c)
  if (cached && cached.type === c.type && cached.series === series
    && c.position.every((value, i) => value === cached.pose[i])
    && c.quaternion.every((value, i) => value === cached.pose[i + 3])) return cached.mounts
  const here = new THREE.Vector3(...c.position), quat = new THREE.Quaternion(...c.quaternion).normalize()
  const axes = { x: new THREE.Vector3(1, 0, 0).applyQuaternion(quat),
    y: new THREE.Vector3(0, 1, 0).applyQuaternion(quat), z: new THREE.Vector3(0, 0, 1).applyQuaternion(quat) }
  const k = connectorScale(series)
  const mounts = connectorMounts(c.type, c.series ?? 20).map((mount) => ({ axis: axes[mount.axis], normal: axes[mount.normal],
    bolts: mount.bolts.map((v) => new THREE.Vector3(...v).multiplyScalar(k).applyQuaternion(quat).add(here)) }))
  mountGeometryCache.set(c, { type: c.type, series, pose: [...c.position, ...c.quaternion], mounts })
  return mounts
}

/** A point query only visits nearby profile bounds, even in a large cabinet. */
function supportIndex<T extends { bounds: THREE.Box3 }>(items: T[]): (point: THREE.Vector3, visit: (item: T) => void) => void {
  type Node = { bounds: THREE.Box3; items?: T[]; children?: Node[] }
  const build = (group: T[]): Node => {
    const bounds = new THREE.Box3(), centres = new THREE.Box3()
    for (const item of group) {
      bounds.union(item.bounds)
      centres.expandByPoint(item.bounds.getCenter(new THREE.Vector3()))
    }
    if (group.length <= 4) return { bounds, items: group }
    const size = centres.getSize(new THREE.Vector3())
    const axis = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z'
    const sorted = [...group].sort((a, b) => a.bounds.min[axis] + a.bounds.max[axis] - b.bounds.min[axis] - b.bounds.max[axis])
    const middle = Math.floor(sorted.length / 2)
    return { bounds, children: [build(sorted.slice(0, middle)), build(sorted.slice(middle))] }
  }
  const root = build(items)
  return (point, visit) => {
    const search = (node: Node) => {
      if (!node.bounds.containsPoint(point)) return
      if (node.items) {
        for (const item of node.items) if (item.bounds.containsPoint(point)) visit(item)
      } else for (const child of node.children!) search(child)
    }
    search(root)
  }
}

/** Check bolt contact points against distinct members' faces, slots and cut lengths. */
export function auditBrackets(
  profiles: ProfileData[], connectors: ConnectorData[], trims = computeAllTrims(profiles),
  supportedMembers?: Map<string, string[]>,
): BracketFault[] {
  const faults: BracketFault[] = []
  const members = profiles.map((p) => {
    const body = trimmedOBB(p, trims.get(p.id)!)
    const radius = new THREE.Vector3()
    for (let i = 0; i < 3; i++) {
      const axis = body.axes[i], half = body.half.getComponent(i)
      radius.x += Math.abs(axis.x) * half
      radius.y += Math.abs(axis.y) * half
      radius.z += Math.abs(axis.z) * half
    }
    // Enclose the face, length and slot tolerances before checking exact contact.
    const bounds = new THREE.Box3(body.center.clone().sub(radius), body.center.clone().add(radius)).expandByScalar(2)
    return { p, body, bounds, slots: [slotOffsets(body.half.x * 2, seriesOf(p.spec)), slotOffsets(body.half.y * 2, seriesOf(p.spec))] }
  })
  const nearby = supportIndex(members)
  for (const c of connectors) {
    const kind = connectorEntry(c.type)?.seat
    if (!['inside-corner', 'bracket', 'gusset'].includes(c.type)) {
      const supported = nonCornerSupports(c, profiles, trims)
      if (!supported) faults.push({ id: c.id, off: Infinity, reason: 'no-joint', at: new THREE.Vector3(...c.position) })
      else supportedMembers?.set(c.id, supported)
      continue
    }
    if (kind !== 'angle' && kind !== 'plate') continue
    const here = new THREE.Vector3(...c.position)
    const series = c.series ?? 20, reference = hardwareReference(c.type, series)
    if (!reference?.verified || !reference.supportedSeries.includes(series)) {
      faults.push({ id: c.id, off: 0, reason: 'wrong-series', at: here })
      continue
    }
    // Geometry uses the instance series for both screw positions when this field
    // is absent. Auditing must use exactly the same default, including old imports.
    const mountSeries = c.mountSeries ?? [series, series]
    const supportGroups: ProfileData[][] = []
    for (const [mountIndex, mount] of worldMounts(c).entries()) {
      const supports: ProfileData[] = []
      const bolts = c.type === 'inside-corner' && [20, 30, 40].includes(mountSeries[mountIndex])
        ? mount.bolts.map((point) => point.clone().addScaledVector(mount.normal,
          innerInset(mountSeries[mountIndex], mountIndex === 0 ? 'y' : 'x'))) : mount.bolts
      const findSupports = ({ p, body, slots }: typeof members[number]) => {
        if (p.spec === '3040' || (c.type !== 'inside-corner' && seriesOf(p.spec) !== (c.series ?? 20))) return
        if (c.type === 'inside-corner' && mountSeries[mountIndex] !== seriesOf(p.spec)) return
        if (c.type === 'inside-corner' && (seriesOf(p.spec) === 20) !== ((c.series ?? 20) === 20)) return
        if (Math.abs(body.axes[2].dot(mount.axis)) > 0.999
          && bolts.every((bolt) => boltOnFace(bolt, mount.normal, body, slots))) supports.push(p)
      }
      nearby(bolts[0], findSupports)
      // Keep the original member order when more than one host meets a mount.
      if (c.type === 'inside-corner' && supports.length > 1) supports.sort((a, b) => profiles.indexOf(a) - profiles.indexOf(b))
      supportGroups.push(supports)
      if (!supports.length) break
    }
    let joint = false
    const chosen: ProfileData[] = []
    const match = (i: number, series: number): boolean => {
      if (i === supportGroups.length) {
        joint = true
        if (c.type === 'inside-corner' ? (series === 20) !== ((c.series ?? 20) === 20) : series !== (c.series ?? 20)) return false
        supportedMembers?.set(c.id, chosen.map((p) => p.id))
        return true
      }
      for (const p of supportGroups[i]) {
        if (chosen.some((other) => other.id === p.id || (c.type !== 'inside-corner' && seriesOf(other.spec) !== seriesOf(p.spec)))) continue
        chosen.push(p)
        const found = match(i + 1, Math.min(series, seriesOf(p.spec)))
        chosen.pop()
        if (found) return true
      }
      return false
    }
    const supported = match(0, Infinity)
    if (!joint) faults.push({ id: c.id, off: Infinity, reason: 'no-joint', at: here })
    else if (!supported) {
      faults.push({ id: c.id, off: 0, reason: 'wrong-series', at: here })
    }
  }
  return faults
}
