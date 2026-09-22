import * as THREE from 'three'
import { useStore, type ProfileData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { getProfileDir, getProfileEndpoints, closestOnSegment, crossExtentAlong, round3 } from './geometryCore'
import { bracketNormal, flushFace, sharedEdge } from './specCompat'
import { specDims } from './specUtils'
import { translations } from './translations'

const JOINT_TOL = 30
const FLUSH_TOL = 0.5
/** a shift bigger than this is a different design decision, not a correction (mm) */
const MAX_SHIFT = 60

interface Shift { axis: THREE.Vector3; amount: number }

/**
 * How far a member would have to move, perpendicular to itself, for a bracket to lie flat
 * across this joint. Zero when it already does, null when no face pair is close enough to
 * be worth reaching for.
 */
function shiftForJoint(a: ProfileData, b: ProfileData, at: THREE.Vector3): Shift | null {
  // sections with no edge in common cannot be bolted together however they are placed, so
  // sliding one of them about would only hide the problem
  if (!sharedEdge(a.spec, b.spec)) return null
  const n = bracketNormal(a, b)
  if (!n) return null
  const ea = crossExtentAlong(a, n)
  const eb = crossExtentAlong(b, n)
  const aBase = new THREE.Vector3(...a.position).sub(at).dot(n)
  const bBase = new THREE.Vector3(...b.position).sub(at).dot(n)

  // Only a step caused by the two sections being different sizes is ours to close. When the
  // centrelines already sit apart, the gap is where the member was put, not how thick it is —
  // correcting that would turn a five-millimetre slip of the mouse into an authoritative
  // position, and it would outvote the real correction because it is smaller.
  if (Math.abs(aBase - bBase) > FLUSH_TOL) return null

  // Both of the partner's faces are reachable, and the shift to either is the same size, so
  // size cannot choose between them. Take the outer one: a frame is meant to be flush on the
  // outside, and a rail hung under a cabinet should meet its bottom edge, not its top.
  let best: { delta: number; outward: number } | null = null
  for (const sa of [1, -1]) {
    for (const sb of [1, -1]) {
      const delta = (bBase + sb * eb) - (aBase + sa * ea)
      if (Math.abs(delta) > MAX_SHIFT) continue
      const outward = Math.abs(bBase + sb * eb)   // how far the shared plane is from the partner's axis
      if (!best || outward > best.outward + 0.01
        || (Math.abs(outward - best.outward) < 0.01 && Math.abs(delta) < Math.abs(best.delta))) {
        best = { delta, outward }
      }
    }
  }
  return best === null ? null : { axis: n, amount: best.delta }
}

/**
 * Turn the section a quarter turn if that makes more of its joints flush than leaving it.
 * Returns the turned member, or null when turning is no help or there is nothing to turn.
 */
function tryRoll(candidate: ProfileData, others: ProfileData[]): ProfileData | null {
  const { w, h } = specDims(candidate.spec)
  if (w === h) return null                      // square: nothing to turn

  const flushCount = (p: ProfileData) => {
    const { start, end } = getProfileEndpoints(p)
    let n = 0
    for (const b of others) {
      const eb = getProfileEndpoints(b)
      const touch = [start, end]
        .map((pt) => ({ pt, d: closestOnSegment(pt, eb.start, eb.end).point.distanceTo(pt) }))
        .sort((x, y) => x.d - y.d)[0]
      if (touch.d > JOINT_TOL) continue
      if (!sharedEdge(p.spec, b.spec)) continue
      if (flushFace(p, b, touch.pt)) n++
    }
    return n
  }

  const asIs = flushCount(candidate)
  const axis = getProfileDir(candidate)
  const spin = new THREE.Quaternion().setFromAxisAngle(axis, Math.PI / 2)
  const q = spin.multiply(new THREE.Quaternion(...candidate.quaternion)).normalize()
  const turned: ProfileData = { ...candidate, quaternion: [q.x, q.y, q.z, q.w] }
  return flushCount(turned) > asIs ? turned : null
}

/**
 * Slide a freshly drawn member sideways so the faces its brackets will sit on line up with
 * whatever it landed on.
 *
 * Frames are laid out on a grid of centrelines, which is how people think, but they are
 * assembled face to face: a rail drawn through the middle of a wider post leaves a step no
 * flat bracket can bridge. The correction is applied once, at creation, against members that
 * already exist — so the first member sets the plane and everything drawn onto it follows.
 *
 * Doing the same thing later, by walking the whole frame and nudging members, does not work:
 * moving a rail to meet its post pulls it out from under the uprights standing on it, and the
 * repair chases itself around the frame without converging.
 */
export function faceAlignOnCreate(candidate: ProfileData, others: ProfileData[]): ProfileData {
  if (others.length === 0) return candidate

  // A rectangular section has two edges to offer. A 2040 turned so its 40 side faces a 4040
  // is flush with it where it stands; turned the other way it has to be pushed 10 mm off the
  // line to reach the same plane. Turning costs nothing, so try that first — it is why a
  // 2040 goes with everything, and why reaching for a heavier section instead was wrong.
  const rolled = tryRoll(candidate, others)
  if (rolled) return rolled

  const { start, end } = getProfileEndpoints(candidate)
  const votes: THREE.Vector3[] = []

  for (const b of others) {
    const eb = getProfileEndpoints(b)
    const touch = [start, end]
      .map((pt) => ({ pt, d: closestOnSegment(pt, eb.start, eb.end).point.distanceTo(pt) }))
      .sort((x, y) => x.d - y.d)[0]
    if (touch.d > JOINT_TOL) continue
    const shift = shiftForJoint(candidate, b, touch.pt)
    if (!shift || Math.abs(shift.amount) <= FLUSH_TOL) continue
    votes.push(shift.axis.clone().multiplyScalar(shift.amount))
  }
  if (votes.length === 0) return candidate

  // the shift the most joints agree on; the smallest wins a tie, because a correction is
  // meant to be the nearest way to make the part fit, not a relocation
  const buckets = new Map<string, { v: THREE.Vector3; n: number }>()
  for (const v of votes) {
    const key = v.toArray().map((x) => Math.round(x * 10) / 10).join(',')
    const cur = buckets.get(key)
    if (cur) cur.n++
    else buckets.set(key, { v, n: 1 })
  }
  const pick = [...buckets.values()].sort((x, y) => y.n - x.n || x.v.length() - y.v.length())[0]
  const p = new THREE.Vector3(...candidate.position).add(pick.v)
  return { ...candidate, position: [round3(p.x), round3(p.y), round3(p.z)] }
}

/**
 * Joints where a flat bracket still cannot lie, counted once per pair.
 *
 * This asks the question directly rather than through `shiftForJoint`, which only answers
 * "is there a correction we would make" — those are different, because a step this tool
 * declines to close is still a step.
 */
export function countUnflush(profiles: ProfileData[]): number {
  const ends = new Map(profiles.map((p) => [p.id, getProfileEndpoints(p)]))
  const seen = new Set<string>()
  for (const a of profiles) {
    const ea = ends.get(a.id)!
    for (const b of profiles) {
      if (a.id === b.id) continue
      const eb = ends.get(b.id)!
      const touch = [ea.start, ea.end]
        .map((pt) => ({ pt, d: closestOnSegment(pt, eb.start, eb.end).point.distanceTo(pt) }))
        .sort((x, y) => x.d - y.d)[0]
      if (touch.d > JOINT_TOL) continue
      if (!bracketNormal(a, b)) continue
      if (sharedEdge(a.spec, b.spec) && flushFace(a, b, touch.pt)) continue
      seen.add([a.id, b.id].sort().join('|'))
    }
  }
  return seen.size
}

/** Turn a member's section a quarter turn about its own axis (2040 on edge ↔ lying flat) */
export function rollProfile(id: string, quarters = 1): boolean {
  const store = useStore.getState()
  const p = store.profiles.find((q) => q.id === id)
  const t = translations[useToolStore.getState().language]
  if (!p) return false
  if (p.locked) { useToolStore.getState().showToast(t.toastLocked, 'error'); return false }
  const axis = getProfileDir(p)
  const spin = new THREE.Quaternion().setFromAxisAngle(axis, (Math.PI / 2) * quarters)
  const q = spin.multiply(new THREE.Quaternion(...p.quaternion)).normalize()
  store.commitTransform({ profiles: [{ id, updates: { quaternion: [q.x, q.y, q.z, q.w] } }] })
  return true
}

/** Which way a rectangular section is turned, for the panel: the direction its long side faces */
export function sectionFacing(p: ProfileData): THREE.Vector3 {
  const quat = new THREE.Quaternion(...p.quaternion).normalize()
  const { w, h } = { w: Number(p.spec.slice(0, 2)), h: Number(p.spec.slice(2)) }
  const long = h >= w ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
  return long.applyQuaternion(quat)
}
