import { parseProjectDocument, PROJECT_VERSION, type ProjectDocument } from './document'

export interface ProjectDraft {
  id: string
  name: string | null
  updatedAt: number
  document: ProjectDocument
  baseline: string | null
}
interface SessionState {
  id: string
  name: string | null
  current: string
  baseline: string | null
  dirty: boolean
  storageError: boolean
  replacement: (() => void) | null
}
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>
const PREFIX = 'aluframe:draft:'
const ACTIVE = 'aluframe:active-document'
const fingerprint = (doc: ProjectDocument) => JSON.stringify({ version: PROJECT_VERSION,
  profiles: doc.profiles, connectors: doc.connectors, panels: doc.panels, fittings: doc.fittings,
  equipment: doc.equipment ?? [], templateInstances: doc.templateInstances ?? [], groups: doc.groups ?? [], throughRule: doc.throughRule })
const empty = (doc: ProjectDocument) => ![doc.profiles, doc.connectors, doc.panels, doc.fittings, doc.equipment ?? []].some(parts => parts.length)
let sequence = 0
const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${++sequence}`

/** Each document has its own recoverable draft; file handles never enter browser storage. */
export function createProjectSession(storage: () => DraftStorage | null) {
  let state: SessionState = { id: newId(), name: null, current: '', baseline: null, dirty: false, storageError: false, replacement: null }
  let timer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  const publish = (update: Partial<SessionState>) => {
    state = { ...state, ...update }
    listeners.forEach(listener => listener())
  }
  const readDraft = (raw: string | null): ProjectDraft | null => {
    if (!raw) return null
    try {
      const value = JSON.parse(raw)
      if (typeof value.id !== 'string' || !(value.name === null || typeof value.name === 'string') || !Number.isFinite(value.updatedAt)
        || !(value.baseline === null || typeof value.baseline === 'string')) return null
      return { ...value, document: parseProjectDocument(value.document) }
    } catch { return null }
  }
  const keepDraft = () => {
    clearTimeout(timer)
    if (!state.current) return true
    try {
      const target = storage()
      if (!target) throw new Error('storage unavailable')
      const draft: ProjectDraft = { id: state.id, name: state.name, updatedAt: Date.now(),
        document: JSON.parse(state.current), baseline: state.baseline }
      // Write the document first so a failure cannot point the active id at a missing draft.
      target.setItem(PREFIX + draft.id, JSON.stringify(draft))
      target.setItem(ACTIVE, draft.id)
      if (state.storageError) publish({ storageError: false })
      return true
    } catch {
      if (!state.storageError) publish({ storageError: true })
      return false
    }
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(keepDraft, 250) }
  return {
    getState: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    initialize(doc: ProjectDocument, name: string | null) {
      let restored: ProjectDraft | null = null
      try {
        const target = storage(), id = target?.getItem(ACTIVE)
        restored = id ? readDraft(target?.getItem(PREFIX + id) ?? null) : null
      } catch { /* The editor still opens when browser storage is blocked. */ }
      const current = fingerprint(doc)
      const matchingDraft = restored && fingerprint(restored.document) === current ? restored : null
      const baseline = matchingDraft ? matchingDraft.baseline : empty(doc) ? current : null
      publish({ id: matchingDraft?.id ?? newId(), name, current, baseline, dirty: current !== baseline })
    },
    start(doc: ProjectDocument, options: { name?: string | null; saved?: boolean; draft?: ProjectDraft } = {}) {
      clearTimeout(timer)
      const current = fingerprint(doc)
      const baseline = options.draft ? options.draft.baseline : options.saved || empty(doc) ? current : null
      publish({ id: options.draft?.id ?? newId(), name: options.name ?? options.draft?.name ?? null,
        current, baseline, dirty: current !== baseline, replacement: null, storageError: false })
      schedule()
    },
    update(doc: ProjectDocument, name: string | null) {
      const current = fingerprint(doc)
      if (current === state.current && name === state.name) return
      publish({ current, name, dirty: current !== state.baseline })
      schedule()
    },
    markSaved(doc: ProjectDocument, sessionId: string) {
      if (sessionId !== state.id) return false
      const baseline = fingerprint(doc)
      publish({ baseline, dirty: state.current !== baseline })
      keepDraft()
      return true
    },
    keepDraft,
    listDrafts(): ProjectDraft[] {
      try {
        const target = storage()
        if (!target) throw new Error('storage unavailable')
        const drafts: ProjectDraft[] = []
        for (let i = 0; i < target.length; i++) {
          const key = target.key(i)
          if (!key?.startsWith(PREFIX)) continue
          const draft = readDraft(target.getItem(key))
          if (draft && draft.id !== state.id) drafts.push(draft)
        }
        return drafts.sort((a, b) => b.updatedAt - a.updatedAt)
      } catch { publish({ storageError: true }); return [] }
    },
    removeDraft(id: string) {
      if (id === state.id) return false
      try { storage()?.removeItem(PREFIX + id); return true }
      catch { publish({ storageError: true }); return false }
    },
    requestReplacement(action: () => void) {
      if (state.dirty) publish({ replacement: action })
      else action()
    },
    cancelReplacement() { publish({ replacement: null }) },
    finishReplacement() {
      const action = state.replacement
      if (!action) return
      action()
      if (state.replacement === action) publish({ replacement: null })
    },
  }
}

export const projectSession = createProjectSession(() => typeof localStorage === 'undefined' ? null : localStorage)
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => projectSession.keepDraft())
  window.addEventListener('beforeunload', (event) => {
    projectSession.keepDraft()
    if (projectSession.getState().dirty) { event.preventDefault(); event.returnValue = '' }
  })
}
