import React, { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { pickAtScreen, pickCandidatesAtScreen, type ScreenPick } from '../utils/screenPick'
import { getProfileEndpoints, getProfileDir } from '../utils/geometryCore'
import { endGrabRadius } from './ResizeHandles'
import { gizmoState, gizmoHandleAt } from './TransformGizmo'
import { rotateSelected } from '../utils/editOps'
import { translations } from '../utils/translations'

const CLICK_SLOP_PX = 5

/** Any movable part by id — members, connectors and boards all carry a position */
type StoreLike = ReturnType<typeof useStore.getState>
const partById = (store: StoreLike, id: string) =>
  store.profiles.find((p) => p.id === id)
  ?? store.connectors.find((c) => c.id === id)
  ?? store.panels.find((b) => b.id === id)

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
  /** draw mode: a press that landed on a member, waiting to see whether it becomes a drag */
  const pendingDrawDrag = useRef<{ x: number; y: number; id: string; point: THREE.Vector3; shift: boolean; alt: boolean } | null>(null)
  /** a press that landed on a rotation arc, waiting for the release */
  const pendingRotate = useRef<{ x: number; y: number; axis: 'x' | 'y' | 'z'; shift: boolean } | null>(null)
  /**
   * Everything under the cursor and which of them Tab has stepped to. In a dense frame the
   * nearest part is often not the one meant, and nudging the camera until the right one is
   * in front is not an interaction. The list is rebuilt whenever the pointer really moves.
   */
  const candidates = useRef<{ x: number; y: number; list: ScreenPick[]; index: number }>({ x: 0, y: 0, list: [], index: 0 })

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
    /**
     * Start moving a part: the drag plane runs through the grabbed point, because an
     * upright's origin sits on the floor and a floor plane turns small cursor moves into
     * huge jumps. Shared by navigate mode and the press-on-a-member gesture in draw mode.
     */
    const beginMove = (
      id: string, grabPoint: THREE.Vector3, origin: THREE.Vector3,
      groupOrigins: Record<string, [number, number, number]>,
      mods: { shift: boolean; alt: boolean },
      e: PointerEvent,
      kind: 'profile' | 'connector' = 'profile',
      axis: 'x' | 'y' | 'z' | null = null,
    ) => {
      const { cursor, rect } = cursorOf(e)
      const ray = rayOf(cursor, rect)
      const vertical = mods.alt || axis === 'y'
      let plane: THREE.Plane
      if (axis && axis !== 'y') {
        // slide along a horizontal axis: keep the part at its own height
        plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -grabPoint.y)
      } else if (vertical) {
        const n = ray.direction.clone().negate(); n.y = 0
        if (n.lengthSq() < 1e-6) n.set(0, 0, 1)
        plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n.normalize(), grabPoint)
      } else {
        plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -grabPoint.y)
      }
      const grab = new THREE.Vector3()
      if (!ray.intersectPlane(plane, grab)) grab.copy(grabPoint)

      // OrbitControls listens on the same canvas and would start rotating before React
      // propagates enabled=false, which would move the camera mid-drag
      if (orbit) orbit.enabled = false

      useToolStore.getState().startDrag({
        id, kind, hit: grab, origin, groupOrigins, plane, vertical, free: mods.shift, axis,
      })
    }

    /**
     * True when the pointer is close enough to an end of the single selected member for that
     * end to own the press. What the end then does depends on the hand — stretch when it is
     * empty, start a new member when it holds a profile — but either way the gizmo, which is
     * centred on the member and reaches out over both ends, must step aside.
     */
    const reachingForEnd = (cursor: THREE.Vector2, rect: DOMRect, ray: THREE.Ray): boolean => {
      const store = useStore.getState()
      if (store.selectedIds.length !== 1) return false
      const only = store.profiles.find((p) => p.id === store.selectedIds[0])
      if (!only) return false
      const hit = pickAtScreen(cursor, ray, camera, { width: rect.width, height: rect.height }, [only], [])
      if (!hit || hit.id !== only.id) return false
      const { start, end } = getProfileEndpoints(only)
      const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld)
      const zone = endGrabRadius(only.length, hit.point.distanceTo(camPos), camera, size.height)
      return hit.point.distanceTo(start) < zone || hit.point.distanceTo(end) < zone
    }

    const pickFor = (e: PointerEvent) => {
      const { cursor, rect } = cursorOf(e)
      const { profiles, connectors } = useStore.getState()
      const panels = useStore.getState().panels
      return pickAtScreen(cursor, rayOf(cursor, rect), camera, { width: rect.width, height: rect.height }, profiles, connectors, panels)
    }

    const onPointerMove = (e: PointerEvent) => {
      const ts = useToolStore.getState()

      // draw mode: the press on a member turns into a move once the pointer travels
      const armed = pendingDrawDrag.current
      if (armed && !ts.isDragging) {
        if (Math.hypot(e.clientX - armed.x, e.clientY - armed.y) > CLICK_SLOP_PX) {
          const store = useStore.getState()
          const profile = store.profiles.find((p) => p.id === armed.id)
          if (profile && !profile.locked) {
            store.selectItem(armed.id, false)
            beginMove(profile.id, armed.point, new THREE.Vector3(...profile.position), { [profile.id]: [...profile.position] as [number, number, number] }, armed, e)
          }
          pendingDrawDrag.current = null
        }
        return
      }

      if (gizmoState.busy) return   // a gizmo handle is pressed; leave the model alone
      if (ts.isDragging || ts.selectMode) { ts.setHoverProfile(null); ts.setHoverEnd(null); ts.setGizmoHover(null); return }

      // reaching for an end of the selected member wins over the gizmo, which is centred on
      // it and would otherwise cover the very ends the stretch handles live on
      {
        const { cursor, rect } = cursorOf(e)
        const ray = rayOf(cursor, rect)
        if (!reachingForEnd(cursor, rect, ray) && !(e.ctrlKey || e.metaKey || e.altKey)) {
          const part = gizmoHandleAt(ray)
          ts.setGizmoHover(part)
          if (part) { ts.setHoverProfile(null); ts.setHoverEnd(null); return }
        } else {
          ts.setGizmoHover(null)
        }
      }
      // A half-drawn line owns the pointer, and a connector in hand is aimed at a surface
      // rather than at a part; otherwise the hover works the same whatever is in hand.
      const busy = ts.isDrawing || ts.held === 'connector'
      const { cursor: hc, rect: hr } = cursorOf(e)
      const list = busy ? [] : pickCandidatesAtScreen(hc, rayOf(hc, hr), camera,
        { width: hr.width, height: hr.height }, useStore.getState().profiles, useStore.getState().connectors, useStore.getState().panels)
      // a real move resets the cycle; jitter under a still hand must not
      const moved = Math.hypot(e.clientX - candidates.current.x, e.clientY - candidates.current.y) > 3
      candidates.current = {
        x: e.clientX, y: e.clientY, list,
        index: moved ? 0 : Math.min(candidates.current.index, Math.max(0, list.length - 1)),
      }
      const pick = list[candidates.current.index] ?? null
      ts.setHoverProfile(pick?.kind === 'profile' ? pick.id : null)
      ts.setHoverCandidates(list.length, candidates.current.index)

      // End faces mean two different things: with a profile in hand they are where the next
      // member starts, with an empty hand they are the stretch grip. The hand decides, so
      // the grip only offers itself when nothing is held.
      if (ts.held !== null) { ts.setHoverEnd(null); return }

      // which end face is the pointer reaching for, if any
      const store = useStore.getState()
      const only = store.selectedIds.length === 1 ? store.profiles.find((p) => p.id === store.selectedIds[0]) : undefined
      if (!only || !pick || pick.id !== only.id) { ts.setHoverEnd(null) } else {
        const { start, end } = getProfileEndpoints(only)
        const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld)
        const zone = endGrabRadius(only.length, pick.point.distanceTo(camPos), camera, size.height)
        const ds = pick.point.distanceTo(start), de = pick.point.distanceTo(end)
        ts.setHoverEnd(ds < zone ? 'start' : de < zone ? 'end' : null)
      }
    }

    const onPointerLeave = () => {
      const ts = useToolStore.getState()
      ts.setHoverProfile(null)
      ts.setHoverEnd(null)
      ts.setHoverCandidates(0, 0)
      candidates.current = { x: 0, y: 0, list: [], index: 0 }
    }

    const onPointerDown = (e: PointerEvent) => {
      const ts = useToolStore.getState()
      if (e.button !== 0) return

      // a press on a move arrow slides the selection along that axis, in either mode.
      // Ctrl/Cmd (add to selection) and Alt (plane drag) are gestures aimed at the model,
      // so they pass straight through the handles.
      const modifierHeld = e.ctrlKey || e.metaKey || e.altKey
      {
        const { cursor, rect } = cursorOf(e)
        const ray = rayOf(cursor, rect)
        const part = modifierHeld || reachingForEnd(cursor, rect, ray) ? null : gizmoHandleAt(ray)
        if (part?.kind === 'move') {
          const store = useStore.getState()
          const lead = store.profiles.find((p) => store.selectedIds.includes(p.id))
            ?? store.connectors.find((c) => store.selectedIds.includes(c.id))
            ?? store.panels.find((b) => store.selectedIds.includes(b.id))
          if (!lead) return
          const groupOrigins: Record<string, [number, number, number]> = {}
          for (const sid of store.selectedIds) {
            const part2 = partById(store, sid)
            if (part2 && !part2.locked) groupOrigins[sid] = [part2.position[0], part2.position[1], part2.position[2]]
          }
          if (Object.keys(groupOrigins).length === 0) return   // everything selected is locked
          const anchorPoint = new THREE.Vector3(...lead.position)
          beginMove(lead.id, anchorPoint, anchorPoint.clone(), groupOrigins,
            { shift: e.shiftKey, alt: false }, e,
            store.profiles.some((p) => p.id === lead.id) ? 'profile' : 'connector', part.axis)
          return
        }
        if (part?.kind === 'rotate') {
          // a click on an arc turns the selection; a drag that wanders off is ignored
          pendingRotate.current = { x: e.clientX, y: e.clientY, axis: part.axis, shift: e.shiftKey }
          gizmoState.busy = true
          return
        }
      }

      // With a part in hand a press on a member is a move, not a drawing click: the press is
      // armed here and DrawingHandler skips placing a point once the drag has started.
      if (ts.held !== null) {
        if (ts.isDrawing || ts.held !== 'profile') return
        const { cursor, rect } = cursorOf(e)
        const ray = rayOf(cursor, rect)
        const hit = pickAtScreen(cursor, ray, camera, { width: rect.width, height: rect.height }, useStore.getState().profiles, [])
        if (!hit || hit.kind !== 'profile') return
        pendingDrawDrag.current = { x: e.clientX, y: e.clientY, id: hit.id, point: hit.point.clone(), shift: e.shiftKey, alt: e.altKey }
        return
      }
      const { cursor: downCursor, rect: downRect } = cursorOf(e)
      const downRay = rayOf(downCursor, downRect)
      // Tab may have stepped past the nearest part; a press that has not moved since takes
      // the one the hover is showing, which is the one under the highlight.
      const cyc = candidates.current
      const stepped = cyc.index > 0 && Math.hypot(e.clientX - cyc.x, e.clientY - cyc.y) <= 3 ? cyc.list[cyc.index] : null
      const pickHere = stepped ?? pickAtScreen(downCursor, downRay, camera, { width: downRect.width, height: downRect.height },
        useStore.getState().profiles, useStore.getState().connectors, useStore.getState().panels)
      if (gizmoState.busy) return   // a gizmo handle owns this press (checked above)
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

      const item = pick.kind === 'connector' ? store.connectors.find((c) => c.id === pick.id)
        : pick.kind === 'panel' ? store.panels.find((b) => b.id === pick.id)
        : store.profiles.find((p) => p.id === pick.id)
      if (!item) return

      // Pressing an end face of a selected member stretches it instead of moving it
      if (pick.kind === 'profile') {
        const profile = store.profiles.find((p) => p.id === pick.id)!
        const { start, end } = getProfileEndpoints(profile)
        const nearStart = pick.point.distanceTo(start)
        const nearEnd = pick.point.distanceTo(end)
        // the zone matches the on-screen affordance, and never swallows a short member whole
        const camDist = pick.point.distanceTo(new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld))
        const zone = endGrabRadius(profile.length, camDist, camera, size.height)
        const grabEnd = nearStart < zone ? 'start' : nearEnd < zone ? 'end' : null
        if (grabEnd && !profile.locked && store.selectedIds.includes(pick.id) && store.selectedIds.length === 1) {
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
      // dragging any selected part moves the whole selection, members and connectors alike.
      // Locked parts drop out of the group instead of blocking the drag: the rest still moves.
      if ('locked' in item && item.locked) { useToolStore.getState().showToast(translations[useToolStore.getState().language].toastLocked, 'info'); return }
      const dragGroup = store.selectedIds.includes(pick.id) ? store.selectedIds : [pick.id]
      const groupOrigins: Record<string, [number, number, number]> = {}
      for (const sid of dragGroup) {
        const part = partById(store, sid)
        if (part && !part.locked) groupOrigins[sid] = [part.position[0], part.position[1], part.position[2]]
      }

      // a board moves the same way a connector does: position only, no snapping to endpoints
      beginMove(pick.id, pick.point, new THREE.Vector3(...item.position), groupOrigins,
        { shift: e.shiftKey, alt: e.altKey }, e, pick.kind === 'profile' ? 'profile' : 'connector')
    }

    const onPointerUp = (e: PointerEvent) => {
      pendingDrawDrag.current = null

      const rot = pendingRotate.current
      pendingRotate.current = null
      if (rot) {
        gizmoState.busy = false
        if (Math.hypot(e.clientX - rot.x, e.clientY - rot.y) <= CLICK_SLOP_PX) {
          rotateSelected(rot.axis, rot.shift ? -90 : 90)
        }
        return
      }

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

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const c = candidates.current
      if (c.list.length < 2) return
      e.preventDefault()
      c.index = (c.index + (e.shiftKey ? c.list.length - 1 : 1)) % c.list.length
      const pick = c.list[c.index]
      const ts = useToolStore.getState()
      ts.setHoverProfile(pick.kind === 'profile' ? pick.id : null)
      ts.setHoverCandidates(c.list.length, c.index)
    }
    window.addEventListener('keydown', onKey)

    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointerleave', onPointerLeave)
    window.addEventListener('pointerup', onPointerUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      window.removeEventListener('pointerup', onPointerUp)
    }
  }, [gl, camera, size, controls])

  return null
}

export default PointerRouter
