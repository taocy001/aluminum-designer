import React, { useEffect, useRef, useState } from 'react'

/**
 * The explanation for a control, where the control is.
 *
 * An icon means nothing until someone tells you what it is, and a legend in the corner of
 * the screen is not telling you — it is asking you to go and look. So the label comes to
 * the cursor: rest on a button for a moment and it says what it does, right there.
 *
 * Any element carrying `title` or `data-tip` is covered, which is every button already
 * written; nothing has to opt in. The `title` is moved aside while the pointer is on it so
 * the browser's own grey box does not turn up half a second later saying the same thing.
 */

/** long enough that sweeping the toolbar stays quiet, short enough to feel like an answer */
const DELAY_MS = 420
/** clear of the cursor, so the label never sits under the arrow it belongs to */
const OFFSET_X = 16
const OFFSET_Y = 20
/** keep the whole box on screen */
const MARGIN = 8

interface Tip { text: string; x: number; y: number }

/**
 * Take the label, and while the pointer is on the element take its `title` away too, or the
 * browser's own grey box turns up half a second later saying the same thing. It is handed
 * back on the way out, so the attribute is only ever missing while our own box is showing.
 */
function park(el: HTMLElement): string | null {
  const title = el.getAttribute('title')
  if (title) {
    el.setAttribute('data-tip', title)
    // A `title` also names the control for anything that cannot see it. Taking it away for
    // the moment the pointer rests there must not take the name with it, so it moves to the
    // attribute made for the job — and only when there is no name already.
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

  useEffect(() => {
    const cancel = () => {
      if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null }
      unpark(host.current)
      host.current = null
      setTip(null)
    }

    const onMove = (e: PointerEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-tip],[title],button[aria-label]') as HTMLElement | null
      if (!el) { cancel(); return }
      const text = park(el)
      if (!text) { cancel(); return }

      if (el === host.current) {
        // already showing or already counting down: just follow the cursor
        setTip((t) => (t ? { ...t, x: e.clientX, y: e.clientY } : t))
        return
      }
      cancel()
      host.current = el
      const { clientX, clientY } = e
      timer.current = window.setTimeout(() => setTip({ text, x: clientX, y: clientY }), DELAY_MS)
    }

    // a press is an answer, so the question goes away
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerdown', cancel, true)
    window.addEventListener('wheel', cancel, true)
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerdown', cancel, true)
      window.removeEventListener('wheel', cancel, true)
      window.removeEventListener('blur', cancel)
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [])

  if (!tip) return null

  // measured after the first paint; until then it is placed below-right and corrects itself
  const w = box.current?.offsetWidth ?? 0
  const h = box.current?.offsetHeight ?? 0
  const flipX = tip.x + OFFSET_X + w > window.innerWidth - MARGIN
  const flipY = tip.y + OFFSET_Y + h > window.innerHeight - MARGIN
  const left = Math.max(MARGIN, flipX ? tip.x - OFFSET_X - w : tip.x + OFFSET_X)
  const top = Math.max(MARGIN, flipY ? tip.y - OFFSET_Y - h : tip.y + OFFSET_Y)

  return (
    <div ref={box} data-testid="tooltip" role="tooltip"
      style={{ left, top }}
      className="fixed z-[100] pointer-events-none max-w-xs px-2.5 py-1.5 rounded-lg
        bg-slate-950/95 backdrop-blur-sm border border-white/15 shadow-2xl
        text-[11px] leading-snug text-slate-200 whitespace-pre-line">
      {tip.text}
    </div>
  )
}

export default Tooltip
