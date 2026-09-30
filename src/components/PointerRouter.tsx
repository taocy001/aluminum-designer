import React, { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { pickAtScreen, pickCandidatesAtScreen, type ScreenPick } from '../utils/screenPick'
import { frontmostId, promoteFrontmost } from '../utils/frontmost'
import { getProfileEndpoints, getProfileDir } from '../utils/geometryCore'
import { endGrabRadius } from './ResizeHandles'
import { gizmoState, gizmoHandleAt } from './TransformGizmo'
import { rotateSelected, selectConnected } from '../utils/editOps'
import { setFittingOpen } from '../utils/fittingOps'
import { translations } from '../utils/translations'
import { memberBox } from '../utils/dragSnap'
import { acceptSuggestion, dismissSuggestion } from '../utils/suggestOps'
import { profileBodyEndpoints } from '../utils/profileFaces'
import { computeAllTrims, type ProfileTrims } from '../utils/jointUtils'

/** Where a ray meets a level plane at height `y`, or null when it runs parallel to it */
function planeHit(ray: THREE.Ray, y: number): THREE.Vector3 | null {
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y)
  const at = new THREE.Vector3()
  return ray.intersectPlane(plane, at) ? at : null
}

const CLICK_SLOP_PX = 5

/** Any movable part by id — members, connectors and boards all carry a position */
type StoreLike = ReturnType<typeof useStore.getState>
const partById = (store: StoreLike, id: string) =>
  store.profiles.find((p) => p.id === id)
  ?? store.connectors.find((c) => c.id === id)
  ?? store.panels.find((b) => b.id === id)
  // A drawer or a door is a part like any other and moves like one. Leaving it out of this
  // lookup meant the drag found nothing to move and gave up without a word.
  ?? store.fittings.find((f) => f.id === id)

/**
 * Handle hover, selection and drag start using screen-space picking.
 * Clear selection on release so camera orbit gestures retain it.
 */
