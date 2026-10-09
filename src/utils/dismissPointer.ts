/** Consume the press that dismisses a popup, including its later native click. */
export function suppressDismissPointer(press: PointerEvent): () => void {
  press.preventDefault()
  press.stopImmediatePropagation()
  // Cancelling pointerdown does not cancel click. This guard survives popup
  // dismissal, and expires before the next independent pointer or key gesture.
  const cleanup = () => {
    window.removeEventListener('click', onClick, true)
    window.removeEventListener('pointerdown', onNextPointer, true)
    window.removeEventListener('pointercancel', cleanup, true)
    window.removeEventListener('keydown', cleanup, true)
    window.removeEventListener('blur', cleanup)
  }
  const onClick = (click: MouseEvent) => {
    cleanup()
    if (click.detail === 0) return // Keyboard and assistive activation are independent.
    click.preventDefault()
    click.stopImmediatePropagation()
  }
  const onNextPointer = (next: PointerEvent) => { if (next !== press) cleanup() }
  window.addEventListener('click', onClick, true)
  window.addEventListener('pointerdown', onNextPointer, true)
  window.addEventListener('pointercancel', cleanup, true)
  window.addEventListener('keydown', cleanup, true)
  window.addEventListener('blur', cleanup)
  return cleanup
}
