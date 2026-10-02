import type { ConnectorData, FittingData, PanelData, ProfileData } from '../store/useStore'
import { getProfileDir } from './geometryCore'
import { computeAllTrims, trimmedBox, type ThroughRule } from './jointUtils'
import { connectorOBB, trimmedOBB } from './analysis'
import { obbPenetration, type OBB } from './obb'

/**
 * Suggest assembly steps from member contact and height, starting each disconnected group
 * from its lowest member. Stability, fastener insertion and tool access are not checked.
 */

/** Maximum distance from the floor for the initial batch (mm). */
const GROUND_TOL = 1
/** Maximum number of profiles per step. */
const STEP_MAX = 10

export interface Step {
  /** 1-based, as printed */
  n: number
  /** members that go on in this step */
  profiles: string[]
  /** Connectors assigned after their touching profiles. */
  connectors: string[]
  /** boards and fittings, which go in last of all */
  panels: string[]
  fittings: string[]
  /** Lowest profile height in this step (mm). */
  atHeight: number
}

/** Contact between the actual boxes, allowing only numerical/placement noise (0.1 mm). */
export function bodiesTouch(a: OBB, b: OBB, tolerance = 0.1): boolean {
  const expanded = { ...a, half: a.half.clone().addScalar(tolerance + 1e-6) }
  return obbPenetration(expanded, b) > 0
}

/** Profile neighbours determined by box contact. */
function neighbours(profiles: ProfileData[], bodies: Map<string, OBB>): Map<string, string[]> {
  const out = new Map<string, string[]>(profiles.map((p) => [p.id, []]))
  for (const a of profiles) {
    for (const b of profiles) {
      if (a.id === b.id) continue
      if (bodiesTouch(bodies.get(a.id)!, bodies.get(b.id)!)) out.get(a.id)!.push(b.id)
    }
  }
  return out
}

const compareId = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0
const orderedIds = (parts: Array<{ id: string }>) => [...parts].sort(compareId).map((part) => part.id)

/** A profile joins a batch when it reaches the floor or touches an earlier batch. */
export function assemblySteps(
  profiles: ProfileData[], connectors: ConnectorData[] = [],
  panels: PanelData[] = [], fittings: FittingData[] = [],
  rule?: ThroughRule,
): Step[] {
  if (profiles.length === 0) return panels.length || fittings.length || connectors.length
    ? [{ n: 1, profiles: [], connectors: orderedIds(connectors), panels: orderedIds(panels), fittings: orderedIds(fittings), atHeight: 0 }] : []
  const trims = computeAllTrims(profiles, rule)
  const bodies = new Map(profiles.map((p) => [p.id, trimmedOBB(p, trims.get(p.id)!)]))
  const height = new Map(profiles.map((p) => [p.id, trimmedBox(p, trims.get(p.id)!).min.y]))
  const lowest = (p: ProfileData) => height.get(p.id)!
  const near = neighbours(profiles, bodies)
  const placed = new Set<string>()
  const steps: Step[] = []
  const left = [...profiles].sort((a, b) => lowest(a) - lowest(b)
    || a.position[0] - b.position[0] || a.position[2] - b.position[2] || compareId(a, b))

  while (placed.size < profiles.length) {
    const ready = left.filter((p) => !placed.has(p.id)
      && (lowest(p) <= GROUND_TOL || near.get(p.id)!.some((q) => placed.has(q))))
    // Start an unconnected group at its lowest remaining profile.
    const wave = ready.length > 0 ? ready : left.filter((p) => !placed.has(p.id)).slice(0, 1)

    // Prioritize upright members within the ready batch.
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

  // Assign each connector to the latest step containing a touching profile.
  const stepOf = new Map<string, number>()
  for (const s of steps) for (const id of s.profiles) stepOf.set(id, s.n - 1)
  for (const c of [...connectors].sort(compareId)) {
    const body = connectorOBB(c)
    let last = 0
    for (const p of profiles) {
      if (bodiesTouch(body, bodies.get(p.id)!)) last = Math.max(last, stepOf.get(p.id) ?? 0)
    }
    steps[last].connectors.push(c.id)
  }

  // Append boards and fittings after the profile steps.
  if (panels.length > 0 || fittings.length > 0) {
    steps.push({
      n: steps.length + 1,
      profiles: [], connectors: [],
      panels: orderedIds(panels),
      fittings: orderedIds(fittings),
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
