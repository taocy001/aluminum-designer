import { commands, commandLabel, commandReason, runCommand, type CommandId } from '../utils/commands'
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { RotateCcw, RotateCw, Copy, FlipHorizontal2, Lock, LockOpen, Trash2, Crosshair, BoxSelect, Maximize, Ruler, Waypoints } from 'lucide-react'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { translations } from '../utils/translations'
import { selectionLocked, type RotAxis } from '../utils/editOps'

const AXIS_COLORS: Record<RotAxis, string> = { x: '#ef4444', y: '#22c55e', z: '#3b82f6' }
const MIN_WIDTH = 190

/** Selection and view commands at the pointer, opened with Space. */
const QuickMenu: React.FC = () => {
  const at = useToolStore((s) => s.quickMenuAt)
  const closeQuickMenu = useToolStore((s) => s.closeQuickMenu)
  const language = useToolStore((s) => s.language)
  const t = translations[language]
  const selectedIds = useStore((s) => s.selectedIds)
  const profiles = useStore((s) => s.profiles)
  const connectors = useStore((s) => s.connectors)
  const panels = useStore((s) => s.panels)
  const fittings = useStore((s) => s.fittings)
  const equipment = useStore((s) => s.equipment)
  const canInspect = useToolStore(s => !s.held && !s.isDrawing && !s.isDragging && !s.measuring)
  const viewMode = useToolStore((s) => s.viewMode)
  const ref = useRef<HTMLDivElement>(null)
  // Measure the rendered menu to keep it within the viewport.
  const [place, setPlace] = useState<{ x: number; y: number } | null>(null)
  useLayoutEffect(() => {
    if (!at) { setPlace(null); return }
    if (!ref.current) return
    const box = ref.current.getBoundingClientRect()
    setPlace({
      x: Math.max(8, Math.min(at.x + 6, window.innerWidth - box.width - 8)),
      y: Math.max(8, Math.min(at.y + 6, window.innerHeight - box.height - 8)),
    })
  }, [at, language, selectedIds.length])

  // any press outside closes it, like a context menu
  useEffect(() => {
    if (!at) return
    const onDown = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      closeQuickMenu()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [at, closeQuickMenu])

  useEffect(() => {
    if (!at) return
    const previous = document.activeElement as HTMLElement | null
    const frame = requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus())
    return () => {
      cancelAnimationFrame(frame)
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [at])

  const onMenuKey = (event: React.KeyboardEvent) => {
    event.stopPropagation()
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault(); closeQuickMenu(); return
    }
    const step = ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : ['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 0
    if (step || event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + step + buttons.length) % buttons.length
      buttons[index]?.focus()
    }
  }

  if (!at) return null

  const locked = selectionLocked({ profiles, connectors, panels, fittings, equipment }, selectedIds)
  const hasSelection = selectedIds.length > 0

  const run = (fn: () => void) => () => { fn(); closeQuickMenu() }
  const action = (id: CommandId) => run(() => { runCommand(id) })
  const reason = (id: CommandId) => commandReason(commands.find(c => c.id === id)!)
  const Item: React.FC<{ onClick: () => void; children: React.ReactNode; testId: string; command?: CommandId; danger?: boolean; tip?: string; edit?: boolean }> =
    ({ onClick, children, testId, danger, tip, edit, command }) => (
      <button role="menuitem" onClick={onClick} data-testid={testId} aria-label={command ? commandLabel(commands.find(c => c.id === command)!) : undefined} title={(command && reason(command)) || tip} disabled={command ? !!reason(command) : viewMode && edit}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-[11px] font-bold whitespace-nowrap ${
          danger ? 'text-red-400 hover:bg-red-400/10' : 'text-slate-200 hover:bg-white/10'}`}>
        {children}
      </button>
    )

  return (
    <div ref={ref} data-testid="quick-menu" role="menu" aria-label={t.quickMenu} onKeyDown={onMenuKey}
      style={{
        left: place ? place.x : at.x + 6, top: place ? place.y : at.y + 6, minWidth: MIN_WIDTH,
        visibility: place ? 'visible' : 'hidden',   // drawn once to be measured, shown once placed
      }}
      className="fixed z-40 bg-slate-900/95 backdrop-blur-xl border border-white/10 rounded-xl shadow-2xl p-1.5 flex flex-col gap-0.5">
      <div className="px-3 pt-1 pb-1.5 text-[9px] font-black uppercase tracking-widest text-slate-500">
        {t.quickMenu}{hasSelection ? ` · ${selectedIds.length}` : ''}
      </div>

      {canInspect && <Item testId="quick-overlap" onClick={run(() => window.dispatchEvent(new CustomEvent('aluframe:overlap', { detail: at })))}>
        <BoxSelect size={12} />{language === 'zh' ? '选择重叠零件' : 'Choose overlapping part'}
      </Item>}
      {!hasSelection && (
        <>
          <Item testId="quick-select-all" tip={t.hintSelectAll} command="select-all" onClick={action("select-all")}><BoxSelect size={12} />{t.selectAll}</Item>
          <Item testId="quick-fit-view" tip={t.hintFitView} command="fit-all" onClick={action("fit-all")}><Maximize size={12} />{t.fitView}</Item>
          <Item testId="quick-labels" tip={t.hintLabels} command="labels" onClick={action("labels")}><Ruler size={12} />{t.labels}</Item>
          <Item testId="quick-part-numbers" tip={t.partNumbersHint} command="part-numbers" onClick={action("part-numbers")}><span className="font-mono">#</span>{t.partNumbers}</Item>
        </>
      )}
      {hasSelection && (['x', 'y', 'z'] as RotAxis[]).map((ax) => (
        <div key={ax} className="flex items-center">
          <Item edit testId={`quick-rot-${ax}`} tip={t.hintRotateFwd(ax.toUpperCase())} command={`rotate-${ax}`} onClick={action(`rotate-${ax}`)}>
            <RotateCw size={12} style={{ color: AXIS_COLORS[ax] }} />{t.gizmoRotate(ax.toUpperCase())}
          </Item>
          <button role="menuitem" onClick={action(`rotate-${ax}-back`)} data-testid={`quick-rot-${ax}-back`}
            disabled={!!reason(`rotate-${ax}-back`)} aria-label={t.hintRotateBack(ax.toUpperCase())}
            title={t.hintRotateBack(ax.toUpperCase())}
            className="ml-auto mr-1 p-1.5 rounded-lg text-slate-400 hover:bg-white/10"><RotateCcw size={12} /></button>
        </div>
      ))}
      {hasSelection && <div className="h-px bg-white/10 my-1" />}
      {/* Select profiles connected to the current selection. */}
      {hasSelection && <Item testId="quick-connected" tip={t.hintSelectConnected}
        command="connected" onClick={action("connected")}>
        <Waypoints size={12} />{t.selectConnected}
      </Item>}
      {hasSelection && <Item edit testId="quick-duplicate" tip={t.hintDuplicate} command="duplicate" onClick={action("duplicate")}><Copy size={12} />{t.duplicate}</Item>}
      {hasSelection && <div className="flex items-center gap-0.5 px-1.5 pb-0.5">
        <FlipHorizontal2 size={12} className="text-slate-400 mx-1.5" />
        {(['x', 'y', 'z'] as RotAxis[]).map((ax) => (
          <button role="menuitem" key={ax} onClick={action(`mirror-${ax}`)} data-testid={`quick-mirror-${ax}`}
            disabled={!!reason(`mirror-${ax}`)} aria-label={t.hintMirror(ax.toUpperCase())}
            title={t.hintMirror(ax.toUpperCase())}
            className="flex-1 py-1 rounded-lg bg-slate-700/50 hover:bg-slate-700 text-[10px] font-bold font-mono text-slate-200">
            {ax.toUpperCase()}
          </button>
        ))}
      </div>}
      {hasSelection && <div className="h-px bg-white/10 my-1" />}
      {hasSelection && <Item testId="quick-pivot" tip={t.hintPivot} command="pivot" onClick={action("pivot")}>
        <Crosshair size={12} />{t.pivotCenter}/{t.pivotStart}/{t.pivotEnd}
      </Item>}
      {hasSelection && <Item edit testId="quick-lock" tip={t.lockHint} command="lock" onClick={action("lock")}>
        {locked ? <Lock size={12} className="text-amber-400" /> : <LockOpen size={12} />}{locked ? t.unlock : t.lock}
      </Item>}
      {hasSelection && <Item edit testId="quick-delete" danger tip={t.hintDelete} command="delete" onClick={action("delete")}><Trash2 size={12} />{t.delete}</Item>}
    </div>
  )
}

export default QuickMenu
