import { cancelActiveTransformGesture } from '../utils/transformGesture'
import { commands, commandReason, commandShortcut, keyCommand, runCommand } from '../utils/commands'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Box, ChevronDown, FileJson, FolderOpen, Languages, Link2, Save, Undo2, Redo2, X, Download, HardDrive, Search } from 'lucide-react'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { parseProjectDocument, serializeProjectDocument } from '../utils/document'
import { canOverwriteProject, canPickFiles, openProject, rememberOpenedFile, saveProject } from '../utils/projectFile'
import { COMFORTABLE_URL, encodeShareLink } from '../utils/shareLink'
import { translations } from '../utils/translations'
import { projectSession, type ProjectDraft } from '../utils/projectSession'
import AutoSaveStatus from './AutoSaveStatus'

/** Document commands stay available independently of the design panel. */
export default function EditorHeader() {
  const session = useSyncExternalStore(projectSession.subscribe, projectSession.getState)
  const geometry = useStore(s => [s.profiles.length, s.connectors.length, s.panels.length, s.fittings.length, s.equipment.length].join(','))
  const counts = geometry.split(',').map(Number)
  const hasParts = counts.some(Boolean)
  const [drafts, setDrafts] = useState<ProjectDraft[]>([])
  const [draftsOpen, setDraftsOpen] = useState(false)
  const [switchError, setSwitchError] = useState(false)
  const switchDialog = useRef<HTMLDialogElement>(null)
  const draftsDialog = useRef<HTMLDialogElement>(null)
  const name = useStore(s => s.projectName)
  useStore(s => [s.past.length, s.future.length].join(','))
  const undoReason = commandReason(commands.find(c => c.id === 'undo')!)
  const redoReason = commandReason(commands.find(c => c.id === 'redo')!)
  const { language, setLanguage, showToast } = useToolStore()
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
    cancelActiveTransformGesture()
    returnFocus.current = document.activeElement as HTMLElement
    setMenuOpen(false)
    setFilename(useStore.getState().projectName ?? `aluframe-${new Date().toISOString().slice(0, 10)}.json`)
    setAsNew(newFile)
    setError(false)
    setOpen(true)
  }
  const acceptFile = (text: string, fileName: string, accept: () => void) => {
    const parsed = parseProjectDocument(JSON.parse(text))
    projectSession.requestReplacement(() => {
      useStore.getState().loadDocument(parsed, { name: fileName, saved: true })
      useToolStore.getState().putDown()
      accept()
      showToast(t.toastImported, 'success')
    })
  }
  const openFile = async () => {
    cancelActiveTransformGesture()
    closeMenu()
    const picked = await openProject()
    if (picked.outcome === 'unsupported') { fileInput.current?.click(); return }
    if (picked.outcome === 'cancelled') return
    if (picked.outcome === 'failed') { showToast(t.toastImportFailed, 'error'); return }
    try { acceptFile(picked.text, picked.name, picked.accept) }
    catch { showToast(t.toastImportFailed, 'error') }
  }
  useEffect(() => {
    if (session.replacement && !open) switchDialog.current?.showModal()
    else switchDialog.current?.close()
  }, [session.replacement, open])
  useEffect(() => {
    if (draftsOpen) draftsDialog.current?.showModal()
    else draftsDialog.current?.close()
  }, [draftsOpen])
  const finishSwitch = () => {
    if (!projectSession.keepDraft()) { setSwitchError(true); return }
    try { projectSession.finishReplacement(); setSwitchError(false) }
    catch { setSwitchError(true) }
  }
  const restoreDraft = (draft: ProjectDraft) => {
    cancelActiveTransformGesture()
    setDraftsOpen(false)
    projectSession.requestReplacement(() => {
      useStore.getState().loadDocument(draft.document, { draft })
      useToolStore.getState().putDown()
    })
  }
  const share = async () => {
    cancelActiveTransformGesture()
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
    const projectCommand = (event: Event) => {
      const id = (event as CustomEvent<string>).detail
      if (document.querySelector('dialog[open]')) return
      if (id === 'open') void openFile()
      if (id === 'save' || id === 'save-as') request(id === 'save-as')
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing || document.querySelector('dialog[open]')) return
      const id = keyCommand(event)
      if (id && ['open', 'save', 'save-as'].includes(id)) { event.preventDefault(); runCommand(id) }
    }
    window.addEventListener('aluframe:project-command', projectCommand)
    window.addEventListener('keydown', keydown)
    return () => {
      window.removeEventListener('aluframe:project-command', projectCommand)
      window.removeEventListener('keydown', keydown)
    }
  })
  useEffect(() => {
    if (!menuOpen) return
    menuRoot.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
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
    const text = serializeProjectDocument(useStore.getState())
    const savedDocument = parseProjectDocument(text)
    const sessionId = projectSession.getState().id
    const result = await saveProject(text, target, newFile)
    setBusy(false)
    if (result.outcome === 'failed') { setError(true); return }
    if (result.outcome === 'cancelled') return
    if (sessionId !== projectSession.getState().id) return
    if (result.outcome !== 'downloaded') {
      useStore.setState({ projectName: result.name ?? null })
      projectSession.markSaved(savedDocument, sessionId)
    }
    showToast(result.outcome === 'downloaded'
      ? (zh ? `已下载副本：${result.name}` : `Downloaded a copy: ${result.name}`)
      : (zh ? `已保存：${result.name}` : `Saved: ${result.name}`), 'success')
    setOpen(false)
    if (result.outcome !== 'downloaded' && !projectSession.getState().dirty) projectSession.finishReplacement()
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
            const command = keyCommand(e.nativeEvent)
            if (command && ['open', 'save', 'save-as'].includes(command)) { e.preventDefault(); if (!e.repeat) runCommand(command); return }
            const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
            const index = items.indexOf(document.activeElement as HTMLButtonElement)
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
              e.preventDefault()
              const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
              items[next]?.focus()
            }
            if (e.key === 'Escape') { e.preventDefault(); closeMenu() }
            if (e.key === 'Tab') setMenuOpen(false)
          }}>
          <button role="menuitem" className={item} data-testid="import-project" onClick={() => runCommand("open")}><FolderOpen size={16} /><span>{zh ? '打开工程…' : 'Open project…'}</span><kbd>{commandShortcut('open')}</kbd></button>
          <button role="menuitem" className={item} data-testid="restore-drafts" onClick={() => { closeMenu(); setDrafts(projectSession.listDrafts()); setDraftsOpen(true) }}><HardDrive size={16} /><span>{zh ? '恢复草稿…' : 'Restore draft…'}</span></button>
          <div className="file-menu-divider" />
          <button role="menuitem" className={item} onClick={() => runCommand("save")}><Save size={16} /><span>{zh ? '保存…' : 'Save…'}</span><kbd>{commandShortcut('save')}</kbd></button>
          <button role="menuitem" className={item} data-testid="save-as" onClick={() => runCommand("save-as")}><FileJson size={16} /><span>{zh ? '另存为…' : 'Save as…'}</span><kbd>{commandShortcut('save-as')}</kbd></button>
          <div className="file-menu-divider" />
          {(['bom', 'cutting', 'dxf', 'step', 'assembly'] as const).map((kind, index) => <button key={kind} role="menuitem" className={item} data-testid={`export-${kind}`}
            disabled={kind === 'cutting' ? !counts[0] : kind === 'dxf' || kind === 'step' ? !counts.slice(0, 4).some(Boolean) : !hasParts}
            onClick={() => { closeMenu(); window.dispatchEvent(new CustomEvent('aluframe:export', { detail: kind })) }}><Download size={16} /><span>{(zh
              ? ['导出物料清单…', '导出下料方案…', '导出 DXF…', '导出 STEP…', '导出装配图…']
              : ['Export bill of materials…', 'Export cutting plan…', 'Export DXF…', 'Export STEP…', 'Export assembly guide…'])[index]}</span></button>)}
          <div className="file-menu-divider" />
          <button role="menuitem" className={item} data-testid="share-link" onClick={() => void share()}><Link2 size={16} /><span>{zh ? '复制分享链接' : 'Copy share link'}</span></button>
        </div>}
      </div>
      <div className="header-history" role="group" aria-label={zh ? '编辑历史' : 'Edit history'}>
        <button className="header-control header-icon" disabled={!!undoReason} onClick={() => runCommand('undo')} aria-label={t.undo} title={undoReason ?? `${t.undo} (${commandShortcut('undo')})`}><Undo2 size={16} /></button>
        <button className="header-control header-icon" disabled={!!redoReason} onClick={() => runCommand('redo')} aria-label={t.redo} title={redoReason ?? `${t.redo} (${commandShortcut('redo')})`}><Redo2 size={16} /></button>
      </div>
      <div className="project-identity">
        <span className="project-name" title={name ?? undefined} data-testid="current-project-name">{name ?? (zh ? '未命名工程' : 'Untitled project')}</span>
        <span data-testid="project-dirty" className="text-xs text-slate-400">{session.dirty ? (zh ? '有未保存更改' : 'Unsaved changes') : (zh ? '无未保存更改' : 'No unsaved changes')}</span>
        <AutoSaveStatus compact />
      </div>
      <button className="header-control header-icon" data-testid="command-search-toggle" aria-label={zh ? '查找命令' : 'Find a command'}
        title={zh ? '查找命令 (Ctrl/⌘+K)' : 'Find a command (Ctrl/⌘+K)'} onClick={() => window.dispatchEvent(new Event('aluframe:command-search'))}><Search size={16} /></button>
      <button data-keep-draw className="header-control header-save" data-testid="export-project" onClick={() => runCommand("save")} title={`${zh ? '保存工程' : 'Save project'} (${mod}S)`}><Save size={15} /><span>{zh ? '保存' : 'Save'}</span></button>
      <button data-keep-draw className="header-control header-icon language-control" onClick={() => setLanguage(zh ? 'en' : 'zh')} title={t.hintLanguage} aria-label={zh ? 'English' : '中文'}><Languages size={17} /></button>
    </header>
    {session.storageError && <div role="alert" className="px-4 py-2 text-xs bg-amber-950 text-amber-100">{zh ? '工程草稿未能保存到浏览器。请保存文件后再切换或关闭页面。' : 'The project draft could not be saved in this browser. Save the file before switching or closing.'}<button className="underline ml-3" onClick={() => projectSession.keepDraft()}>{zh ? '重试' : 'Retry'}</button></div>}
    <dialog ref={switchDialog} className="project-save-dialog" data-testid="project-switch-dialog" aria-labelledby="project-switch-title"
      onCancel={() => projectSession.cancelReplacement()} onKeyDown={e => e.stopPropagation()}>
      <h2 id="project-switch-title" className="font-semibold">{zh ? '当前工程有未保存更改' : 'This project has unsaved changes'}</h2>
      <p className="text-sm text-slate-400 mt-3">{zh ? '切换前保存文件，或保留到此浏览器的草稿列表。草稿不会覆盖原文件。' : 'Save the file or keep a draft in this browser before switching. Drafts do not overwrite the original file.'}</p>
      {switchError && <p role="alert" className="text-sm text-red-300 mt-3">{zh ? '草稿保存失败，当前工程仍保留在画布中。请保存文件或取消切换。' : 'The draft could not be saved. The current project remains open. Save the file or cancel switching.'}</p>}
      <div className="save-dialog-footer">
        <button className="dialog-secondary" data-testid="switch-cancel" onClick={() => { projectSession.cancelReplacement(); setSwitchError(false) }}>{zh ? '取消' : 'Cancel'}</button>
        <button className="dialog-secondary" data-testid="switch-keep-draft" onClick={finishSwitch}>{zh ? '保留草稿并继续' : 'Keep draft and continue'}</button>
        <button className="dialog-primary" data-testid="switch-save" onClick={() => request()}>{zh ? '保存后继续' : 'Save and continue'}</button>
      </div>
    </dialog>
    <dialog ref={draftsDialog} className="project-save-dialog" data-testid="project-drafts-dialog" aria-labelledby="project-drafts-title"
      onCancel={() => setDraftsOpen(false)} onKeyDown={e => e.stopPropagation()}>
      <h2 id="project-drafts-title" className="font-semibold">{zh ? '恢复草稿' : 'Restore draft'}</h2>
      <p className="text-xs text-slate-400 my-3">{zh ? '仅存于当前浏览器。恢复后需要重新选择保存文件的位置。' : 'Stored in this browser only. After restoring, choose the save location again.'}</p>
      <div className="max-h-80 overflow-y-auto">{drafts.length ? drafts.map(draft => <div key={draft.id} className="flex items-center gap-3 border-b border-slate-700 py-3">
        <div className="min-w-0 flex-1"><p className="truncate text-sm">{draft.name ?? (zh ? '未命名工程' : 'Untitled project')}</p><time className="text-xs text-slate-400" dateTime={new Date(draft.updatedAt).toISOString()}>{new Date(draft.updatedAt).toLocaleString(language)}</time></div>
        <button className="dialog-secondary" onClick={() => restoreDraft(draft)}>{zh ? '恢复' : 'Restore'}</button>
      </div>) : <p className="text-sm text-slate-400">{zh ? '没有其他工程的草稿。' : 'No drafts from other projects.'}</p>}</div>
      <div className="save-dialog-footer"><button className="dialog-secondary" onClick={() => setDraftsOpen(false)}>{zh ? '关闭' : 'Close'}</button></div>
    </dialog>
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
