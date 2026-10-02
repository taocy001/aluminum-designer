import type { ConnectorData, FittingData, PanelData, ProfileData } from '../store/useStore'
import { computeAllTrims } from './jointUtils'

/**
 * Persist the latest 400 document-change entries across reloads.
 * Compare before/after snapshots for details; noteNext can supply an operation heading.
 */

export interface LogEntry {
  /** epoch ms */
  at: number
  /** what the gesture was called, when the caller said, else what the change looks like */
  label: string
  /** the measured specifics: which parts, and by how much */
  detail: string
  ids: string[]
}

/** how many entries are kept. Older ones fall off the end. */
const MAX_ENTRIES = 400
const KEY = 'aluframe-oplog-v1'

export interface Doc {
  profiles: ProfileData[]
  connectors: ConnectorData[]
  panels: PanelData[]
  fittings: FittingData[]
  throughRule?: 'rails' | 'posts'
}

let entries: LogEntry[] = []
let pendingLabel: string | null = null
let listeners: Array<() => void> = []

function load(): void {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    entries = Array.isArray(parsed) ? parsed.filter((entry): entry is LogEntry => {
      if (!entry || typeof entry !== 'object') return false
      const { at, label, detail, ids } = entry
      return typeof at === 'number' && Number.isFinite(at) && Math.abs(at) <= 8.64e15
        && typeof label === 'string' && typeof detail === 'string'
        && Array.isArray(ids) && ids.every((id) => typeof id === 'string')
    }).slice(-MAX_ENTRIES) : []
  } catch { entries = [] }
}
load()

function save(): void {
  try { localStorage.setItem(KEY, JSON.stringify(entries)) } catch { /* private window: keep it in memory */ }
}

/** Name the next change, if the gesture has a name worth recording */
export function noteNext(label: string): void { pendingLabel = label }
/** A rejected command must not label the next unrelated successful edit. */
export function cancelNextNote(): void { pendingLabel = null }

export function opLog(): LogEntry[] { return entries }

export function clearOpLog(): void { entries = []; save(); listeners.forEach((f) => f()) }

export function subscribeOpLog(fn: () => void): () => void {
  listeners.push(fn)
  return () => { listeners = listeners.filter((f) => f !== fn) }
}

/** The log as plain text, newest last, for pasting somewhere */
export function opLogText(): string {
  return entries.map((e) => {
    const t = new Date(e.at).toISOString().replace('T', ' ').slice(0, 19)
    return `${t}  ${e.label}${e.detail ? ` — ${e.detail}` : ''}`
  }).join('\n')
}

type Part = ProfileData | ConnectorData | PanelData | FittingData

const round3 = (v: number) => Math.round(v * 1000) / 1000
const v3 = (a: number[]) => `[${a.map(round3).join(', ')}]`
const delta = (a: number[], b: number[]) => a.map((v, i) => round3(b[i] - v))
const moved = (a: number[], b: number[]) => a.some((v, i) => v !== b[i])

function equalValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b)
    && a.length === b.length && a.every((value, i) => equalValue(value, b[i]))
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && equalValue(left[key], right[key]))
}

const valueText = (value: unknown) => value === undefined ? 'unset'
  : typeof value === 'number' ? String(round3(value))
  : typeof value === 'string' ? value : JSON.stringify(value)

function kindOf(doc: Doc, id: string): string {
  if (doc.profiles.some((p) => p.id === id)) return 'member'
  if (doc.connectors.some((c) => c.id === id)) return 'connector'
  if (doc.panels.some((p) => p.id === id)) return 'board'
  return 'fitting'
}

