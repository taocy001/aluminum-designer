/** Download a text file when direct file access is unavailable. */
export function downloadText(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * Save through the File System Access API and reuse the selected file handle.
 * Fall back to a download when the API is unavailable or cannot write the file.
 */

interface FileHandleLike {
  name: string
  createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }>
  queryPermission?: (d: { mode: string }) => Promise<string>
  requestPermission?: (d: { mode: string }) => Promise<string>
}

interface ReadableFileHandleLike extends FileHandleLike {
  getFile: () => Promise<File>
}

type PickerWindow = Window & {
  showSaveFilePicker?: (opts: unknown) => Promise<FileHandleLike>
  showOpenFilePicker?: (opts: unknown) => Promise<ReadableFileHandleLike[]>
}

/** Accepted target for subsequent saves. */
let handle: FileHandleLike | null = null

export function savedFileName(): string | null {
  return handle?.name ?? null
}

export function forgetSavedFile(): void {
  handle = null
}

export function canPickFiles(): boolean {
  return typeof (window as PickerWindow).showSaveFilePicker === 'function'
}

async function writable(h: FileHandleLike, text: string): Promise<void> {
  if (h.queryPermission) {
    let state = await h.queryPermission({ mode: 'readwrite' })
    if (state !== 'granted' && h.requestPermission) state = await h.requestPermission({ mode: 'readwrite' })
    if (state !== 'granted') throw new Error('permission')
  }
  const w = await h.createWritable()
  await w.write(text)
  await w.close()
}

export type SaveOutcome = 'saved' | 'overwritten' | 'downloaded' | 'cancelled'

/** asNew opens the save picker; otherwise reuse the selected handle. */
export async function saveProject(text: string, suggested: string, asNew = false): Promise<{ outcome: SaveOutcome; name?: string }> {
  const w = window as PickerWindow
  if (!w.showSaveFilePicker) {
    downloadText(suggested, text, 'application/json')
    return { outcome: 'downloaded', name: suggested }
  }
  try {
    if (!handle || asNew) {
      handle = await w.showSaveFilePicker({
        suggestedName: suggested,
        types: [{ description: 'Aluminium frame project', accept: { 'application/json': ['.json'] } }],
      })
      await writable(handle!, text)
      return { outcome: 'saved', name: handle!.name }
    }
    await writable(handle, text)
    return { outcome: 'overwritten', name: handle.name }
  } catch (e) {
    // Treat a dismissed picker as cancellation.
    if ((e as DOMException)?.name === 'AbortError') return { outcome: 'cancelled' }
    handle = null
    downloadText(suggested, text, 'application/json')
    return { outcome: 'downloaded', name: suggested }
  }
}

export type OpenProjectResult =
  | { outcome: 'opened'; text: string; name: string; accept: () => void }
  | { outcome: 'cancelled' }
  | { outcome: 'unsupported' }
  | { outcome: 'failed' }

/** Read a chosen file; adopt its save target only after the caller validates the project. */
export async function openProject(): Promise<OpenProjectResult> {
  const w = window as PickerWindow
  if (typeof w.showOpenFilePicker !== 'function') return { outcome: 'unsupported' }
  let h: ReadableFileHandleLike | undefined
  try {
    h = (await w.showOpenFilePicker({
      types: [{ description: 'Aluminium frame project', accept: { 'application/json': ['.json'] } }],
      multiple: false,
    }))[0]
  } catch (e) {
    return { outcome: (e as DOMException)?.name === 'AbortError' ? 'cancelled' : 'failed' }
  }
  if (!h) return { outcome: 'failed' }
  const chosen = h
  try {
    const file = await chosen.getFile()
    return { outcome: 'opened', text: await file.text(), name: chosen.name, accept: () => { handle = chosen } }
  } catch {
    // A failed read, including AbortError, is not a dismissed picker.
    return { outcome: 'failed' }
  }
}
