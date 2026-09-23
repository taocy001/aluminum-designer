import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'

/**
 * Trackpad and touch gestures, chosen for what is free.
 *
 * Three- and four-finger gestures belong to macOS — Mission Control, App Exposé, switching
 * desktops — and taking them would be taking them from the whole machine. Two fingers are
 * ours, with one hazard: a two-finger swipe sideways is the browser's back gesture, and in a
 * canvas that means leaving with the drawing half drawn. That is guarded rather than used.
 *
 * What is left is the gesture everyone already knows:
 *
 *  - **pinch** to zoom. The browser reports it as a wheel event with `ctrlKey`, which it will
 *    otherwise use to zoom the page — text and toolbar and all — so it has to be taken.
 *  - **two-finger tap** to undo, which is what a tablet does.
 *  - **press and hold** for the menu the space bar opens, because a tablet has no space bar.
 */

/** a pinch is reported as a wheel: this turns its delta into the same steps the buttons take */
const PINCH_TO_ZOOM = 0.005
/** how long a finger stays put before it counts as a hold (ms) */
const HOLD_MS = 480
/** and how far it may wander in that time (px) */
const HOLD_SLOP = 12

const Gestures: React.FC = () => {
  const { gl, camera, controls } = useThree()

  useEffect(() => {
    const canvas = gl.domElement

    // ── pinch to zoom ────────────────────────────────────────────────────────────────
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return           // an ordinary scroll: OrbitControls has it
      // the browser's own page zoom would otherwise fire, and a design tool whose toolbar
      // grows when you pinch the model is not zooming the model
      e.preventDefault()
      const orbit = controls as unknown as { target?: THREE.Vector3; update?: () => void } | null
      const target = orbit?.target ?? new THREE.Vector3()
      const toCam = camera.position.clone().sub(target)
      const factor = Math.exp(e.deltaY * PINCH_TO_ZOOM)
      const next = THREE.MathUtils.clamp(toCam.length() * factor, 50, 30000)
      camera.position.copy(target.clone().addScaledVector(toCam.normalize(), next))
      orbit?.update?.()
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })

    // ── two-finger tap: undo, the way a tablet does it ───────────────────────────────
    // ── press and hold: the menu the space bar opens, for anything without a space bar ─
    let hold: number | null = null
    let twoFingerAt = 0
    const cancelHold = () => { if (hold !== null) { window.clearTimeout(hold); hold = null } }

    const onTouchStart = (e: TouchEvent) => {
      cancelHold()
      if (e.touches.length === 2) { twoFingerAt = Date.now(); return }
      if (e.touches.length !== 1) return
      const t = e.touches[0]
      const x = t.clientX, y = t.clientY
      hold = window.setTimeout(() => {
        hold = null
        useToolStore.getState().openQuickMenu(x, y)
      }, HOLD_MS)
    }
    const onTouchMove = (e: TouchEvent) => {
      if (hold === null || e.touches.length !== 1) { cancelHold(); return }
      const t = e.touches[0]
      const start = canvas.getBoundingClientRect()
      void start
      if (Math.hypot(t.clientX - lastStart.x, t.clientY - lastStart.y) > HOLD_SLOP) cancelHold()
    }
    const lastStart = { x: 0, y: 0 }
    const rememberStart = (e: TouchEvent) => {
      if (e.touches.length === 1) { lastStart.x = e.touches[0].clientX; lastStart.y = e.touches[0].clientY }
    }
    const onTouchEnd = (e: TouchEvent) => {
      cancelHold()
      // both fingers lifted quickly, having gone nowhere: a two-finger tap
      if (e.touches.length === 0 && twoFingerAt && Date.now() - twoFingerAt < 300) {
        useStore.getState().undo()
      }
      twoFingerAt = 0
    }

    canvas.addEventListener('touchstart', rememberStart, { passive: true })
    canvas.addEventListener('touchstart', onTouchStart, { passive: true })
    canvas.addEventListener('touchmove', onTouchMove, { passive: true })
    canvas.addEventListener('touchend', onTouchEnd, { passive: true })
    canvas.addEventListener('touchcancel', cancelHold, { passive: true })

    return () => {
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('touchstart', rememberStart)
      canvas.removeEventListener('touchstart', onTouchStart)
      canvas.removeEventListener('touchmove', onTouchMove)
      canvas.removeEventListener('touchend', onTouchEnd)
      canvas.removeEventListener('touchcancel', cancelHold)
      cancelHold()
    }
  }, [gl, camera, controls])

  return null
}

export default Gestures
