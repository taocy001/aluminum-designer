import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startStepExport } from '../utils/stepExport'

class TestWorker {
  static latest: TestWorker
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: { preventDefault: () => void }) => void) | null = null
  onmessageerror: (() => void) | null = null
  terminate = vi.fn()
  postMessage = vi.fn()
  constructor() { TestWorker.latest = this }
}
beforeEach(() => vi.stubGlobal('Worker', TestWorker))
afterEach(() => vi.unstubAllGlobals())

it('returns bytes and releases the worker after success', async () => {
  const task = startStepExport({ profiles: [] })
  const worker = TestWorker.latest
  const buffer = new ArrayBuffer(16)
  worker.onmessage!({ data: { buffer } })
  expect(await task.result).toBe(buffer)
  task.cancel()
  expect(worker.terminate).toHaveBeenCalledTimes(1)
  expect(worker.onmessage).toBeNull()
})

it('cancellation terminates computation and ignores a late result', async () => {
  const task = startStepExport({ profiles: [] })
  const worker = TestWorker.latest
  const late = worker.onmessage!
  const rejected = expect(task.result).rejects.toMatchObject({ name: 'AbortError' })
  task.cancel()
  late({ data: { buffer: new ArrayBuffer(1) } })
  await rejected
  expect(worker.terminate).toHaveBeenCalledTimes(1)
})

it.each(['build', 'load', 'message'])('releases the worker after %s failure', async kind => {
  const task = startStepExport({ profiles: [] })
  const worker = TestWorker.latest
  const rejected = expect(task.result).rejects.toThrow()
  if (kind === 'build') worker.onmessage!({ data: { error: true } })
  if (kind === 'load') worker.onerror!({ preventDefault: vi.fn() })
  if (kind === 'message') worker.onmessageerror!()
  await rejected
  expect(worker.terminate).toHaveBeenCalledTimes(1)
  expect(worker.onerror).toBeNull()
})

it('releases the worker when input cannot be cloned', async () => {
  class BrokenWorker extends TestWorker {
    postMessage = vi.fn(() => { throw new DOMException('Invalid input', 'DataCloneError') })
  }
  vi.stubGlobal('Worker', BrokenWorker)
  await expect(startStepExport({ profiles: [] }).result).rejects.toMatchObject({ name: 'DataCloneError' })
  expect(TestWorker.latest.terminate).toHaveBeenCalledTimes(1)
})
