import React, { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { useToolStore } from '../store/useToolStore'
import { noteNext } from '../utils/opLog'
import { useStore, type ConnectorData, type FittingData, type PanelData, type ProfileData } from '../store/useStore'
import { getProfileDir } from '../utils/geometryCore'
import { closestParamLineToRay } from '../utils/pickUtils'
import { computeDragSnap, alignThreshold, ALIGN_PX, snapProfilePosition, type Axis3 } from '../utils/dragSnap'
import { pixelsToWorld } from './ResizeHandles'
import { MIN_LENGTH } from '../utils/profileFactory'
import { movingPartsConflict } from '../utils/analysis'
import { lowestPointY } from '../utils/profileFactory'
import { roundToGrid } from '../utils/specUtils'

/** An axis arrow makes measured adjustments, so its snap window stays tight. */
const AXIS_SNAP_MAX_MM = 12
/** a press near an end face only starts a stretch once the pointer travels this far */
const RESIZE_SLOP_PX = 4

/** How far the group would sink below the floor at the given offset (0 when clear) */
function groupSink(profiles: ProfileData[], origins: Record<string, [number, number, number]>, delta: THREE.Vector3): number {
  let sink = 0
  for (const p of profiles) {
    const origin = origins[p.id] ?? p.position
    const moved = { ...p, position: [origin[0] + delta.x, origin[1] + delta.y, origin[2] + delta.z] as [number, number, number] }
    sink = Math.min(sink, lowestPointY(moved))
  }
  return sink
}

const DragHandler: React.FC = () => {
  const { gl, camera, size } = useThree()
  // gesture state lives in refs: the effect below is re-created whenever R3F state changes,
  // so anything kept in its closure would be lost between two pointer events
  const resizingGesture = useRef<ReturnType<typeof useToolStore.getState>['resize']>(null)
  const shiftHeld = useRef(false)
  const dragBaseFree = useRef(false)
  const pointerKind = useRef('mouse')

  useEffect(() => {
    const canvas = gl.domElement
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (!state.resize) resizingGesture.current = null
      if (state.isDragging && !previous.isDragging) {
        // A touch gesture can deliberately start free without a physical Shift key.
        dragBaseFree.current = state.dragFree && (!shiftHeld.current || pointerKind.current === 'touch')
      }
    })

    const onPointerDown = (e: PointerEvent) => {
      pointerKind.current = e.pointerType
      if (e.pointerType !== 'touch') shiftHeld.current = e.shiftKey
    }
    const editable = (target: EventTarget | null) => target instanceof HTMLElement
      && (target.isContentEditable || !!target.closest('input, textarea, select'))
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Shift' || e.repeat || editable(e.target)) return
      shiftHeld.current = true
      const ts = useToolStore.getState()
      if (!ts.isDragging) return
      ts.setDragFree(true)
      // Feedback responds to the key itself, even while the pointer is stationary.
      ts.setSnapRefs([])
      ts.setSnapGuides([])
    }
    const releaseShift = () => {
      if (!shiftHeld.current) return
      shiftHeld.current = false
      const ts = useToolStore.getState()
      if (ts.isDragging) ts.setDragFree(dragBaseFree.current)
    }
    const onKeyUp = (e: KeyboardEvent) => { if (e.key === 'Shift' && !e.shiftKey) releaseShift() }

    const rayFor = (e: { clientX: number; clientY: number }) => {
      const rect = canvas.getBoundingClientRect()
      const raycaster = new THREE.Raycaster()
      raycaster.setFromCamera(new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      ), camera)
      return raycaster.ray
    }


    /** Stretch a member along its own axis by dragging one of its end faces */
    const applyResize = (e: { clientX: number; clientY: number }): boolean => {
      const ts = useToolStore.getState()
      const rs = ts.resize
      if (!rs) return false
      let store = useStore.getState()
      let profile = store.profiles.find((p) => p.id === rs.id)
      if (!profile) return false
      if (ts.viewMode || profile.locked) {
        ts.stopResize()
        ts.setDragConflict(false)
        return true
      }

      const dir = getProfileDir(profile)
      const origin = new THREE.Vector3(...rs.origin)
      const fixed = rs.end === 'start' ? origin.clone().addScaledVector(dir, rs.length) : origin.clone()
      const t = closestParamLineToRay(fixed, dir, rayFor(e))
      if (t === null) return true

      // A click near an end face must not resize anything: wait for real pointer travel,
      // and keep the offset between the press point and the end so nothing jumps.
      if (resizingGesture.current !== rs) {
        if (Math.hypot(e.clientX - rs.downX, e.clientY - rs.downY) <= RESIZE_SLOP_PX) return true
        resizingGesture.current = rs
        store.snapshotHistory()
        store.freezeProfileCuts()
        store = useStore.getState()
        profile = store.profiles.find((p) => p.id === rs.id)!
        ts.markDragMoved()   // the gesture now owns a history entry; an exact commit must not add a second
      }

      const signed = rs.end === 'start' ? -t : t
      const raw = signed + (rs.length - rs.grabLength)   // press offset carried along
      const minimum = Math.max(MIN_LENGTH, MIN_LENGTH + (profile.fixedTrims?.start ?? 0) + (profile.fixedTrims?.end ?? 0))
      let length = Math.max(minimum, roundToGrid(raw))

      const posFor = (len: number): [number, number, number] => rs.end === 'start'
        ? [fixed.x - dir.x * len, fixed.y - dir.y * len, fixed.z - dir.z * len]
        : [fixed.x, fixed.y, fixed.z]

      // the floor limits how far the grabbed end can go; the fixed end must not move
      let position = posFor(length)
      const sink = lowestPointY({ ...profile, length, position })
      if (sink < 0) {
        const dirY = rs.end === 'start' ? -dir.y : dir.y
        if (Math.abs(dirY) > 1e-6) {
          length = Math.max(minimum, length - Math.abs(sink / dirY))
          position = posFor(length)
        }
      }
      store.updateProfile(rs.id, { length, position })
      ts.setDragConflict(movingPartsConflict(useStore.getState().profiles, new Set([rs.id])))
      return true
    }

    const applyDrag = (e: { clientX: number; clientY: number }) => {
      if (useToolStore.getState().viewMode) return
      if (applyResize(e)) return
      const ts = useToolStore.getState()
      const { isDragging, dragKind, dragProfileId, dragStartHit, dragOriginPos, dragGroupOrigins, dragPlane, dragVertical } = ts
      if (!isDragging || !dragProfileId || !dragStartHit || !dragOriginPos || !dragPlane) return

      const rect = canvas.getBoundingClientRect()
      const x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      const y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      const raycaster = new THREE.Raycaster()
      raycaster.setFromCamera(new THREE.Vector2(x, y), camera)
      const hit = new THREE.Vector3()
      if (!raycaster.ray.intersectPlane(dragPlane, hit)) return

      const delta = hit.clone().sub(dragStartHit)
      if (dragVertical) { delta.x = 0; delta.z = 0 } else { delta.y = 0 }
      // a gizmo arrow constrains the move to its own axis
      if (ts.dragAxis === 'x') { delta.y = 0; delta.z = 0 }
      if (ts.dragAxis === 'z') { delta.x = 0; delta.y = 0 }
      let store = useStore.getState()
      const leadPart = store.profiles.find((p) => p.id === dragProfileId)
        ?? store.connectors.find((c) => c.id === dragProfileId)
        ?? store.panels.find((b) => b.id === dragProfileId)
        ?? store.fittings.find((f) => f.id === dragProfileId)
      if (!leadPart || leadPart.locked) { ts.stopDrag(); return }

      const ids = Object.keys(dragGroupOrigins)
      const dragIds = new Set(ids.length ? ids : [dragProfileId])

      if (!ts.dragMoved) {
        if (delta.lengthSq() <= 0.25) return
        // First real movement: record one undo entry for the whole drag
        ts.markDragMoved()
        store.snapshotHistory()
        // A move is a rigid transformation. Freeze the existing cut faces before
        // choosing a snap, so the reference cannot stretch underneath the pointer.
        if (store.profiles.some((p) => dragIds.has(p.id) && !p.locked)) {
          store.freezeProfileCuts()
          store = useStore.getState()
        }
      }
      const all = store.profiles
      const others = all.filter((p) => !dragIds.has(p.id))
      const single = dragIds.size === 1

      // Group delta: snap the grabbed member, then apply the same offset to everything
      const lead = all.find((p) => p.id === dragProfileId)
      const leadOrigin = new THREE.Vector3(...(dragGroupOrigins[dragProfileId] ?? dragOriginPos.toArray()))
      const leadNew = leadOrigin.clone().add(delta)
      const lockedAxis = ts.dragAxis ? { x: 0, y: 1, z: 2 }[ts.dragAxis] as Axis3 : null
      const allowedAxes: Axis3[] = lockedAxis !== null ? [lockedAxis] : dragVertical ? [1] : [0, 2]
      for (const axis of allowedAxes) {
        const key = (['x', 'y', 'z'] as const)[axis]
        leadNew[key] = roundToGrid(leadNew[key])
      }
      // Centreline joins require a fresh cut. Finished parts align their real faces
      // below instead; coincident perpendicular end centres would make them overlap.
      const endpointSnap = single && lead && !lead.fixedTrims && dragKind === 'profile' && !ts.dragFree
        ? snapProfilePosition(lead, leadNew, others, camera, size, lockedAxis, allowedAxes)
        : { position: leadNew, refId: null }
      const snapped = endpointSnap.position
      const joinedAtEndpoint = endpointSnap.refId !== null
      const groupDelta = snapped.clone().sub(leadOrigin)

      const dragged = all.filter((p) => dragIds.has(p.id) && !p.locked)

      // Alignment: unless Shift asks for free placement, pull the group onto the faces,
      // edges and centrelines of the parts around it — frames are built flush, not near-flush.
      // An endpoint join is the more specific intent, so it is left alone.
      if (joinedAtEndpoint) {
        ts.setSnapRefs([endpointSnap.refId!])
        ts.setSnapGuides([{ axis: 0, kind: 'endpoint', coord: 0, refId: endpointSnap.refId! }])
      } else if (ts.dragFree) {
        ts.setSnapRefs([])
        ts.setSnapGuides([])
      } else {
        const proposed = new Map<string, [number, number, number]>()
        for (const p of dragged) {
          const origin = new THREE.Vector3(...(dragGroupOrigins[p.id] ?? p.position))
          const np = origin.clone().add(groupDelta)
          proposed.set(p.id, [np.x, np.y, np.z])
        }
        // the pull reaches as far on screen as it does in the model, so it is felt at any zoom
        const camDist = new THREE.Vector3(...(dragGroupOrigins[dragProfileId] ?? dragOriginPos.toArray()))
          .distanceTo(new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld))
        // an axis drag is measured, so the alignment pull is tight enough to leave it alone
        const threshold = ts.dragAxis !== null
          ? AXIS_SNAP_MAX_MM
          : alignThreshold(dragged, pixelsToWorld(ALIGN_PX, camDist, camera, size.height))
        const snap = computeDragSnap(dragged, proposed, others, threshold, ts.snapGuides, allowedAxes)
        groupDelta.add(snap.offset)
        ts.setSnapRefs(snap.refIds)
        ts.setSnapGuides(snap.guides)
      }

      // keep the whole group on or above the floor, whatever each part's orientation is,
      // and do it last so no snap can push it back under
      const sink = groupSink(dragged, dragGroupOrigins, groupDelta)
      if (sink < 0) {
        groupDelta.y -= sink
        // Lifting can change the joint and its cut ends as well as its Y plane. These
        // guides were solved before the floor correction and must not claim a false fit.
        ts.setSnapRefs([])
        ts.setSnapGuides([])
      }

      const updates: Array<{ id: string; updates: Partial<ProfileData> }> = []
      for (const pid of dragIds) {
        const p = all.find((q) => q.id === pid)
        if (!p || p.locked) continue
        const origin = new THREE.Vector3(...(dragGroupOrigins[pid] ?? p.position))
        const np = origin.clone().add(groupDelta)
        updates.push({ id: pid, updates: { position: [np.x, np.y, np.z] } })
      }
      const connectorUpdates: Array<{ id: string; updates: Partial<ConnectorData> }> = []
      for (const cid of dragIds) {
        const c = store.connectors.find((q) => q.id === cid)
        if (!c || c.locked) continue
        const origin = new THREE.Vector3(...(dragGroupOrigins[cid] ?? c.position))
        const np = origin.clone().add(groupDelta)
        connectorUpdates.push({ id: cid, updates: { position: [np.x, np.y, np.z] } })
      }
      const panelUpdates: Array<{ id: string; updates: Partial<PanelData> }> = []
      for (const bid of dragIds) {
        const b = store.panels.find((q) => q.id === bid)
        if (!b || b.locked) continue
        const origin = new THREE.Vector3(...(dragGroupOrigins[bid] ?? b.position))
        const np = origin.clone().add(groupDelta)
        panelUpdates.push({ id: bid, updates: { position: [np.x, np.y, np.z] } })
      }

      // A drawer or a door moves with the hand like anything else
      const fittingUpdates: Array<{ id: string; updates: Partial<FittingData> }> = []
      for (const fid of dragIds) {
        const f = store.fittings.find((q) => q.id === fid)
        if (!f || f.locked) continue
        const origin = new THREE.Vector3(...(dragGroupOrigins[fid] ?? f.position))
        const np = origin.clone().add(groupDelta)
        fittingUpdates.push({ id: fid, updates: { position: [np.x, np.y, np.z] } })
      }

      // Interference is allowed while moving: conflicting members turn red instead of the
      // drag silently sticking. Only the floor rule still clamps (handled above).
      // one write per frame: separate sets would re-render the scene N times and show
      // a frame where the connectors have moved but the members have not
      store.updateParts({ profiles: updates, connectors: connectorUpdates, panels: panelUpdates, fittings: fittingUpdates })
      ts.setDragConflict(movingPartsConflict(useStore.getState().profiles, new Set(updates.map((u) => u.id))))
    }

    const onPointerMove = (e: PointerEvent) => applyDrag(e)

    const onPointerUp = (e: PointerEvent) => {
      const ts = useToolStore.getState()
      if (ts.resize) {
        applyResize(e)
        resizingGesture.current = null
        useToolStore.getState().stopResize()
        useToolStore.getState().setDragConflict(false)
        return
      }
      if (!ts.isDragging) return
      // Browsers coalesce pointermove events per frame; make sure the release position is applied
      if (ts.dragMoved) applyDrag(e)
      useToolStore.getState().stopDrag()
    }

    canvas.addEventListener('pointerdown', onPointerDown, true)
    canvas.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', releaseShift)
    return () => {
      unsubscribe()
      canvas.removeEventListener('pointerdown', onPointerDown, true)
      canvas.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', releaseShift)
    }
  }, [gl, camera, size])

  return null
}

export default DragHandler
