import { useSyncExternalStore } from 'react'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { documentStorage } from '../utils/documentPersistence'
import { serializeProjectDocument } from '../utils/document'
import { downloadText } from '../utils/projectFile'

/** Current saving health, separate from recovery of an unreadable older document. */
export default function AutoSaveStatus() {
  const status = useSyncExternalStore(documentStorage.subscribe, documentStorage.getStatus)
  const zh = useToolStore((s) => s.language) === 'zh'
  const failed = status === 'error' || status === 'unavailable'
  const details = status === 'saved'
    ? (zh ? '最新更改已保存到此浏览器。' : 'The latest changes are saved in this browser.')
    : status === 'pending'
      ? (zh ? '最新更改正在等待自动保存。' : 'The latest changes are waiting to be saved.')
      : (zh ? '编辑后将自动保存到此浏览器。' : 'Changes will be saved automatically in this browser.')
  if (!failed) {
    // A steady label avoids flashing a saving message during every short edit. The exact
    // state remains available to assistive technology and through the tooltip.
    return <div data-testid="autosave-status" data-state={status} role="status" aria-live="off"
      aria-label={details} title={details}
      className="shrink-0 bg-slate-900 px-4 py-1 text-[10px] text-slate-400">
      {zh ? '自动保存到此浏览器' : 'Auto-save in this browser'}
    </div>
  }
  const retry = () => {
    const { name, version = 0, partialize } = useStore.persist.getOptions()
    // Include the current drawing even when storage was unavailable on the first load
    // and there has not yet been a document edit to queue a save.
    documentStorage.setItem(name!, { state: partialize!(useStore.getState()), version })
    documentStorage.flush()
  }
  return <div data-testid="autosave-status" data-state={status} role="alert"
    className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1 bg-amber-950 px-4 py-2 text-xs text-amber-100">
    <span>{status === 'unavailable'
      ? (zh ? '此浏览器的本地存储不可用，当前工程尚未自动保存。请在关闭或刷新前下载工程。'
        : 'Local storage is unavailable. This project has not been auto-saved. Download it before closing or reloading.')
      : (zh ? '自动保存失败，最新更改尚未保存到此浏览器。请重试，或在关闭或刷新前下载当前工程。'
        : 'Auto-save failed. The latest changes are not saved in this browser. Retry, or download the current project before closing or reloading.')}</span>
    <button data-testid="autosave-retry" className="underline p-2" onClick={retry}>
      {zh ? '重试保存' : 'Retry saving'}
    </button>
    <button data-testid="autosave-download" className="underline p-2" onClick={() => {
      downloadText(`aluframe-current-${new Date().toISOString().slice(0, 10)}.json`,
        serializeProjectDocument(useStore.getState()), 'application/json')
    }}>
      {zh ? '下载当前工程' : 'Download current project'}
    </button>
  </div>
}
