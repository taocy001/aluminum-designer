/** the old way, kept for the browsers that have no save dialog */
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
 * Saving to a place you chose, and saving over it again.
 *
 * The browser's download is not a save: it drops a numbered copy in Downloads and you can
 * never write over it, so after a few edits there are five files and nobody knows which one
 * is the drawing. The File System Access API gives a real save dialog and a handle that can
 * be written to again, so "save" after the first time overwrites in place.
 *
 * Where the API is missing — Firefox, Safari, and any page not on a secure origin — it falls
 * back to the download, because a save that fails is worse than one that is clumsy.
 */

interface FileHandleLike {
  name: string
  createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }>
  queryPermission?: (d: { mode: string }) => Promise<string>
  requestPermission?: (d: { mode: string }) => Promise<string>
}

type PickerWindow = Window & {
  showSaveFilePicker?: (opts: unknown) => Promise<FileHandleLike>
  showOpenFilePicker?: (opts: unknown) => Promise<FileHandleLike[]>
}

/** the file this drawing was last saved to, so "save" can mean "save over that one" */
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

/**
 * Save the drawing.
 *
 * `asNew` forces the dialog; otherwise the second save goes straight over the file the
 * first one chose, which is what a save is for.
 */
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
    // the dialog was dismissed: that is an answer, not a failure
    if ((e as DOMException)?.name === 'AbortError') return { outcome: 'cancelled' }
    handle = null
    downloadText(suggested, text, 'application/json')
    return { outcome: 'downloaded', name: suggested }
  }
}

/** Open a drawing through the same dialog, remembering it so a later save writes back to it */
export async function openProject(): Promise<{ text: string; name: string } | null> {
  const w = window as PickerWindow
  if (!w.showOpenFilePicker) return null
  try {
    const [h] = await w.showOpenFilePicker({
      types: [{ description: 'Aluminium frame project', accept: { 'application/json': ['.json'] } }],
      multiple: false,
    })
    const file = await (h as unknown as { getFile: () => Promise<File> }).getFile()
    handle = h
    return { text: await file.text(), name: h.name }
  } catch {
    return null
  }
}
