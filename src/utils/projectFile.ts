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
 * Fall back to a download only when the API is unavailable.
 */

interface FileHandleLike {
  name: string
  createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void>; abort?: () => Promise<void> }>
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
let openedName: string | null = null
let targetGeneration = 0

export const canOverwriteProject = () => handle !== null

export function rememberOpenedFile(name: string): void {
  targetGeneration++
  handle = null
  openedName = name
}

export function savedFileName(): string | null {
  return openedName
}

export function forgetSavedFile(): void {
  targetGeneration++
  handle = null
  openedName = null
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
  try {
    await w.write(text)
    await w.close()
  } catch (error) {
    // Release the temporary write and file lock without committing partial data.
    try { await w.abort?.() } catch { /* The stream may already be closed. */ }
    throw error
  }
}

export type SaveOutcome = 'saved' | 'overwritten' | 'downloaded' | 'cancelled' | 'failed'

/** asNew opens the save picker; otherwise reuse the selected handle. */
export async function saveProject(text: string, suggested: string, asNew = false): Promise<{ outcome: SaveOutcome; name?: string }> {
  const w = window as PickerWindow
  const generation = targetGeneration
  if (!canPickFiles()) {
    try {
      downloadText(suggested, text, 'application/json')
      return { outcome: 'downloaded', name: suggested }
    } catch { return { outcome: 'failed' } }
  }
  if (!handle || asNew) {
    let chosen: FileHandleLike
    try {
      chosen = await w.showSaveFilePicker!({
        suggestedName: suggested,
        types: [{ description: 'Aluminium frame project', accept: { 'application/json': ['.json'] } }],
      })
    } catch (e) {
      return { outcome: (e as DOMException)?.name === 'AbortError' ? 'cancelled' : 'failed' }
    }
    try {
      if (targetGeneration !== generation) return { outcome: 'cancelled' }
      await writable(chosen, text)
      if (targetGeneration !== generation) return { outcome: 'cancelled' }
      handle = chosen
      openedName = chosen.name
      return { outcome: 'saved', name: chosen.name }
    } catch {
      return { outcome: 'failed' }
    }
  }
  const target = handle
  try {
    await writable(target, text)
    return { outcome: 'overwritten', name: target.name }
  } catch {
    return { outcome: 'failed' }
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
    return { outcome: 'opened', text: await file.text(), name: chosen.name, accept: () => { targetGeneration++; handle = chosen; openedName = chosen.name } }
  } catch {
    // A failed read, including AbortError, is not a dismissed picker.
    return { outcome: 'failed' }
  }
}
