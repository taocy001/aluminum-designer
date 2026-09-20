import React, { useEffect } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { pickAtScreen } from '../utils/screenPick'

const CLICK_SLOP_PX = 5

/**
 * Central pointer handling for navigate mode: hover highlight, selection and drag start.
 * Picking is screen-space (see screenPick) instead of an exact mesh raycast, so thin
 * members stay clickable and a miss no longer selects whatever stands behind them.
 * Clearing the selection happens on release, so orbiting the camera keeps it.
 */
const PointerRouter: React.FC = () => {
  const { gl, camera, size, controls } = useThree()

  useEffect(() => {
    const canvas = gl.domElement
    const raycaster = new THREE.Raycaster()
    const orbit = controls as { enabled?: boolean } | null
    let pendingClear: { x: number; y: number; keepSelection: boolean } | null = null
    let pendingSelect: { x: number; y: number; id: string; multi: boolean } | null = null

    const cursorOf = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      return { cursor: new THREE.Vector2(e.clientX - rect.left, e.clientY - rect.top), rect }
    }
    const rayOf = (cursor: THREE.Vector2, rect: DOMRect) => {
      raycaster.setFromCamera(new THREE.Vector2((cursor.x / rect.width) * 2 - 1, -(cursor.y / rect.height) * 2 + 1), camera)
      return raycaster.ray
    }
    const pickFor = (e: PointerEvent) => {
      const { cursor, rect } = cursorOf(e)
      const { profiles, connectors } = useStore.getState()
      return pickAtScreen(cursor, rayOf(cursor, rect), camera, { width: rect.width, height: rect.height }, profiles, connectors)
    }

    const onPointerMove = (e: PointerEvent) => {
      const ts = useToolStore.getState()
      if (ts.viewMode !== 'navigate' || ts.isDragging || ts.selectMode) { ts.setHoverProfile(null); return }
      const pick = pickFor(e)
      ts.setHoverProfile(pick?.kind === 'profile' ? pick.id : null)
    }

    const onPointerLeave = () => useToolStore.getState().setHoverProfile(null)

    const onPointerDown = (e: PointerEvent) => {
      const ts = useToolStore.getState()
      if (e.button !== 0 || ts.viewMode !== 'navigate') return
      const multi = e.ctrlKey || e.metaKey
      const pick = pickFor(e)

      // Box-select mode: a press that turns into a drag draws the box (handled in App),
      // a press that stays put still selects the member under it
      if (ts.selectMode) {
        pendingSelect = pick ? { x: e.clientX, y: e.clientY, id: pick.id, multi } : null
        return
      }

      if (!pick) { pendingClear = { x: e.clientX, y: e.clientY, keepSelection: multi }; return }
      pendingClear = null

      const store = useStore.getState()
      const alreadySelected = store.selectedIds.includes(pick.id)

      if (pick.kind === 'connector') { store.selectItem(pick.id, multi); return }
      // Ctrl/Cmd+click only toggles the selection — it must never start a drag
      if (multi) { store.selectItem(pick.id, true); return }
      if (!alreadySelected) store.selectItem(pick.id, false)

      const profile = store.profiles.find((p) => p.id === pick.id)
      if (!profile) return
      const dragGroup = store.selectedIds.includes(pick.id) ? store.selectedIds : [pick.id]
      const groupOrigins: Record<string, [number, number, number]> = {}
      for (const sid of dragGroup) {
        const p = store.profiles.find((q) => q.id === sid)
        if (p) groupOrigins[sid] = [p.position[0], p.position[1], p.position[2]]
      }

      // Drag plane through the grabbed point (not the member's origin): for an upright the
      // origin sits on the floor, and a floor plane turns small cursor moves into huge jumps.
      const { cursor, rect } = cursorOf(e)
      const ray = rayOf(cursor, rect)
      const shift = e.shiftKey
      let plane: THREE.Plane
      if (shift) {
        const n = ray.direction.clone().negate(); n.y = 0
        if (n.lengthSq() < 1e-6) n.set(0, 0, 1)
        plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n.normalize(), pick.point)
      } else {
        plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -pick.point.y)
      }
      const grab = new THREE.Vector3()
      if (!ray.intersectPlane(plane, grab)) grab.copy(pick.point)

      // OrbitControls listens on the same canvas and would start rotating before React
      // propagates enabled=false, which would move the camera mid-drag
      if (orbit) orbit.enabled = false

      useToolStore.getState().startDrag({
        id: pick.id, hit: grab, origin: new THREE.Vector3(...profile.position), groupOrigins, plane, vertical: shift,
      })
    }

    const onPointerUp = (e: PointerEvent) => {
      if (orbit && !useToolStore.getState().isDragging) orbit.enabled = !useToolStore.getState().selectMode

      if (pendingSelect) {
        const { x, y, id, multi } = pendingSelect
        pendingSelect = null
        if (Math.hypot(e.clientX - x, e.clientY - y) <= CLICK_SLOP_PX) useStore.getState().selectItem(id, multi)
        return
      }

      if (!pendingClear) return
      const { x, y, keepSelection } = pendingClear
      pendingClear = null
      // A drag of the empty background is an orbit, not a click: keep the selection.
      // Ctrl/Cmd is an additive gesture, so a stray miss must not wipe the batch either.
      if (!keepSelection && Math.hypot(e.clientX - x, e.clientY - y) <= CLICK_SLOP_PX) useStore.getState().clearSelection()
    }

    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointerleave', onPointerLeave)
    window.addEventListener('pointerup', onPointerUp)
    return () => {
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      window.removeEventListener('pointerup', onPointerUp)
    }
  }, [gl, camera, size, controls])

  return null
}

export default PointerRouter
