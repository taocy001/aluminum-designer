import type { StepInput } from './step'

export interface StepExportTask {
  result: Promise<ArrayBuffer>
  cancel: () => void
}

/** postMessage captures the document before subsequent edits can change it. */
export function startStepExport(input: StepInput): StepExportTask {
  const worker = new Worker(new URL('../workers/step.worker.ts', import.meta.url), { type: 'module' })
  let settled = false
  let cancel = () => {}
  const result = new Promise<ArrayBuffer>((resolve, reject) => {
    const finish = (buffer?: ArrayBuffer, error?: Error) => {
      if (settled) return
      settled = true
      worker.terminate()
      worker.onmessage = worker.onerror = worker.onmessageerror = null
      if (error) reject(error)
      else resolve(buffer!)
    }
    cancel = () => finish(undefined, new DOMException('Export cancelled', 'AbortError'))
    worker.onmessage = ({ data }) => {
      if (data?.buffer instanceof ArrayBuffer) finish(data.buffer)
      else finish(undefined, new Error('STEP export failed'))
    }
    worker.onerror = (event) => {
      event.preventDefault()
      finish(undefined, new Error('STEP worker failed'))
    }
    worker.onmessageerror = () => finish(undefined, new Error('STEP result could not be read'))
    try { worker.postMessage(input) }
    catch (error) { finish(undefined, error instanceof Error ? error : new Error('STEP export failed')) }
  })
  return { result, cancel: () => cancel() }
}
