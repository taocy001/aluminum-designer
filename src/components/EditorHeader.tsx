import { useEffect, useRef, useState } from 'react'
import { Box, ChevronDown, FileJson, FolderOpen, Languages, Link2, Save, Undo2, Redo2, X, Download, HardDrive } from 'lucide-react'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { parseProjectDocument, serializeProjectDocument } from '../utils/document'
import { canOverwriteProject, canPickFiles, openProject, rememberOpenedFile, saveProject } from '../utils/projectFile'
import { COMFORTABLE_URL, encodeShareLink } from '../utils/shareLink'
import { translations } from '../utils/translations'
import AutoSaveStatus from './AutoSaveStatus'

/** Document commands stay available independently of the design panel. */
export default function EditorHeader() {
  const name = useStore(s => s.projectName)
  const canUndo = useStore(s => s.past.length > 0)
  const canRedo = useStore(s => s.future.length > 0)
  const { language, setLanguage, viewMode, showToast } = useToolStore()
  const zh = language === 'zh'
  const t = translations[language]
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'
  const [menuOpen, setMenuOpen] = useState(false)
  const [open, setOpen] = useState(false)
  const [filename, setFilename] = useState('')
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [asNew, setAsNew] = useState(false)
  const wasOpen = useRef(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const menuRoot = useRef<HTMLDivElement>(null)
  const menuButton = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const native = canPickFiles()
  const overwrite = canOverwriteProject()
  const request = (newFile = false) => {
    returnFocus.current = document.activeElement as HTMLElement
    setMenuOpen(false)
    setFilename(useStore.getState().projectName ?? `aluframe-${new Date().toISOString().slice(0, 10)}.json`)
    setAsNew(newFile)
    setError(false)
    setOpen(true)
  }
  const acceptFile = (text: string, fileName: string, accept: () => void) => {
    const parsed = parseProjectDocument(JSON.parse(text))
    useStore.getState().loadDocument(parsed)
    useToolStore.getState().putDown()
    accept()
    useStore.setState({ projectName: fileName })
    showToast(t.toastImported, 'success')
  }
  const openFile = async () => {
    closeMenu()
    const picked = await openProject()
    if (picked.outcome === 'unsupported') { fileInput.current?.click(); return }
    if (picked.outcome === 'cancelled') return
    if (picked.outcome === 'failed') { showToast(t.toastImportFailed, 'error'); return }
    try { acceptFile(picked.text, picked.name, picked.accept) }
    catch { showToast(t.toastImportFailed, 'error') }
  }
  const share = async () => {
    closeMenu()
    try {
      const link = await encodeShareLink(useStore.getState())
      if (link.length > COMFORTABLE_URL * 8) { showToast(t.toastShareTooBig, 'error'); return }
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(link)
      showToast(t.toastShared(Math.max(1, Math.round(link.length / 1024))), 'success')
    } catch { showToast(t.toastClipboardFailed, 'error') }
  }
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.repeat || document.querySelector('dialog[open]')) return
      if (e.key.toLowerCase() === 's') { e.preventDefault(); request(e.shiftKey) }
      if (e.key.toLowerCase() === 'o') { e.preventDefault(); void openFile() }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  })
  useEffect(() => {
    if (!menuOpen) return
    menuRoot.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    const outside = (e: PointerEvent) => {
      if (!menuRoot.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('pointerdown', outside)
    return () => window.removeEventListener('pointerdown', outside)
  }, [menuOpen])
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal()
    if (!open && wasOpen.current) {
      dialog.current?.close()
      const target = returnFocus.current
      if (target?.isConnected && target.getClientRects().length) target.focus()
      else menuButton.current?.focus()
    }
    wasOpen.current = open
  }, [open])
  const validName = filename.trim().length > 0 && !/[\\/\u0000-\u001f]/.test(filename)
  const save = async (newFile: boolean) => {
    if (busy || (newFile && !validName)) return
    setBusy(true)
    setError(false)
    const target = /\.json$/i.test(filename.trim()) ? filename.trim() : `${filename.trim()}.json`
    const result = await saveProject(serializeProjectDocument(useStore.getState()), target, newFile)
    setBusy(false)
    if (result.outcome === 'failed') { setError(true); return }
    if (result.outcome === 'cancelled') return
    if (result.outcome !== 'downloaded') useStore.setState({ projectName: result.name ?? null })
    showToast(result.outcome === 'downloaded'
      ? (zh ? `已下载副本：${result.name}` : `Downloaded a copy: ${result.name}`)
      : (zh ? `已保存：${result.name}` : `Saved: ${result.name}`), 'success')
    setOpen(false)
  }
  const item = 'file-menu-item'
  const closeMenu = () => { setMenuOpen(false); menuButton.current?.focus() }
  return <>
    <header className="editor-header" data-testid="editor-header">
      <div className="editor-brand" title={t.title} aria-label={t.title}><Box size={20} strokeWidth={1.5} /><span>ALUFRAME</span></div>
      <div ref={menuRoot} className="relative shrink-0">
        <button ref={menuButton} data-testid="file-menu" className="header-control" aria-haspopup="menu" aria-expanded={menuOpen}
          aria-controls="project-file-menu" onClick={() => setMenuOpen(!menuOpen)}
          onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); setMenuOpen(true) } }}>
          {zh ? '文件' : 'File'}<ChevronDown size={12} />
        </button>
        {menuOpen && <div id="project-file-menu" role="menu" aria-label={zh ? '文件' : 'File'} className="file-menu"
          onKeyDown={e => {
            e.stopPropagation()
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); request(e.shiftKey); return }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); void openFile(); return }
            const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
            const index = items.indexOf(document.activeElement as HTMLButtonElement)
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
              e.preventDefault()
              const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
              items[next]?.focus()
            }
            if (e.key === 'Escape') { e.preventDefault(); closeMenu() }
            if (e.key === 'Tab') setMenuOpen(false)
          }}>
          <button role="menuitem" className={item} data-testid="import-project" onClick={() => void openFile()}><FolderOpen size={16} /><span>{zh ? '打开工程…' : 'Open project…'}</span><kbd>{mod}O</kbd></button>
          <div className="file-menu-divider" />
          <button role="menuitem" className={item} onClick={() => request()}><Save size={16} /><span>{zh ? '保存…' : 'Save…'}</span><kbd>{mod}S</kbd></button>
          <button role="menuitem" className={item} data-testid="save-as" onClick={() => request(true)}><FileJson size={16} /><span>{zh ? '另存为…' : 'Save as…'}</span><kbd>{mod}⇧S</kbd></button>
          <div className="file-menu-divider" />
          <button role="menuitem" className={item} data-testid="share-link" onClick={() => void share()}><Link2 size={16} /><span>{zh ? '复制分享链接' : 'Copy share link'}</span></button>
        </div>}
      </div>
      <div className="header-history" role="group" aria-label={zh ? '编辑历史' : 'Edit history'}>
        <button className="header-control header-icon" disabled={viewMode || !canUndo} onClick={() => { useToolStore.getState().cancelDraw(); useStore.getState().undo() }} aria-label={t.undo} title={`${t.undo} (${mod}Z)`}><Undo2 size={16} /></button>
        <button className="header-control header-icon" disabled={viewMode || !canRedo} onClick={() => { useToolStore.getState().cancelDraw(); useStore.getState().redo() }} aria-label={t.redo} title={`${t.redo} (${mod}⇧Z)`}><Redo2 size={16} /></button>
      </div>
      <div className="project-identity">
        <span className="project-name" title={name ?? undefined} data-testid="current-project-name">{name ?? (zh ? '未命名工程' : 'Untitled project')}</span>
        <AutoSaveStatus compact />
      </div>
      <button data-keep-draw className="header-control header-save" data-testid="export-project" onClick={() => request()} title={`${zh ? '保存工程' : 'Save project'} (${mod}S)`}><Save size={15} /><span>{zh ? '保存' : 'Save'}</span></button>
      <button data-keep-draw className="header-control header-icon language-control" onClick={() => setLanguage(zh ? 'en' : 'zh')} title={t.hintLanguage} aria-label={zh ? 'English' : '中文'}><Languages size={17} /></button>
    </header>
    <input ref={fileInput} type="file" accept="application/json,.json" className="hidden" onChange={e => {
      const file = e.target.files?.[0]
      if (file) void file.text().then(text => acceptFile(text, file.name, () => rememberOpenedFile(file.name)))
        .catch(() => showToast(t.toastImportFailed, 'error'))
      e.target.value = ''
    }} />
    <dialog ref={dialog} onCancel={e => { if (busy) e.preventDefault(); else setOpen(false) }}
      aria-labelledby="project-save-title" data-testid="project-save-dialog" onKeyDown={e => e.stopPropagation()}
      className="project-save-dialog">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3"><div className="save-dialog-icon"><FileJson size={22} strokeWidth={1.5} /></div>
          <div><h2 id="project-save-title" className="text-base font-semibold">{zh ? '保存工程' : 'Save project'}</h2><p className="text-xs text-slate-400 mt-1">{zh ? 'JSON 工程文件 · 可继续编辑' : 'JSON project · editable document'}</p></div></div>
        <button className="header-control header-icon" disabled={busy} onClick={() => setOpen(false)} aria-label={zh ? '关闭' : 'Close'}><X size={16} /></button>
      </div>
      {native && overwrite && <div className="save-destinations" role="group" aria-label={zh ? '保存方式' : 'Save destination'}>
        <button disabled={busy} aria-pressed={!asNew} onClick={() => { setAsNew(false); setFilename(name ?? '') }}><HardDrive size={15} />{zh ? '原文件' : 'Original file'}</button>
        <button disabled={busy} aria-pressed={asNew} onClick={() => setAsNew(true)}><FileJson size={15} />{zh ? '另存为' : 'Save as'}</button>
      </div>}
      <label className="block text-xs text-slate-300 mt-6">
        {zh ? '文件名' : 'File name'}
        <input data-testid="save-filename" value={filename} onChange={e => { setFilename(e.target.value); setAsNew(true) }} maxLength={250}
          onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void save(!native || !overwrite || asNew) } }}
          className="save-name-input" autoComplete="off" spellCheck={false} />
      </label>
      <div className="save-location"><span>{native ? <HardDrive size={15} /> : <Download size={15} />}</span><div>
        <p className="text-xs text-slate-300">{native ? (overwrite && !asNew ? (zh ? '更新原文件' : 'Update original file') : (zh ? '在系统窗口中选择保存位置' : 'Choose a location in the system dialog')) : (zh ? '下载到浏览器指定的目录' : 'Download to your browser’s download folder')}</p>
        {!native && <p className="text-xs text-slate-500 leading-relaxed mt-1" data-testid="save-download-help">{zh ? '不会直接覆盖原文件。需要选择目录或替换同名文件时，请在浏览器中开启“下载前询问保存位置”。' : 'This does not overwrite the original. Enable “Ask where to save each file” in your browser to choose a folder or replace a file.'}</p>}
        {native && overwrite && !asNew && <p className="text-xs text-slate-500 mt-1 break-all">{name}</p>}
      </div></div>
      {error && <p role="alert" className="mt-3 text-xs text-red-300">{zh ? '保存失败，文件尚未保存。请检查写入权限或另存到其他位置。' : 'Saving failed. Check write permission or choose another location.'}</p>}
      <div className="save-dialog-footer">
        <button className="dialog-secondary" disabled={busy} onClick={() => setOpen(false)}>{zh ? '取消' : 'Cancel'}</button>
        {native && overwrite && !asNew ? <button className="dialog-primary" data-testid="save-overwrite" disabled={busy} onClick={() => void save(false)}>{busy ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存到原文件' : 'Save to original')}</button>
          : <button className="dialog-primary" data-testid="save-confirm" disabled={busy || !validName} onClick={() => void save(true)}>{busy ? (zh ? '保存中…' : 'Saving…') : native ? (zh ? '选择位置并保存…' : 'Choose location…') : (zh ? '下载工程' : 'Download project')}</button>}
      </div>
    </dialog>
  </>
}
