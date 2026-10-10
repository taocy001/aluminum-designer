import { buildStepBytes, type StepInput } from '../utils/step'

// The worker owns geometry construction and text encoding; only the byte buffer crosses back.
const scope = self as unknown as {
  onmessage: (event: MessageEvent<StepInput>) => void
  postMessage: (message: unknown, transfer?: Transferable[]) => void
}
scope.onmessage = ({ data }) => {
  try {
    const buffer = buildStepBytes(data)
    scope.postMessage({ buffer }, [buffer])
  } catch {
    scope.postMessage({ error: true })
  }
}
