import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { suggestNext, focusOf, type Candidate } from './suggest'
import { vet } from './suggestGate'
import { computeTrims } from './jointUtils'
import { noteNext } from './opLog'
import { translations } from './translations'

/**
 * Suggest, accept, skip, drop — the four things the 建议 button and its ghost do.
 *
 * A suggestion is only ever an offer: nothing is in the drawing until the ghost is clicked,
 * and then it goes in as one step that one Ctrl+Z takes out again.
 */

let accepting = false

const docOf = () => {
  const s = useStore.getState()
  return { profiles: s.profiles, connectors: s.connectors, panels: s.panels, fittings: s.fittings }
}

/**
 * Show the next suggestion. With one already showing, that one is set aside and the next
 * comes up; when there is nothing left the run starts over.
 */
export function nextSuggestion(): Candidate | null {
  const ts = useToolStore.getState()
  const t = translations[ts.language]
  const cur = ts.suggestion
  const skipped = new Set(cur ? ts.suggestSkipped : [])
  if (cur) skipped.add(cur.cand.key)
  const doc = docOf()
  const found = suggestNext(doc, focusOf(doc.profiles, useStore.getState().selectedIds), skipped).next()
  if (found.done || skipped.has(found.value.key)) {
    ts.setSuggestion(null, new Set())
    ts.showToast(t.toastNoMoreSuggestions, 'info')
    return null
  }
  ts.setSuggestion({ cand: found.value, index: (cur?.index ?? 0) + 1, docRef: doc.profiles }, skipped)
  return found.value
}

/** Put the suggested member in the drawing, then offer the one after it */
export function acceptSuggestion(): boolean {
  const ts = useToolStore.getState()
  const t = translations[ts.language]
  const s = ts.suggestion
  if (!s) return false
  const doc = docOf()
  // the drawing moved on since this was checked: check it again against what is there now
  if (s.docRef !== doc.profiles && !vet(s.cand.member, s.cand.claim, doc).ok) {
    dismissSuggestion()
    return false
  }
  const member = s.cand.member
  const cut = computeTrims(member, [...doc.profiles, member]).cutLength
  accepting = true
  try {
    noteNext(`suggest: ${s.cand.rule}`)
    useStore.getState().addItems([member], [], true)
  } finally {
    accepting = false
  }
  ts.setSuggestion(null, new Set())
  ts.showToast(t.toastSuggestAdded(member.spec, Math.round(cut)), 'success')
  nextSuggestion()
  return true
}

export function dismissSuggestion(): void {
  const ts = useToolStore.getState()
  if (ts.suggestion || ts.suggestSkipped.size) ts.setSuggestion(null, new Set())
}

// A suggestion describes the drawing it was made for. Any other change — an undo, a load, a
// member drawn or moved — makes it a suggestion for a drawing that is no longer there.
useStore.subscribe((st, prev) => {
  if (accepting || !useToolStore.getState().suggestion) return
  if (st.profiles !== prev.profiles || st.connectors !== prev.connectors || st.panels !== prev.panels || st.fittings !== prev.fittings) {
    dismissSuggestion()
  }
})
// and picking something up, going to look, or measuring is doing something else
useToolStore.subscribe((st, prev) => {
  if (!st.suggestion) return
  if ((st.held !== null && st.held !== prev.held) || (st.viewMode && !prev.viewMode) || (st.measuring && !prev.measuring)) {
    dismissSuggestion()
  }
})