const PointerRouter: React.FC = () => {
  const { gl, camera, size, controls, scene } = useThree()
  // kept in refs, not in the effect closure: R3F recreates that closure between pointer events
  const pendingClear = useRef<{ x: number; y: number; keepSelection: boolean } | null>(null)
  const pendingSelect = useRef<{ x: number; y: number; id: string; multi: boolean } | null>(null)
  /** draw mode: a press that landed on a member, waiting to see whether it becomes a drag */
  const pendingDrawDrag = useRef<{ x: number; y: number; id: string; point: THREE.Vector3; shift: boolean; alt: boolean } | null>(null)
  /** a press that landed on a rotation arc, waiting for the release */
  const pendingRotate = useRef<{ x: number; y: number; axis: 'x' | 'y' | 'z'; shift: boolean } | null>(null)
  /** a left press while a suggestion is showing: on its ghost or not, decided on release */
  const pendingSuggest = useRef<{ x: number; y: number; onGhost: boolean } | null>(null)
  /**
   * Everything under the cursor and which of them Tab has stepped to. In a dense frame the
   * nearest part is often not the one meant, and nudging the camera until the right one is
   * in front is not an interaction. The list is rebuilt whenever the pointer really moves.
   */
  const candidates = useRef<{ x: number; y: number; list: ScreenPick[]; index: number }>({ x: 0, y: 0, list: [], index: 0 })
  const trimCache = useRef<{ profiles: StoreLike['profiles']; throughRule: StoreLike['throughRule']; trims: Map<string, ProfileTrims> } | null>(null)

  useEffect(() => {
    const canvas = gl.domElement
    const raycaster = new THREE.Raycaster()
    const orbit = controls as { enabled?: boolean } | null
    const trimsFor = (store: StoreLike) => {
      const cached = trimCache.current
      if (cached?.profiles === store.profiles && cached.throughRule === store.throughRule) return cached.trims
      const trims = computeAllTrims(store.profiles)
      trimCache.current = { profiles: store.profiles, throughRule: store.throughRule, trims }
      return trims
    }

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

    /** An end belongs to the resolved pointer target, including an explicit Tab choice.
     * Picking the selected member in isolation lets its hidden end steal another member's
     * drag, even while the hover correctly highlights that other member. */
    const selectedEndAt = (hit: ScreenPick | null): 'start' | 'end' | null => {
      const store = useStore.getState()
      if (!hit || hit.kind !== 'profile' || store.selectedIds.length !== 1) return null
      const only = store.profiles.find((p) => p.id === store.selectedIds[0])
      if (!only || only.locked || hit.id !== only.id) return null
      const { start, end } = profileBodyEndpoints(only, trimsFor(store).get(only.id))
      const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld)
      const zone = endGrabRadius(start.distanceTo(end), hit.point.distanceTo(camPos), camera, size.height)
      return hit.point.distanceTo(start) < zone ? 'start' : hit.point.distanceTo(end) < zone ? 'end' : null
    }

    /** Everything under the pointer, with whatever is actually drawn there put first */
    const candidatesFor = (cursor: THREE.Vector2, rect: DOMRect) => {
      const ray = rayOf(cursor, rect)
      const store = useStore.getState()
      const { profiles, connectors, panels, fittings } = store
      // put away is put away: a hidden door is not something you can click either
      const visible = useToolStore.getState().showFittings ? fittings : []
      const list = pickCandidatesAtScreen(cursor, ray, camera, { width: rect.width, height: rect.height },
        profiles, connectors, panels, visible, trimsFor(store))
      return promoteFrontmost(list, frontmostId(scene, ray, camera))
    }
    /** Reuse the same visible/Tab target for hover, handle precedence and pointerdown. */
    const resolvePointer = (e: PointerEvent, enabled = true) => {
      const { cursor, rect } = cursorOf(e)
      const list = enabled ? candidatesFor(cursor, rect) : []
      const previous = candidates.current
      const stayed = Math.hypot(e.clientX - previous.x, e.clientY - previous.y) <= 3
      const chosen = stayed && previous.index > 0 ? previous.list[previous.index] : null
      // Retain the part itself, rather than its old index, if candidate ordering changes.
      const index = chosen ? Math.max(0, list.findIndex((p) => p.id === chosen.id && p.kind === chosen.kind)) : 0
      candidates.current = { x: e.clientX, y: e.clientY, list, index }
      return { cursor, rect, pick: list[index] ?? null, index, list }
    }
    const showPointerTarget = (pick: ScreenPick | null) => {
      const ts = useToolStore.getState()
      ts.setHoverProfile(pick?.kind === 'profile' ? pick.id : null)
      ts.setHoverPart(pick?.id ?? null)
      ts.setHoverEnd(ts.held === null ? selectedEndAt(pick) : null)
      ts.setHoverCandidates(candidates.current.list.length, candidates.current.index)
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
      if (ts.isDragging || ts.selectMode) { ts.setHoverProfile(null); ts.setHoverPart(null); ts.setHoverEnd(null); ts.setGizmoHover(null); return }
      // Skip hover projection during camera orbit or pan.
      if (e.buttons !== 0 && !ts.isDrawing) return

      // A half-drawn line owns the pointer, and a connector in hand is aimed at a surface
      // rather than at a part; otherwise the hover works the same whatever is in hand.
      const busy = ts.isDrawing || ts.held === 'connector'
      const pointer = resolvePointer(e, !busy)
      // A visible selected end, or a deliberate Tab choice, wins over the gizmo. Other
      // explicit gizmo handles keep their normal precedence over member bodies.
      const handle = selectedEndAt(pointer.pick) || pointer.index > 0 || e.ctrlKey || e.metaKey || e.altKey
        ? null : gizmoHandleAt(rayOf(pointer.cursor, pointer.rect))
      ts.setGizmoHover(handle)
      if (handle) {
        ts.setHoverProfile(null); ts.setHoverPart(null); ts.setHoverEnd(null)
        ts.setHoverCandidates(0, 0)
        return
      }
      showPointerTarget(pointer.pick)
    }

    const onPointerLeave = () => {
      const ts = useToolStore.getState()
      ts.setHoverProfile(null)
      ts.setHoverPart(null)
      ts.setHoverEnd(null)
      ts.setHoverCandidates(0, 0)
      candidates.current = { x: 0, y: 0, list: [], index: 0 }
    }

    /**
     * A double click means "this, closer in", and it has to mean that everywhere.
     *
     * It used to mean two things: closer in over empty space, and take-the-sub-assembly over
     * a member — so whether it zoomed depended on whether you had happened to land on metal,
     * which is exactly the part you were trying to get closer to. Now it always comes in, at
     * whatever the pointer is over. Where the ray finds nothing it falls back to the work
     * plane, and only then to the floor, so a double click while looking at wall units does
     * not send the camera off to a point on the ground metres below them.
     */
    const onDoubleClick = (e: MouseEvent) => {
      const ts = useToolStore.getState()
      if (ts.held !== null || ts.selectMode) return
      const { cursor, rect } = cursorOf(e as unknown as PointerEvent)
      const ray = rayOf(cursor, rect)
      const store = useStore.getState()
      const hit = pickAtScreen(cursor, ray, camera, { width: rect.width, height: rect.height },
        store.profiles, store.connectors, store.panels, store.fittings, trimsFor(store))
      let target = hit?.point?.clone() ?? null
      if (!target) {
        // Nothing under the pointer. Falling through to the floor sends the camera off to
        // a spot metres below whatever you were looking at, which is why this used to feel
        // like it had missed. Stay at the depth you are already looking at instead, so the
        // view comes in on the sky beside a wall unit rather than on the ground under it.
        const orbit3 = orbit as any
        const dir = camera.getWorldDirection(new THREE.Vector3())
        const depth = orbit3?.target ? orbit3.target.clone().sub(camera.position).dot(dir) : 0
        target = depth > 1
          ? ray.origin.clone().addScaledVector(ray.direction, depth / Math.max(0.1, ray.direction.dot(dir)))
          : planeHit(ray, ts.workPlaneY) ?? planeHit(ray, 0)
      }
      if (target) ts.zoomToPoint([target.x, target.y, target.z])
    }

    /** Move the orbit target along the centre sight line to the depth of the visible object. */
    const aimPivot = () => {
      const orbit2 = orbit as any
      if (!orbit2?.target) return
      const rect = gl.domElement.getBoundingClientRect()
      const middle = new THREE.Vector2(0, 0)
      const ray = new THREE.Raycaster()
      ray.setFromCamera(middle, camera)
      const store = useStore.getState()
      const hit = pickAtScreen(
        new THREE.Vector2(rect.width / 2, rect.height / 2), ray.ray, camera,
        { width: rect.width, height: rect.height }, store.profiles, store.connectors, store.panels, store.fittings, trimsFor(store),
      )
      const dir = camera.getWorldDirection(new THREE.Vector3())
      let depth: number | null = null
      if (hit?.point) {
        depth = hit.point.clone().sub(camera.position).dot(dir)
      } else {
        // nothing dead ahead: use the middle of what is actually on screen
        const box = new THREE.Box3()
        for (const p of store.profiles) box.union(memberBox(p))
        for (const b of store.panels) box.expandByPoint(new THREE.Vector3(...b.position))
        if (!box.isEmpty()) depth = box.getCenter(new THREE.Vector3()).sub(camera.position).dot(dir)
      }
      if (depth === null || !isFinite(depth) || depth < 1) return
      orbit2.target.copy(camera.position.clone().addScaledVector(dir, depth))
      orbit2.update()
    }

    const onPointerDown = (e: PointerEvent) => {
      const ts = useToolStore.getState()
      if (e.button !== 0) return

      // Measuring owns the click: the point under the pointer, snapped the way drawing snaps
      if (ts.measuring) {
        const { cursor, rect } = cursorOf(e)
        const hit = candidatesFor(cursor, rect)[0]
        const at = hit?.point?.clone() ?? planeHit(rayOf(cursor, rect), ts.workPlaneY)
        if (at) useToolStore.getState().setMeasurePoint(at)
        return
      }

      // While looking, a press opens or shuts whatever it lands on and nothing else happens.
      // Turning the view still works, which is most of what looking is.
      if (ts.viewMode) {
        // while looking, the press means the nearest drawer or door, whatever else is nearer
        const { cursor, rect } = cursorOf(e)
        const hit = candidatesFor(cursor, rect).find((p) => p.kind === 'fitting')
        if (hit) {
          const f = useStore.getState().fittings.find((q) => q.id === hit.id)
          if (f) { setFittingOpen(f.id, (f.open ?? 0) > 0.5 ? 0 : 1); pendingClear.current = null }
        }
        return
      }

      // A suggestion is showing: a click on its ghost takes it, a click anywhere else drops
      // it (and still does whatever that click does), and a drag is the view turning.
      pendingSuggest.current = null
      if (ts.suggestion) {
        const { cursor, rect } = cursorOf(e)
        const hit = pickAtScreen(cursor, rayOf(cursor, rect), camera, { width: rect.width, height: rect.height }, [ts.suggestion.cand.member], [])
        pendingSuggest.current = { x: e.clientX, y: e.clientY, onGhost: !!hit }
        if (hit) return
      }

      // a press on a move arrow slides the selection along that axis, in either mode.
      // Ctrl/Cmd (add to selection) and Alt (plane drag) are gestures aimed at the model,
      // so they pass straight through the handles.
      const modifierHeld = e.ctrlKey || e.metaKey || e.altKey
      const pointer = resolvePointer(e)
      {
        const ray = rayOf(pointer.cursor, pointer.rect)
        const part = modifierHeld || pointer.index > 0 || selectedEndAt(pointer.pick) ? null : gizmoHandleAt(ray)
        if (part?.kind === 'move') {
          const store = useStore.getState()
          const lead = store.profiles.find((p) => store.selectedIds.includes(p.id) && !p.locked)
            ?? store.panels.find((b) => store.selectedIds.includes(b.id) && !b.locked)
            ?? store.fittings.find((f) => store.selectedIds.includes(f.id) && !f.locked)
          if (!lead) return
          const groupOrigins: Record<string, [number, number, number]> = {}
          for (const sid of store.selectedIds) {
            const part2 = partById(store, sid)
            if (!part2 || part2.locked) continue
            groupOrigins[sid] = [part2.position[0], part2.position[1], part2.position[2]]
          }
          if (Object.keys(groupOrigins).length === 0) return   // everything selected is locked
          const anchorPoint = new THREE.Vector3(...lead.position)
          beginMove(lead.id, anchorPoint, anchorPoint.clone(), groupOrigins,
            { shift: e.shiftKey, alt: false }, e, 'profile', part.axis)
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
        const hit = pointer.pick
        if (!hit || hit.kind !== 'profile') return
        pendingDrawDrag.current = { x: e.clientX, y: e.clientY, id: hit.id, point: hit.point.clone(), shift: e.shiftKey, alt: e.altKey }
        return
      }
      if (gizmoState.busy) return   // a gizmo handle owns this press (checked above)
      const multi = e.ctrlKey || e.metaKey
      const pick = pointer.pick

      // Box-select mode: a press that turns into a drag draws the box (handled in App),
      // a press that stays put still selects the member under it
      if (ts.selectMode) {
        pendingSelect.current = pick ? { x: e.clientX, y: e.clientY, id: pick.id, multi } : null
        return
      }

      // Nothing under it, so this press is about to become an orbit: put the pivot at the
      // depth of what is on screen. It has to wait until the pick has come back — aiming on
      // every press moved the target while a member was being dragged, and OrbitControls
      // then pulls the camera to keep its distance inside the limits.
      if (!pick) {
        if (!ts.selectMode && ts.held === null) aimPivot()
        pendingClear.current = { x: e.clientX, y: e.clientY, keepSelection: multi }
        return
      }
      pendingClear.current = null

      const store = useStore.getState()
      const alreadySelected = store.selectedIds.includes(pick.id)

      // Ctrl/Cmd+click only toggles the selection — it must never start a drag
      if (multi) { store.selectItem(pick.id, true); return }
      if (!alreadySelected) store.selectItem(pick.id, false)

      const item = partById(store, pick.id)
      if (!item) return

      // Start stretching only if the member was selected before this pointer press.
      if (pick.kind === 'profile' && alreadySelected) {
        const profile = store.profiles.find((p) => p.id === pick.id)!
        const { start, end } = getProfileEndpoints(profile)
        const grabEnd = selectedEndAt(pick)
        if (grabEnd && !profile.locked && store.selectedIds.length === 1) {
          // the length the press itself implies, so the member does not jump by the
          // distance between the press point and the end face
          const dir = getProfileDir(profile)
          const fixed = grabEnd === 'start' ? end : start
          const grabbed = pick.point.clone().sub(fixed).dot(dir)
          useToolStore.getState().startResize({
            id: profile.id, end: grabEnd,
            origin: [profile.position[0], profile.position[1], profile.position[2]],
            length: profile.length,
            grabLength: grabEnd === 'start' ? -grabbed : grabbed,
            downX: e.clientX, downY: e.clientY,
          })
          if (orbit) orbit.enabled = false
          return
        }
      }
      // A connector is not draggable. Between two aligned members there is one bracket that
      // fits and one way it goes on, so dragging it can only move it off the joint — and a
      // bracket sitting next to a joint still looks fitted, which is worse than none at all.
      // A press still selects it, which is what deleting one needs.
      if (pick.kind === 'connector' && store.selectedIds.length === 1) return

      // dragging any selected part moves the whole selection, members and boards alike.
      // Locked parts drop out of the group instead of blocking the drag: the rest still moves.
      if ('locked' in item && item.locked) { useToolStore.getState().showToast(translations[useToolStore.getState().language].toastLocked, 'info'); return }
      const dragGroup = store.selectedIds.includes(pick.id) ? store.selectedIds : [pick.id]
      const groupOrigins: Record<string, [number, number, number]> = {}
      for (const sid of dragGroup) {
        const part = partById(store, sid)
        if (part && !part.locked) {
          groupOrigins[sid] = [part.position[0], part.position[1], part.position[2]]
        }
      }

      // a board moves the same way a connector does: position only, no snapping to endpoints
      beginMove(pick.id, pick.point, new THREE.Vector3(...item.position), groupOrigins,
        { shift: e.shiftKey, alt: e.altKey }, e, pick.kind === 'profile' ? 'profile' : 'connector')
    }

    const onPointerUp = (e: PointerEvent) => {
      if (useToolStore.getState().viewMode) { consumePointer(); return }
      pendingDrawDrag.current = null

      const sg = pendingSuggest.current
      pendingSuggest.current = null
      if (sg && e.button === 0 && Math.hypot(e.clientX - sg.x, e.clientY - sg.y) <= CLICK_SLOP_PX) {
        if (sg.onGhost) { acceptSuggestion(); return }
        dismissSuggestion()
      }

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
      const target = e.target as HTMLElement | null
      if (target?.closest('input,textarea,select,button,[contenteditable="true"]')) return
      const c = candidates.current
      if (c.list.length < 2) return
      e.preventDefault()
      c.index = (c.index + (e.shiftKey ? c.list.length - 1 : 1)) % c.list.length
      const pick = c.list[c.index]
      const ts = useToolStore.getState()
      ts.setGizmoHover(null)
      showPointerTarget(pick)
    }
    window.addEventListener('keydown', onKey)

    const consumePointer = () => {
      pendingClear.current = null
      pendingSelect.current = null
      pendingDrawDrag.current = null
      pendingRotate.current = null
      pendingSuggest.current = null
      gizmoState.busy = false
      const ts = useToolStore.getState()
      ts.stopDrag()
      ts.stopResize()
      if (orbit) orbit.enabled = !ts.selectMode
    }
    canvas.addEventListener('aluframe:consume-pointer', consumePointer)
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (state.viewMode && !previous.viewMode) consumePointer()
    })

    canvas.addEventListener('dblclick', onDoubleClick)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointerleave', onPointerLeave)
    window.addEventListener('pointerup', onPointerUp)
    return () => {
      unsubscribe()
      window.removeEventListener('keydown', onKey)
      canvas.removeEventListener('aluframe:consume-pointer', consumePointer)
      canvas.removeEventListener('dblclick', onDoubleClick)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      window.removeEventListener('pointerup', onPointerUp)
    }
  }, [gl, camera, size, controls])

  return null
}

export default PointerRouter
