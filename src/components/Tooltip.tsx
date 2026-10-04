import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'

/** Shared pointer and keyboard-focus explanation for titled controls. */
const DELAY_MS = 420
const OFFSET_X = 16
const OFFSET_Y = 20
const MARGIN = 8

interface Tip { text: string; x: number; y: number }

/** Suppress the native title while the custom tooltip is visible, restoring it on pointer exit. */
function park(el: HTMLElement): string | null {
  const title = el.getAttribute('title')
  if (title) {
    el.setAttribute('data-tip', title)
    if (!el.getAttribute('aria-label') && !el.textContent?.trim()) el.setAttribute('aria-label', title)
    el.removeAttribute('title')
    return title
  }
  return el.getAttribute('data-tip') || el.getAttribute('aria-label')
}

function unpark(el: HTMLElement | null) {
  if (!el) return
  const tip = el.getAttribute('data-tip')
  if (tip && !el.hasAttribute('title')) el.setAttribute('title', tip)
}

const Tooltip: React.FC = () => {
  const [tip, setTip] = useState<Tip | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const timer = useRef<number | null>(null)
  const host = useRef<HTMLElement | null>(null)
  const priorDescription = useRef<string | null>(null)
  const [position, setPosition] = useState({ left: MARGIN, top: MARGIN })

  useEffect(() => {
    const cancel = () => {
      if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null }
      if (host.current) {
        if (priorDescription.current) host.current.setAttribute('aria-describedby', priorDescription.current)
        else host.current.removeAttribute('aria-describedby')
      }
      priorDescription.current = null
      unpark(host.current)
      host.current = null
      setTip(null)
    }

    const onMove = (e: PointerEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-tip],[title],button[aria-label]') as HTMLElement | null
      if (!el) { cancel(); return }
      if (el === host.current) {
        // already showing or already counting down: just follow the cursor
        setTip((t) => (t ? { ...t, x: e.clientX, y: e.clientY } : t))
        return
      }
      cancel()
      const text = park(el)
      if (!text) return
      host.current = el
      priorDescription.current = el.getAttribute('aria-describedby')
      const { clientX, clientY } = e
      timer.current = window.setTimeout(() => setTip({ text, x: clientX, y: clientY }), DELAY_MS)
    }

    const onFocus = (event: FocusEvent) => {
      const el = (event.target as HTMLElement | null)?.closest?.('[data-tip],[title],button[aria-label]') as HTMLElement | null
      cancel()
      if (!el) return
      const text = park(el)
      if (!text) return
      const rect = el.getBoundingClientRect()
      host.current = el
      priorDescription.current = el.getAttribute('aria-describedby')
      el.setAttribute('aria-describedby', [priorDescription.current, 'control-tooltip'].filter(Boolean).join(' '))
      setTip({ text, x: rect.left + rect.width / 2, y: rect.bottom })
    }
    const onFocusOut = () => cancel()
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel() }
    window.addEventListener('focusin', onFocus)
    window.addEventListener('focusout', onFocusOut)
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerdown', cancel, true)
    window.addEventListener('wheel', cancel, true)
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('focusin', onFocus)
      window.removeEventListener('focusout', onFocusOut)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerdown', cancel, true)
      window.removeEventListener('wheel', cancel, true)
      window.removeEventListener('blur', cancel)
      cancel()
    }
  }, [])

  useLayoutEffect(() => {
    if (!tip || !box.current) return
    const { offsetWidth: w, offsetHeight: h } = box.current
    const flipX = tip.x + OFFSET_X + w > window.innerWidth - MARGIN
    const flipY = tip.y + OFFSET_Y + h > window.innerHeight - MARGIN
    setPosition({
      left: Math.max(MARGIN, Math.min(window.innerWidth - w - MARGIN, flipX ? tip.x - OFFSET_X - w : tip.x + OFFSET_X)),
      top: Math.max(MARGIN, flipY ? tip.y - OFFSET_Y - h : tip.y + OFFSET_Y),
    })
  }, [tip])

  if (!tip) return null

  return (
    <div ref={box} id="control-tooltip" data-testid="tooltip" role="tooltip"
      style={position}
      className="fixed z-[100] pointer-events-none max-w-xs px-2.5 py-1.5 rounded-lg
        bg-slate-950/95 backdrop-blur-sm border border-white/15 shadow-2xl
        text-[11px] leading-snug text-slate-200 whitespace-pre-line">
      {tip.text}
    </div>
  )
}

export default Tooltip