/** Describe design changes; unchanged documents and opening-only changes return null. */
export function describeChange(before: Doc, after: Doc): { label: string; detail: string; ids: string[] } | null {
  const all = (d: Doc): Part[] => [...d.profiles, ...d.connectors, ...d.panels, ...d.fittings]
  const b = new Map(all(before).map((p) => [p.id, p]))
  const a = new Map(all(after).map((p) => [p.id, p]))

  const added = [...a.keys()].filter((id) => !b.has(id))
  const removed = [...b.keys()].filter((id) => !a.has(id))
  const ruleChanged = (before.throughRule ?? 'rails') !== (after.throughRule ?? 'rails')
  let previousCuts: ReturnType<typeof computeAllTrims> | undefined
  // changed in place
  const changes: Array<{ id: string; what: string }> = []
  for (const [id, prev] of b) {
    const next = a.get(id)
    if (!next || prev === next) continue
    const bits: string[] = []
    if (moved(prev.position, next.position)) bits.push(`moved ${v3(delta(prev.position!, next.position!))}`)
    if (moved(prev.quaternion, next.quaternion)) bits.push('turned')
    const pl = (prev as ProfileData).length, nl = (next as ProfileData).length
    if (pl !== undefined && nl !== undefined && pl !== nl) bits.push(`length ${valueText(pl)} → ${valueText(nl)}`)
    const ps = (prev as ProfileData).spec, ns = (next as ProfileData).spec
    if (ps && ns && ps !== ns) bits.push(`${ps} → ${ns}`)
    if ((prev as ProfileData).locked !== (next as ProfileData).locked) bits.push((next as ProfileData).locked ? 'locked' : 'unlocked')
    // `open` is a view state. Every other design field, including nested cut/stack data,
    // belongs in the record even when an opening gesture happened at the same time.
    const special = new Set(['id', 'position', 'quaternion', 'length', 'spec', 'locked', 'open'])
    const oldFields = prev as unknown as Record<string, unknown>
    const newFields = next as unknown as Record<string, unknown>
    for (const key of new Set([...Object.keys(oldFields), ...Object.keys(newFields)])) {
      if (special.has(key) || equalValue(oldFields[key], newFields[key])) continue
      // Ignore a first freeze only when it stores the previous visible shape. A short
      // resize can change just these offsets while leaving the model span untouched.
      if (key === 'fixedTrims' && oldFields[key] === undefined) {
        if (ruleChanged) continue // the rule change is recorded separately
        previousCuts ??= computeAllTrims(before.profiles)
        const cuts = previousCuts.get(id)
        if (cuts && equalValue(newFields[key], {
          start: cuts.start.trim, end: round3(pl - cuts.start.trim - cuts.cutLength),
        })) continue
      }
      if (key === 'fixedTrims' && newFields[key] === undefined && ruleChanged) continue
      bits.push(`${key} ${valueText(oldFields[key])} → ${valueText(newFields[key])}`)
    }
    if (bits.length) changes.push({ id, what: bits.join(', ') })
  }
  if (changes.length === 0 && added.length === 0 && removed.length === 0 && !ruleChanged) return null

  const details: string[] = []
  const summarise = (ids: string[], doc: Doc, prefix: string) => {
    const counts = new Map<string, number>()
    for (const id of ids) { const kind = kindOf(doc, id); counts.set(kind, (counts.get(kind) ?? 0) + 1) }
    for (const [kind, count] of counts) details.push(`${prefix}${count} ${kind}${count > 1 ? 's' : ''}`)
  }
  summarise(added, after, '+')
  summarise(removed, before, '−')
  const same = changes.length > 0 && changes.every((c) => c.what === changes[0].what
    && kindOf(after, c.id) === kindOf(after, changes[0].id))
  if (same && changes.length > 1) details.push(`${changes.length} ${kindOf(after, changes[0].id)}s ${changes[0].what}`)
  else for (const change of changes) details.push(`${kindOf(after, change.id)} ${change.what}`)
  if (ruleChanged) details.push(`throughRule ${before.throughRule ?? 'rails'} → ${after.throughRule ?? 'rails'}`)
  return {
    label: added.length || removed.length ? (added.length && !removed.length ? 'add' : removed.length && !added.length ? 'delete' : 'replace')
      : !changes.length ? 'edit'
      : changes[0].what.startsWith('moved') ? 'move'
      : changes[0].what === 'turned' ? 'turn'
      : changes[0].what.startsWith('length') ? 'resize' : 'edit',
    detail: details.join('; '),
    ids: [...added, ...removed, ...changes.map((c) => c.id)],
  }
}

/** Record a change, if there was one worth recording */
export function record(before: Doc, after: Doc): void {
  const change = describeChange(before, after)
  const label = pendingLabel
  pendingLabel = null
  if (!change) return
  entries.push({ at: Date.now(), label: label ?? change.label, detail: change.detail, ids: change.ids })
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES)
  save()
  listeners.forEach((f) => f())
}
