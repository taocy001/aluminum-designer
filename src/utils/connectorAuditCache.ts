import { auditBrackets } from './bracketSeat'
import type { ProfileTrims } from './jointUtils'
import type { SuggestDoc } from './suggestGate'

interface HardwareSupports { faults: Set<string>; supported: Map<string, string[]> }
const hardwareSupportCache = new Map<string, HardwareSupports>()

/** Repeated searches can share only this document audit, never candidate validation.
 * Snapshot every audit input by value so edits to existing arrays and cut faces invalidate it. */
export function cachedHardwareSupports(doc: Pick<SuggestDoc, 'profiles' | 'connectors'>, trims: Map<string, ProfileTrims>): HardwareSupports {
  const key = JSON.stringify([
    doc.profiles.map((p) => {
      const t = trims.get(p.id)!
      return [p.id, p.spec, p.length, p.position, p.quaternion, p.miterCuts,
        t.start.trim, t.end.trim, t.cutLength]
    }),
    doc.connectors.map((c) => [c.id, c.type, c.series, c.profileSpec, c.mountSeries, c.position, c.quaternion]),
  ])
  const cached = hardwareSupportCache.get(key)
  if (cached) return cached
  const supported = new Map<string, string[]>()
  const faults = new Set(auditBrackets(doc.profiles, doc.connectors, trims, supported).map((f) => f.id))
  const result = { faults, supported }
  if (hardwareSupportCache.size >= 8) hardwareSupportCache.delete(hardwareSupportCache.keys().next().value!)
  hardwareSupportCache.set(key, result)
  return result
}

