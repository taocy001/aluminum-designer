import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { RotateCcw, RotateCw, Copy, FlipHorizontal2, Lock, LockOpen, Trash2, Crosshair } from 'lucide-react'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { translations } from '../utils/translations'
import { duplicateSelected, mirrorSelected, rotateSelected, type RotAxis } from '../utils/editOps'

const AXIS_COLORS: Record<RotAxis, string> = { x: '#ef4444', y: '#22c55e', z: '#3b82f6' }
const MIN_WIDTH = 190

/**
 * The actions you reach for constantly, opened at the cursor with Space.
 *
 * Every one of these already lives in the sidebar, which is the problem: a turn and a copy
 * cost a trip across the window and back, over and over. ZBrush answers this with the
 * spacebar shelf under the cursor; this is the same idea, cut down to what a frame needs.
 */
const QuickMenu: React.FC = () => {
  const at = useToolStore((s) => s.quickMenuAt)
  const closeQuickMenu = useToolStore((s) => s.closeQuickMenu)
  const language = useToolStore((s) => s.language)
  const t = translations[language]
  const selectedIds = useStore((s) => s.selectedIds)
  const profiles = useStore((s) => s.profiles)
  const connectors = useStore((s) => s.connectors)
  const toggleLockSelected = useStore((s) => s.toggleLockSelected)
  const removeSelected = useStore((s) => s.removeSelected)
  const ref = useRef<HTMLDivElement>(null)
  // The menu is measured after it renders rather than guessed at: its height depends on the
  // language and the row count, and a guess that is too small pushes it off the bottom.
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
      closeQuickMenu()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [at, closeQuickMenu])

  if (!at || selectedIds.length === 0) return null

  const locked = profiles.filter((p) => selectedIds.includes(p.id)).every((p) => p.locked)
    && connectors.filter((c) => selectedIds.includes(c.id)).every((c) => c.locked)

  const run = (fn: () => void) => () => { fn(); closeQuickMenu() }
  const Item: React.FC<{ onClick: () => void; children: React.ReactNode; testId: string; danger?: boolean }> =
    ({ onClick, children, testId, danger }) => (
      <button onClick={onClick} data-testid={testId}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-[11px] font-bold whitespace-nowrap ${
          danger ? 'text-red-400 hover:bg-red-400/10' : 'text-slate-200 hover:bg-white/10'}`}>
        {children}
      </button>
    )

  return (
    <div ref={ref} data-testid="quick-menu"
      style={{
        left: place ? place.x : at.x + 6, top: place ? place.y : at.y + 6, minWidth: MIN_WIDTH,
        visibility: place ? 'visible' : 'hidden',   // drawn once to be measured, shown once placed
      }}
      className="fixed z-40 bg-slate-900/95 backdrop-blur-xl border border-white/10 rounded-xl shadow-2xl p-1.5 flex flex-col gap-0.5">
      <div className="px-3 pt-1 pb-1.5 text-[9px] font-black uppercase tracking-widest text-slate-500">
        {t.quickMenu} · {selectedIds.length}
      </div>
      {(['x', 'y', 'z'] as RotAxis[]).map((ax) => (
        <div key={ax} className="flex items-center">
          <Item testId={`quick-rot-${ax}`} onClick={run(() => rotateSelected(ax, 90))}>
            <RotateCw size={12} style={{ color: AXIS_COLORS[ax] }} />{t.gizmoRotate(ax.toUpperCase())}
          </Item>
          <button onClick={run(() => rotateSelected(ax, -90))} data-testid={`quick-rot-${ax}-back`}
            title={`${t.gizmoRotate(ax.toUpperCase())} −`}
            className="ml-auto mr-1 p-1.5 rounded-lg text-slate-400 hover:bg-white/10"><RotateCcw size={12} /></button>
        </div>
      ))}
      <div className="h-px bg-white/10 my-1" />
      <Item testId="quick-duplicate" onClick={run(duplicateSelected)}><Copy size={12} />{t.duplicate}</Item>
      <div className="flex items-center gap-0.5 px-1.5 pb-0.5">
        <FlipHorizontal2 size={12} className="text-slate-400 mx-1.5" />
        {(['x', 'y', 'z'] as RotAxis[]).map((ax) => (
          <button key={ax} onClick={run(() => mirrorSelected(ax))} data-testid={`quick-mirror-${ax}`}
            className="flex-1 py-1 rounded-lg bg-slate-700/50 hover:bg-slate-700 text-[10px] font-bold font-mono text-slate-200">
            {ax.toUpperCase()}
          </button>
        ))}
      </div>
      <div className="h-px bg-white/10 my-1" />
      <Item testId="quick-pivot" onClick={run(useToolStore.getState().cyclePivotMode)}>
        <Crosshair size={12} />{t.pivotCenter}/{t.pivotStart}/{t.pivotEnd}
      </Item>
      <Item testId="quick-lock" onClick={run(toggleLockSelected)}>
        {locked ? <Lock size={12} className="text-amber-400" /> : <LockOpen size={12} />}{locked ? t.unlock : t.lock}
      </Item>
      <Item testId="quick-delete" danger onClick={run(removeSelected)}><Trash2 size={12} />{t.delete}</Item>
    </div>
  )
}

export default QuickMenu
