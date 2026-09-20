import React, { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { pickAtScreen } from '../utils/screenPick'
import { getProfileEndpoints, getProfileDir } from '../utils/geometryCore'
import { endGrabRadius } from './ResizeHandles'
import { gizmoState, gizmoOwnsRay } from './RotateGizmo'

const CLICK_SLOP_PX = 5

/**
 * Central pointer handling for navigate mode: hover highlight, selection and drag start.
 * Picking is screen-space (see screenPick) instead of an exact mesh raycast, so thin
 * members stay clickable and a miss no longer selects whatever stands behind them.
 * Clearing the selection happens on release, so orbiting the camera keeps it.
 */
const PointerRouter: React.FC = () => {
  const { gl, camera, size, controls } = useThree()
  // kept in refs, not in the effect closure: R3F recreates that closure between pointer events
  const pendingClear = useRef<{ x: number; y: number; keepSelection: boolean } | null>(null)
  const pendingSelect = useRef<{ x: number; y: number; id: string; multi: boolean } | null>(null)

  useEffect(() => {
    const canvas = gl.domElement
    const raycaster = new THREE.Raycaster()
    const orbit = controls as { enabled?: boolean } | null

    const cursorOf = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      return { cursor: new THREE.Vector2(e.clientX - rect.left, e.clientY - rect.top), rect }
    }
    const rayOf = (cursor: THREE.Vector2, rect: DOMRect) => {
      raycaster.setFromCamera(new THREE.Vector2((cursor.x / rect.width) * 2 - 1, -(cursor.y / rect.height) * 2 + 1), camera)
      return raycaster.ray.clone()   // a copy: the shared ray is overwritten by the next call
    }
    const pickFor = (e: PointerEvent) => {
      const { cursor, rect } = cursorOf(e)
      const { profiles, connectors } = useStore.getState()
      return pickAtScreen(cursor, rayOf(cursor, rect), camera, { width: rect.width, height: rect.height }, profiles, connectors)
    }

    const onPointerMove = (e: PointerEvent) => {
      const ts = useToolStore.getState()
      if (gizmoState.busy) return   // a rotation is in progress; leave the handles alone
      if (ts.viewMode !== 'navigate' || ts.isDragging || ts.selectMode) {
        ts.setHoverProfile(null)
        ts.setGizmoSuppressed(false)
        return
      }
      const pick = pickFor(e)
      ts.setHoverProfile(pick?.kind === 'profile' ? pick.id : null)
      // A part under the cursor always wins over the rotation handles: grabbing a member
      // must never turn into a rotation just because a ring happens to cross it.
      ts.setGizmoSuppressed(!!pick)
    }

    const onPointerLeave = () => {
      const ts = useToolStore.getState()
      ts.setHoverProfile(null)
      ts.setGizmoSuppressed(false)
    }

    const onPointerDown = (e: PointerEvent) => {
      const ts = useToolStore.getState()
      if (e.button !== 0 || ts.viewMode !== 'navigate') return
      const { cursor: downCursor, rect: downRect } = cursorOf(e)
      const downRay = rayOf(downCursor, downRect)
      const pickHere = pickAtScreen(downCursor, downRay, camera, { width: downRect.width, height: downRect.height }, useStore.getState().profiles, useStore.getState().connectors)
      ts.setGizmoSuppressed(!!pickHere)
      if (gizmoState.busy || (!pickHere && gizmoOwnsRay(downRay))) return   // the handles own this press
      const multi = e.ctrlKey || e.metaKey
      const pick = pickHere   // already resolved above; picking twice per press is wasted work

      // Box-select mode: a press that turns into a drag draws the box (handled in App),
      // a press that stays put still selects the member under it
      if (ts.selectMode) {
        pendingSelect.current = pick ? { x: e.clientX, y: e.clientY, id: pick.id, multi } : null
        return
      }

      if (!pick) { pendingClear.current = { x: e.clientX, y: e.clientY, keepSelection: multi }; return }
      pendingClear.current = null

      const store = useStore.getState()
      const alreadySelected = store.selectedIds.includes(pick.id)

      // Ctrl/Cmd+click only toggles the selection — it must never start a drag
      if (multi) { store.selectItem(pick.id, true); return }
      if (!alreadySelected) store.selectItem(pick.id, false)

      const item = pick.kind === 'connector'
        ? store.connectors.find((c) => c.id === pick.id)
        : store.profiles.find((p) => p.id === pick.id)
      if (!item) return

      // Pressing an end face of a selected member stretches it instead of moving it
      if (pick.kind === 'profile') {
        const profile = store.profiles.find((p) => p.id === pick.id)!
        const { start, end } = getProfileEndpoints(profile)
        const nearStart = pick.point.distanceTo(start)
        const nearEnd = pick.point.distanceTo(end)
        // the zone grows with the drawn handle, and never swallows a short member whole
        const camDist = pick.point.distanceTo(new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld))
        const zone = Math.min(endGrabRadius(camDist), profile.length / 3)
        const grabEnd = nearStart < zone ? 'start' : nearEnd < zone ? 'end' : null
        if (grabEnd && store.selectedIds.includes(pick.id) && store.selectedIds.length === 1) {
          // the length the press itself implies, so the member does not jump by the
          // distance between the press point and the end face
          const dir = getProfileDir(profile)
          const fixed = grabEnd === 'start' ? end : start
          const grabbed = pick.point.clone().sub(fixed).dot(dir)
          useToolStore.getState().startResize({
            id: profile.id, end: grabEnd,
            origin: [profile.position[0], profile.position[1], profile.position[2]],
            length: profile.length,
            grabLength: Math.abs(grabbed),
            downX: e.clientX, downY: e.clientY,
          })
          if (orbit) orbit.enabled = false
          return
        }
      }
      // dragging any selected part moves the whole selection, members and connectors alike
      const dragGroup = store.selectedIds.includes(pick.id) ? store.selectedIds : [pick.id]
      const groupOrigins: Record<string, [number, number, number]> = {}
      for (const sid of dragGroup) {
        const part = store.profiles.find((q) => q.id === sid) ?? store.connectors.find((q) => q.id === sid)
        if (part) groupOrigins[sid] = [part.position[0], part.position[1], part.position[2]]
      }

      // Drag plane through the grabbed point (not the member's origin): for an upright the
      // origin sits on the floor, and a floor plane turns small cursor moves into huge jumps.
      const ray = downRay
      const vertical = e.altKey        // Alt lifts a part straight up or down
      let plane: THREE.Plane
      if (vertical) {
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
        id: pick.id, kind: pick.kind, hit: grab, origin: new THREE.Vector3(...item.position),
        groupOrigins, plane, vertical, free: e.shiftKey,   // Shift places freely, without alignment
      })
    }

    const onPointerUp = (e: PointerEvent) => {
      const ts0 = useToolStore.getState()
      if (ts0.resize) ts0.stopResize()
      if (orbit && !ts0.isDragging) orbit.enabled = !ts0.selectMode

      if (pendingSelect.current) {
        const { x, y, id, multi } = pendingSelect.current
        pendingSelect.current = null
        if (Math.hypot(e.clientX - x, e.clientY - y) <= CLICK_SLOP_PX) useStore.getState().selectItem(id, multi)
        return
      }

      if (!pendingClear.current) return
      const { x, y, keepSelection } = pendingClear.current
      pendingClear.current = null
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
