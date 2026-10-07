import { auditBrackets, type BracketFault } from './bracketSeat'
import type { ProfileTrims } from './jointUtils'
import type { SuggestDoc } from './suggestGate'

interface HardwareSupports {
  readonly faults: ReadonlySet<string>
  readonly supported: ReadonlyMap<string, readonly string[]>
  readonly faultDetails: readonly Readonly<BracketFault>[]
}
const hardwareSupportCache = new Map<string, HardwareSupports>()

/** Rendering and searches share the document audit, never candidate validation.
 * Snapshot every audit input by value so edits to existing arrays and cut faces invalidate it. */
export function cachedHardwareSupports(doc: Pick<SuggestDoc, 'profiles' | 'connectors'> & Partial<Pick<SuggestDoc, 'panels'>>, trims: Map<string, ProfileTrims>): HardwareSupports {
  // Ordinary profile hardware has no board support. Unrelated panel subsets must
  // not split its audit cache across candidate neighbourhoods.
  const panels = doc.connectors.some((c) => c.panelMount) ? doc.panels : undefined
  const key = JSON.stringify([
    doc.profiles.map((p) => {
      const t = trims.get(p.id)!
      return [p.id, p.spec, p.length, p.position, p.quaternion, p.miterCuts,
        t.start.trim, t.end.trim, t.cutLength]
    }),
    doc.connectors.map((c) => [c.id, c.type, c.series, c.profileSpec, c.mountSeries, c.position, c.quaternion, c.panelMount]),
    panels,
  ])
  const cached = hardwareSupportCache.get(key)
  if (cached) return cached
  const supported = new Map<string, string[]>()
  const faultDetails = Object.freeze(auditBrackets(doc.profiles, doc.connectors, trims, supported, panels)
    .map((fault) => { Object.freeze(fault.at); return Object.freeze(fault) }))
  for (const ids of supported.values()) Object.freeze(ids)
  const faults = new Set(faultDetails.map((f) => f.id))
  const result = Object.freeze({ faults, supported, faultDetails })
  if (hardwareSupportCache.size >= 8) hardwareSupportCache.delete(hardwareSupportCache.keys().next().value!)
  hardwareSupportCache.set(key, result)
  return result
}
