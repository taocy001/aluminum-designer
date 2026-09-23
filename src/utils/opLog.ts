import type { ConnectorData, FittingData, PanelData, ProfileData } from '../store/useStore'

/**
 * What actually happened, in order.
 *
 * Undo is not a record. It keeps the last fifty states in memory and loses them on reload,
 * so "why would this rail not move" has no answer the next morning. This does: every change
 * to the document, what it was and what it became, kept across reloads.
 *
 * It works by comparing the document before and after rather than by each operation
 * announcing itself. An announcement is a claim about what the code meant to do; a
 * comparison is a record of what it did. When a caller does have a name for the gesture it
 * can offer one through `noteNext`, and that name is used as the heading — but the detail
 * underneath is always measured.
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
}

let entries: LogEntry[] = []
let pendingLabel: string | null = null
let listeners: Array<() => void> = []

function load(): void {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) entries = JSON.parse(raw) as LogEntry[]
  } catch { entries = [] }
}
load()

function save(): void {
  try { localStorage.setItem(KEY, JSON.stringify(entries)) } catch { /* private window: keep it in memory */ }
}

/** Name the next change, if the gesture has a name worth recording */
export function noteNext(label: string): void { pendingLabel = label }

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

type Part = { id: string; position?: [number, number, number]; quaternion?: [number, number, number, number] }

const v3 = (a: number[]) => `[${a.map((n) => Math.round(n * 10) / 10).join(', ')}]`
const delta = (a: number[], b: number[]) => a.map((v, i) => Math.round((b[i] - v) * 10) / 10)
const moved = (a?: number[], b?: number[]) => a && b && a.some((v, i) => Math.abs(v - b[i]) > 0.05)

function kindOf(doc: Doc, id: string): string {
  if (doc.profiles.some((p) => p.id === id)) return 'member'
  if (doc.connectors.some((c) => c.id === id)) return 'connector'
  if (doc.panels.some((p) => p.id === id)) return 'board'
  return 'fitting'
}

/**
 * What changed between two documents.
 *
 * Returns null when nothing did, and also when the only difference is how far a drawer is
 * open — that is a way of looking, and a log of it would bury the log of the work.
 */
export function describeChange(before: Doc, after: Doc): { label: string; detail: string; ids: string[] } | null {
  const all = (d: Doc): Part[] => [...d.profiles, ...d.connectors, ...d.panels, ...d.fittings]
  const b = new Map(all(before).map((p) => [p.id, p]))
  const a = new Map(all(after).map((p) => [p.id, p]))

  const added = [...a.keys()].filter((id) => !b.has(id))
  const removed = [...b.keys()].filter((id) => !a.has(id))
  if (added.length || removed.length) {
    const parts: string[] = []
    if (added.length) parts.push(`+${added.length} ${kindOf(after, added[0])}${added.length > 1 ? 's' : ''}`)
    if (removed.length) parts.push(`−${removed.length} ${kindOf(before, removed[0])}${removed.length > 1 ? 's' : ''}`)
    return { label: added.length && !removed.length ? 'add' : removed.length && !added.length ? 'delete' : 'replace',
      detail: parts.join(', '), ids: [...added, ...removed] }
  }

  // changed in place
  const changes: Array<{ id: string; what: string }> = []
  for (const [id, prev] of b) {
    const next = a.get(id)!
    if (prev === next) continue
    const bits: string[] = []
    if (moved(prev.position, next.position)) bits.push(`moved ${v3(delta(prev.position!, next.position!))}`)
    if (moved(prev.quaternion as number[] | undefined, next.quaternion as number[] | undefined)) bits.push('turned')
    const pl = (prev as ProfileData).length, nl = (next as ProfileData).length
    if (pl !== undefined && nl !== undefined && Math.abs(pl - nl) > 0.05) bits.push(`length ${Math.round(pl)} → ${Math.round(nl)}`)
    const ps = (prev as ProfileData).spec, ns = (next as ProfileData).spec
    if (ps && ns && ps !== ns) bits.push(`${ps} → ${ns}`)
    const po = (prev as FittingData).open, no = (next as FittingData).open
    const onlyOpen = po !== no && bits.length === 0
    if (onlyOpen) continue                      // looking, not building
    if ((prev as ProfileData).locked !== (next as ProfileData).locked) bits.push((next as ProfileData).locked ? 'locked' : 'unlocked')
    if (bits.length) changes.push({ id, what: bits.join(', ') })
  }
  if (changes.length === 0) return null

  const same = changes.every((c) => c.what === changes[0].what)
  return {
    label: changes[0].what.startsWith('moved') ? 'move'
      : changes[0].what === 'turned' ? 'turn'
      : changes[0].what.startsWith('length') ? 'resize' : 'edit',
    detail: same && changes.length > 1
      ? `${changes.length} ${kindOf(after, changes[0].id)}s ${changes[0].what}`
      : changes.slice(0, 3).map((c) => `${kindOf(after, c.id)} ${c.what}`).join('; ')
        + (changes.length > 3 ? ` (+${changes.length - 3})` : ''),
    ids: changes.map((c) => c.id),
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
