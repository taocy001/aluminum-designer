import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { serializeProjectDocument } from '../utils/document'
import { canOverwriteProject, canPickFiles, saveProject } from '../utils/projectFile'

export function requestProjectSave() {
  window.dispatchEvent(new Event('project-save-request'))
}

/** File identity and explicit disk saving, independent of the collapsed sidebar. */
export default function ProjectFileBar() {
  const name = useStore(s => s.projectName)
  const zh = useToolStore(s => s.language) === 'zh'
  const [open, setOpen] = useState(false)
  const [filename, setFilename] = useState('')
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const request = () => {
      setFilename(useStore.getState().projectName ?? `aluframe-${new Date().toISOString().slice(0, 10)}.json`)
      setError(false)
      setOpen(true)
    }
    const keydown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        request()
      }
    }
    window.addEventListener('project-save-request', request)
    window.addEventListener('keydown', keydown)
    return () => {
      window.removeEventListener('project-save-request', request)
      window.removeEventListener('keydown', keydown)
    }
  }, [])
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal()
    if (!open) dialog.current?.close()
  }, [open])
  const native = canPickFiles()
  const overwrite = canOverwriteProject()
  const validName = filename.trim().length > 0 && !/[\\/\u0000-\u001f]/.test(filename)
  const save = async (asNew: boolean) => {
    if (busy || (asNew && !validName)) return
    setBusy(true)
    setError(false)
    const target = /\.json$/i.test(filename.trim()) ? filename.trim() : `${filename.trim()}.json`
    const result = await saveProject(serializeProjectDocument(useStore.getState()), target, asNew)
    setBusy(false)
    if (result.outcome === 'failed') { setError(true); return }
    if (result.outcome === 'cancelled') return
    if (result.outcome !== 'downloaded') useStore.setState({ projectName: result.name ?? null })
    useToolStore.getState().showToast(result.outcome === 'downloaded'
      ? (zh ? `已下载副本：${result.name}` : `Downloaded a copy: ${result.name}`)
      : (zh ? `已保存：${result.name}` : `Saved: ${result.name}`), 'success')
    setOpen(false)
  }
  const button = 'rounded border border-slate-600 px-3 py-2 text-sm hover:bg-slate-700 disabled:opacity-40'
  return <>
    <div className="flex shrink-0 items-center gap-3 bg-slate-900 px-4 pt-1 text-xs">
      <span className="min-w-0 truncate text-slate-200" title={name ?? undefined} data-testid="current-project-name">
        {zh ? '当前工程：' : 'Project: '}{name ?? (zh ? '未命名工程' : 'Untitled project')}
      </span>
      <button className="shrink-0 text-blue-300 hover:underline" onClick={requestProjectSave}>
        {zh ? '保存…' : 'Save…'}
      </button>
    </div>
    <dialog ref={dialog} onCancel={e => { if (busy) e.preventDefault(); else setOpen(false) }}
      aria-labelledby="project-save-title" data-testid="project-save-dialog"
      onKeyDown={e => e.stopPropagation()}
      className="fixed inset-0 m-auto w-[calc(100%_-_2rem)] max-w-md rounded-xl border border-slate-600 bg-slate-900 p-5 text-slate-100 shadow-xl backdrop:bg-black/60">
      <h2 id="project-save-title" className="mb-4 text-base font-semibold">{zh ? '保存工程' : 'Save project'}</h2>
      <p className="mb-3 break-all text-sm">{zh ? '当前文件：' : 'Current file: '}{name ?? (zh ? '未命名' : 'Untitled')}</p>
      <label className="block text-sm">
        {zh ? '文件名' : 'File name'}
        <input data-testid="save-filename" value={filename} onChange={e => setFilename(e.target.value)} maxLength={250}
          className="mt-1 w-full rounded border border-slate-600 bg-slate-800 p-2" />
      </label>
      {!native && <p className="mt-3 text-sm text-slate-300" data-testid="save-download-help">
        {zh ? '此页面无法直接写入原文件，只能下载副本。保存目录由浏览器决定；请在浏览器下载设置中开启“下载前询问保存位置”，即可选择目录和是否替换同名文件。' : 'This page can only download a copy; it cannot write to the original file. Enable “Ask where to save each file” in your browser download settings to choose a folder and replace an existing file.'}
      </p>}
      {native && !overwrite && name && <p className="mt-3 text-sm text-slate-300">
        {zh ? '当前未持有原文件的写入权限。请选择“另存为”，在文件窗口中选原文件可覆盖，或选择新位置。' : 'The original file is not available for direct writing. Use Save as to select the original file or a new location.'}
      </p>}
      {error && <p role="alert" className="mt-3 text-sm text-red-300">
        {zh ? '保存失败，文件尚未保存。请检查写入权限或另存到其他位置。' : 'Saving failed. Check write permission or choose another location.'}
      </p>}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button className={button} disabled={busy} onClick={() => setOpen(false)}>{zh ? '取消' : 'Cancel'}</button>
        {native && overwrite && <button className={button} data-testid="save-overwrite" disabled={busy}
          onClick={() => void save(false)}>{zh ? '覆盖原文件' : 'Overwrite original'}</button>}
        <button className={`${button} bg-blue-700`} data-testid="save-confirm" disabled={busy || !validName}
          onClick={() => void save(true)}>{native ? (zh ? '另存为…' : 'Save as…') : (zh ? '下载副本' : 'Download copy')}</button>
      </div>
    </dialog>
  </>
}
