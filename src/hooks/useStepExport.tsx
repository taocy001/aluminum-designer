import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useToolStore } from '../store/useToolStore'
import { downloadBlob } from '../utils/projectFile'
import { startStepExport, type StepExportTask } from '../utils/stepExport'
import type { StepInput } from '../utils/step'
import { translations } from '../utils/translations'

export function useStepExport() {
  const active = useRef<StepExportTask | null>(null)
  const busy = useToolStore(s => s.stepExporting)
  const setBusy = (stepExporting: boolean) => useToolStore.setState({ stepExporting })
  const language = useToolStore(s => s.language)
  const t = translations[language]
  useEffect(() => () => {
    active.current?.cancel()
    active.current = null
    setBusy(false)
  }, [])

  const cancel = () => {
    active.current?.cancel()
    active.current = null
    setBusy(false)
  }
  const start = async (input: StepInput, reviewCount: number) => {
    if (active.current) return
    let task: StepExportTask | undefined
    try {
      const filename = `aluframe-${new Date().toISOString().slice(0, 10)}.step`
      task = startStepExport(input)
      active.current = task
      setBusy(true)
      const buffer = await task.result
      if (active.current !== task) return
      downloadBlob(filename, new Blob([buffer], { type: 'application/step' }))
      const tool = useToolStore.getState()
      const labels = translations[tool.language]
      tool.showToast(reviewCount ? labels.toastExportReview(reviewCount) : labels.stepExportReady, reviewCount ? 'info' : 'success')
    } catch (error) {
      if (task && active.current !== task) return
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        const tool = useToolStore.getState()
        tool.showToast(translations[tool.language].stepExportFailed, 'error')
      }
    } finally {
      if (active.current === task) {
        active.current = null
        setBusy(false)
      }
    }
  }
  const status = busy ? createPortal(
    <div data-testid="step-export-status" className="fixed bottom-14 left-1/2 -translate-x-1/2 z-[80] flex items-center gap-3 rounded-lg border border-slate-600 bg-slate-900 px-4 py-3 text-xs text-slate-200 shadow-lg max-w-[calc(100vw-2rem)]">
      <span role="status">{t.stepExportRunning}</span>
      <button data-testid="step-export-cancel" onClick={cancel} className="shrink-0 rounded px-2 py-1 text-blue-300 hover:bg-white/10">{t.stepExportCancel}</button>
    </div>, document.body) : null
  return { start, busy, status }
}
