import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { commandLabel, commandReason, commandShortcut, runCommand, searchCommands } from '../utils/commands'
import { transformGestureActive } from '../utils/transformGesture'

export default function CommandSearch() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const previous = useRef<HTMLElement | null>(null)
  useStore(state => open ? state : null)
  useToolStore(state => open ? state : null)
  const zh = useToolStore(state => state.language === 'zh')
  const results = searchCommands(query)
  const index = Math.min(active, Math.max(0, results.length - 1))
  const close = () => {
    dialog.current?.close()
    setOpen(false)
    if (previous.current?.isConnected) previous.current.focus({ preventScroll: true })
  }
  useEffect(() => {
    const show = () => {
      if (document.querySelector('dialog[open]') || transformGestureActive()) return
      previous.current = document.activeElement as HTMLElement
      useToolStore.getState().closeQuickMenu()
      setQuery(''); setActive(0); setOpen(true)
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat || event.altKey) return
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'k') {
        if (document.querySelector('dialog[open]')) return
        event.preventDefault(); show()
      }
    }
    window.addEventListener('aluframe:command-search', show)
    window.addEventListener('keydown', keydown)
    return () => {
      window.removeEventListener('aluframe:command-search', show)
      window.removeEventListener('keydown', keydown)
    }
  }, [])
  useEffect(() => {
    if (!open) return
    dialog.current?.showModal()
    input.current?.focus()
  }, [open])
  useEffect(() => {
    if (open) document.getElementById(`command-result-${index}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, index, query])
  const choose = (id: string) => {
    const command = results.find(c => c.id === id)
    if (!command || commandReason(command)) return
    close()
    runCommand(id)
  }
  return <dialog ref={dialog} className="command-dialog" data-testid="command-search" aria-labelledby="command-search-title"
    onCancel={event => { event.preventDefault(); close() }}
    onClick={event => { if (event.target === dialog.current) { const r = dialog.current!.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close() } }}
    onKeyDown={event => {
      event.stopPropagation()
      if (event.nativeEvent.isComposing) return
      if (event.key === 'Escape') { event.preventDefault(); close() }
    }}>
    <div className="flex items-center justify-between gap-3 px-4 pt-4">
      <h2 id="command-search-title" className="text-sm font-medium">{zh ? '查找命令' : 'Find a command'}</h2>
      <button className="header-control header-icon" onClick={close} aria-label={zh ? '关闭' : 'Close'}><X size={16} /></button>
    </div>
    <div className="flex items-center gap-2 mx-4 mb-3 border-b border-white/15">
      <Search size={16} className="text-slate-400 shrink-0" />
      <input ref={input} role="combobox" aria-label={zh ? '搜索命令' : 'Search commands'} autoComplete="off" spellCheck={false}
        aria-autocomplete="list" aria-expanded={open} aria-controls="command-results"
        aria-activedescendant={results.length ? `command-result-${index}` : undefined}
        className="w-full bg-transparent py-3 text-sm outline-none" value={query} placeholder={zh ? '输入操作名称…' : 'Type an action…'}
        onChange={event => { setQuery(event.target.value); setActive(0) }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setActive((index + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % Math.max(1, results.length))
          }
          if (event.key === 'Enter') { event.preventDefault(); if (results[index]) choose(results[index].id) }
        }} />
    </div>
    <div id="command-results" role="listbox" aria-label={zh ? '命令' : 'Commands'} className="command-results">
      {results.map((command, i) => {
        const reason = commandReason(command)
        return <div key={command.id} id={`command-result-${i}`} role="option" aria-selected={i === index} aria-disabled={!!reason}
          data-testid={`command-${command.id}`} onPointerMove={() => setActive(i)} onMouseDown={event => event.preventDefault()}
          onClick={() => choose(command.id)} className="command-result">
          <span className="min-w-0"><span className="block">{commandLabel(command)}</span>{reason && <span className="block text-xs text-slate-400 mt-1">{reason}</span>}</span>
          <kbd className="text-xs text-slate-400 shrink-0">{commandShortcut(command.id)}</kbd>
        </div>
      })}
      {!results.length && <p role="status" className="text-sm text-slate-400 p-4">{zh ? '没有匹配的命令' : 'No matching commands'}</p>}
    </div>
    <p className="border-t border-white/10 px-4 py-3 text-xs text-slate-400">{zh ? '↑ ↓ 选择 · Enter 执行 · Esc 关闭' : '↑ ↓ select · Enter run · Esc close'}</p>
  </dialog>
}
