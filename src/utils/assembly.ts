import * as THREE from 'three'
import type { ConnectorData, FittingData, PanelData, ProfileData } from '../store/useStore'
import { getProfileDir, getProfileEndpoints, closestOnSegment } from './geometryCore'

/**
 * What to build first.
 *
 * The drawing says what the thing is; it says nothing about the order the pieces go on in,
 * and that is the question everybody actually has in front of a pile of extrusion. None of
 * the tools this one is measured against answers it.
 *
 * The order is not a preference, it is a constraint: you cannot bolt a rail to a post that is
 * not standing yet, and a post is standing when whatever holds its foot is there. So the
 * sweep is topological — take everything whose supports are already placed, lowest first,
 * and repeat. Ties are broken by height and then by position, so the same drawing always
 * gives the same instructions.
 */

/** how close two members have to be to count as bolted together (mm) */
const JOINT_TOL = 30
/** a member whose foot is this close to the floor stands on its own */
const GROUND_TOL = 25
/** as many parts as fit in one step before it is worth splitting */
const STEP_MAX = 10

export interface Step {
  /** 1-based, as printed */
  n: number
  /** members that go on in this step */
  profiles: string[]
  /** brackets that can be bolted once those members are on */
  connectors: string[]
  /** boards and fittings, which go in last of all */
  panels: string[]
  fittings: string[]
  /** the height this step works at (mm), which is what makes the order readable */
  atHeight: number
}

function lowest(p: ProfileData): number {
  const { start, end } = getProfileEndpoints(p)
  return Math.min(start.y, end.y)
}

/** which members each one is bolted to */
function neighbours(profiles: ProfileData[]): Map<string, string[]> {
  const ends = new Map(profiles.map((p) => [p.id, getProfileEndpoints(p)]))
  const out = new Map<string, string[]>(profiles.map((p) => [p.id, []]))
  for (const a of profiles) {
    const ea = ends.get(a.id)!
    for (const b of profiles) {
      if (a.id === b.id) continue
      const eb = ends.get(b.id)!
      const near = [ea.start, ea.end].some((pt) => closestOnSegment(pt, eb.start, eb.end).point.distanceTo(pt) <= JOINT_TOL)
        || [eb.start, eb.end].some((pt) => closestOnSegment(pt, ea.start, ea.end).point.distanceTo(pt) <= JOINT_TOL)
      if (near) out.get(a.id)!.push(b.id)
    }
  }
  return out
}

/**
 * The order the parts go on in, split into steps.
 *
 * A member is ready when it stands on the floor, or when at least one thing it is bolted to
 * is already on. That is weaker than "everything it touches" on purpose: a rail between two
 * posts is fitted when the first post is up and the second is offered to it, which is how it
 * is really done, and requiring both would deadlock a frame with no free end.
 */
export function assemblySteps(
  profiles: ProfileData[], connectors: ConnectorData[] = [],
  panels: PanelData[] = [], fittings: FittingData[] = [],
): Step[] {
  if (profiles.length === 0) return []
  const near = neighbours(profiles)
  const placed = new Set<string>()
  const steps: Step[] = []
  const left = [...profiles].sort((a, b) => lowest(a) - lowest(b)
    || a.position[0] - b.position[0] || a.position[2] - b.position[2])

  while (placed.size < profiles.length) {
    const ready = left.filter((p) => !placed.has(p.id)
      && (lowest(p) <= GROUND_TOL || near.get(p.id)!.some((q) => placed.has(q))))
    // nothing is reachable from what is already up — a separate piece of furniture, so start
    // it the same way the first one started, from its own lowest member
    const wave = ready.length > 0 ? ready : left.filter((p) => !placed.has(p.id)).slice(0, 1)

    // posts before the rails that hang off them, and one height at a time
    const upright = wave.filter((p) => Math.abs(getProfileDir(p).y) > 0.7)
    const batch = (upright.length > 0 ? upright : wave).slice(0, STEP_MAX)
    for (const p of batch) placed.add(p.id)
    steps.push({
      n: steps.length + 1,
      profiles: batch.map((p) => p.id),
      connectors: [], panels: [], fittings: [],
      atHeight: Math.round(Math.min(...batch.map(lowest))),
    })
  }

  // A bracket goes on with the later of the two members it joins, because that is the first
  // moment both of its flanges have something to sit on.
  const stepOf = new Map<string, number>()
  for (const s of steps) for (const id of s.profiles) stepOf.set(id, s.n - 1)
  const ends = new Map(profiles.map((p) => [p.id, getProfileEndpoints(p)]))
  for (const c of connectors) {
    const at = new THREE.Vector3(...c.position)
    let last = 0
    for (const p of profiles) {
      const e = ends.get(p.id)!
      if (closestOnSegment(at, e.start, e.end).point.distanceTo(at) <= 60) last = Math.max(last, stepOf.get(p.id) ?? 0)
    }
    steps[last].connectors.push(c.id)
  }

  // Boards and fittings go in after the frame is standing: a door cannot be hung on a post
  // that is still being squared up, and a shelf put in early is in the way of the spanner.
  if (panels.length > 0 || fittings.length > 0) {
    steps.push({
      n: steps.length + 1,
      profiles: [], connectors: [],
      panels: panels.map((p) => p.id),
      fittings: fittings.map((f) => f.id),
      atHeight: 0,
    })
  }
  return steps
}

/** everything that is on by the end of step `n` (1-based) */
export function shownAt(steps: Step[], n: number): {
  profiles: Set<string>; connectors: Set<string>; panels: Set<string>; fittings: Set<string>
} {
  const out = { profiles: new Set<string>(), connectors: new Set<string>(), panels: new Set<string>(), fittings: new Set<string>() }
  for (const s of steps) {
    if (s.n > n) break
    for (const id of s.profiles) out.profiles.add(id)
    for (const id of s.connectors) out.connectors.add(id)
    for (const id of s.panels) out.panels.add(id)
    for (const id of s.fittings) out.fittings.add(id)
  }
  return out
}
