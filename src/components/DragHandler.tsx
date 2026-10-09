import { beginTransformGesture, cancelTransformGesture, finishTransformGesture, notifyLockedSelection } from '../utils/transformGesture'
import React, { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { useToolStore } from '../store/useToolStore'
import { isObjectVisible } from '../store/useViewStore'
import { withFixedProfileCuts } from '../utils/jointUtils'
import { reportEditResult } from '../utils/editFeedback'
import type { EditResult } from '../utils/openingBindings'
import { useStore, type ConnectorData, type EquipmentData, type FittingData, type PanelData, type ProfileData } from '../store/useStore'
import { getProfileDir } from '../utils/geometryCore'
import { closestParamLineToRay } from '../utils/pickUtils'
import { computeDragSnap, alignThreshold, ALIGN_PX, snapProfilePosition, type Axis3 } from '../utils/dragSnap'
import { pixelsToWorld } from './ResizeHandles'
import { MIN_LENGTH } from '../utils/profileFactory'
import { movingPartsConflict } from '../utils/analysis'
import { lowestPointY } from '../utils/profileFactory'
import { roundToGrid } from '../utils/specUtils'
import { equipmentBody } from '../utils/equipmentGeometry'
import { connectorTransformUpdates } from '../utils/connectorEdits'
import { snapDraggedConnector } from '../utils/connectorRecovery'

/** An axis arrow makes measured adjustments, so its snap window stays tight. */
const AXIS_SNAP_MAX_MM = 12
/** a press near an end face only starts a stretch once the pointer travels this far */
const RESIZE_SLOP_PX = 4

/** How far the group would sink below the floor at the given offset (0 when clear) */
function groupSink(profiles: ProfileData[], equipment: EquipmentData[], origins: Record<string, [number, number, number]>, delta: THREE.Vector3): number {
  let sink = 0
  for (const p of profiles) {
    const origin = origins[p.id] ?? p.position
    const moved = { ...p, position: [origin[0] + delta.x, origin[1] + delta.y, origin[2] + delta.z] as [number, number, number] }
    sink = Math.min(sink, lowestPointY(moved))
  }
  for (const e of equipment) {
    const box = equipmentBody({ ...e, position: origins[e.id] ?? e.position })
    const halfHeight = box.axes.reduce((sum, axis, i) => sum + Math.abs(axis.y) * box.half.getComponent(i), 0)
    sink = Math.min(sink, box.center.y + delta.y - halfHeight)
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
  const rejectedGesture = useRef('')
  const connectorSnapKey = useRef<string | null>(null)

  useEffect(() => {
    const canvas = gl.domElement
    const feedback = (result: EditResult) => {
      if (result.status !== 'rejected') { rejectedGesture.current = ''; return }
      const key = `${result.reason}:${result.partIds.join(',')}`
      if (key !== rejectedGesture.current) { rejectedGesture.current = key; reportEditResult(result) }
    }
    const finishGesture = () => {
      cancelTransformGesture()
      canvas.dispatchEvent(new Event('aluframe:consume-pointer'))
      const ts = useToolStore.getState()
      ts.stopDrag(); ts.stopResize(); ts.setDragConflict(false)
    }
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if ((state.isDragging && !previous.isDragging) || (state.resize && !previous.resize)) {
        beginTransformGesture()
        notifyLockedSelection()
      }
      if (!state.resize) resizingGesture.current = null
      if (!state.resize && !state.isDragging) rejectedGesture.current = ''
      if (state.isDragging && !previous.isDragging) {
        connectorSnapKey.current = null
        // A touch gesture can deliberately start free without a physical Shift key.
        dragBaseFree.current = state.dragFree && (!shiftHeld.current || pointerKind.current === 'touch')
      }
      if ((previous.isDragging || previous.resize) && (state.held !== previous.held
        || state.activeSpec !== previous.activeSpec || state.selectMode !== previous.selectMode
        || state.measuring !== previous.measuring || state.viewMode !== previous.viewMode)) finishGesture()
      else if ((previous.isDragging || previous.resize) && !state.isDragging && !state.resize) finishTransformGesture()
    })

    const onPointerDown = (e: PointerEvent) => {
      pointerKind.current = e.pointerType
      if (e.pointerType !== 'touch') shiftHeld.current = e.shiftKey
    }
    const editable = (target: EventTarget | null) => target instanceof HTMLElement
      && (target.isContentEditable || !!target.closest('input, textarea, select'))
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editable(e.target)) {
        const ts = useToolStore.getState()
        if (ts.isDragging || ts.resize) finishGesture()
        return
      }
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
      const store = useStore.getState()
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
        // Prepare physical cuts locally. Rejection must not freeze the real document.
        profile = withFixedProfileCuts(store.profiles, undefined, store.throughRule).find((p) => p.id === rs.id)!
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
      const result = store.updateProfile(rs.id, { length, position }, { history: !ts.dragMoved })
      feedback(result)
      if (result.status === 'applied') { resizingGesture.current = rs; ts.markDragMoved() }
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
      const store = useStore.getState()
      const leadPart = store.profiles.find((p) => p.id === dragProfileId)
        ?? store.connectors.find((c) => c.id === dragProfileId)
        ?? store.panels.find((b) => b.id === dragProfileId)
        ?? store.fittings.find((f) => f.id === dragProfileId)
        ?? store.equipment.find((part) => part.id === dragProfileId)
      if (!leadPart || leadPart.locked) { ts.stopDrag(); return }

      const ids = Object.keys(dragGroupOrigins)
      const dragIds = new Set(ids.length ? ids : [dragProfileId])

      const startThreshold = dragKind === 'connector' && dragIds.size === 1 ? 0.05 : 0.5
      if (!ts.dragMoved && delta.lengthSq() <= startThreshold ** 2) return
      // Snapping uses physical cuts, but the document changes only after validation.
      const all = store.profiles.some((p) => dragIds.has(p.id) && !p.locked)
        ? withFixedProfileCuts(store.profiles, undefined, store.throughRule) : store.profiles
      const others = all.filter((p) => !dragIds.has(p.id) && isObjectVisible(p.id))
      const single = dragIds.size === 1

      // Group delta: snap the grabbed member, then apply the same offset to everything
      const lead = all.find((p) => p.id === dragProfileId)
      const leadOrigin = new THREE.Vector3(...(dragGroupOrigins[dragProfileId] ?? dragOriginPos.toArray()))
      const leadNew = leadOrigin.clone().add(delta)
      const lockedAxis = ts.dragAxis ? { x: 0, y: 1, z: 2 }[ts.dragAxis] as Axis3 : null
      const allowedAxes: Axis3[] = lockedAxis !== null ? [lockedAxis] : dragVertical ? [1] : [0, 2]
      for (const axis of allowedAxes) {
        const key = (['x', 'y', 'z'] as const)[axis]
        leadNew[key] = single && dragKind === 'connector' ? Math.round(leadNew[key] * 10) / 10 : roundToGrid(leadNew[key])
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
      let connectorSnap: ReturnType<typeof snapDraggedConnector> = null
      if (single && dragKind === 'connector' && !ts.dragFree) {
        const connector = store.connectors.find((part) => part.id === dragProfileId)
        if (connector) {
          const distance = leadOrigin.distanceTo(new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld))
          const threshold = ts.dragAxis ? AXIS_SNAP_MAX_MM
            : Math.max(6, Math.min(24, pixelsToWorld(ALIGN_PX, distance, camera, size.height)))
          connectorSnap = snapDraggedConnector(connector, leadNew, leadOrigin, all, store.connectors, allowedAxes, threshold,
            { equipment: store.equipment, panels: store.panels, fittings: store.fittings,
              seatFilter: (_seat, supportIds) => supportIds.every(isObjectVisible) }, connectorSnapKey.current)
          connectorSnapKey.current = connectorSnap?.key ?? null
          if (connectorSnap) groupDelta.copy(new THREE.Vector3(...connectorSnap.seat.position).sub(leadOrigin))
        }
      } else connectorSnapKey.current = null

      // Alignment: unless Shift asks for free placement, pull the group onto the faces,
      // edges and centrelines of the surrounding profiles.
      // An endpoint join is the more specific intent, so it is left alone.
      if (connectorSnap) {
        ts.setSnapRefs(connectorSnap.legs ?? [])
        ts.setSnapGuides([])
      } else if (joinedAtEndpoint) {
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
      const sink = groupSink(dragged, store.equipment.filter((part) => dragIds.has(part.id) && !part.locked), dragGroupOrigins, groupDelta)
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
        const pose = { position: [np.x, np.y, np.z] as ConnectorData['position'],
          ...(connectorSnap ? { quaternion: connectorSnap.seat.quaternion } : {}) }
        connectorUpdates.push({ id: cid,
          updates: { ...connectorTransformUpdates(c, pose, new Set(dragged.map((p) => p.id))),
            ...(connectorSnap ? { series: connectorSnap.seat.series, profileSpec: connectorSnap.seat.profileSpec,
              mountSeries: connectorSnap.seat.mountSeries } : {}) } })
      }
      const panelUpdates: Array<{ id: string; updates: Partial<PanelData> }> = []
      for (const bid of dragIds) {
        const b = store.panels.find((q) => q.id === bid)
        if (!b || b.locked) continue
        const origin = new THREE.Vector3(...(dragGroupOrigins[bid] ?? b.position))
        const np = origin.clone().add(groupDelta)
        panelUpdates.push({ id: bid, updates: { position: [np.x, np.y, np.z] } })
      }

      // Apply the same group translation to fittings.
      const fittingUpdates: Array<{ id: string; updates: Partial<FittingData> }> = []
      for (const fid of dragIds) {
        const f = store.fittings.find((q) => q.id === fid)
        if (!f || f.locked) continue
        const origin = new THREE.Vector3(...(dragGroupOrigins[fid] ?? f.position))
        const np = origin.clone().add(groupDelta)
        fittingUpdates.push({ id: fid, updates: { position: [np.x, np.y, np.z] } })
      }

      const equipmentUpdates: Array<{ id: string; updates: Partial<EquipmentData> }> = []
      for (const part of store.equipment) if (dragIds.has(part.id) && !part.locked) {
        const np = new THREE.Vector3(...(dragGroupOrigins[part.id] ?? part.position)).add(groupDelta)
        equipmentUpdates.push({ id: part.id, updates: { position: [np.x, np.y, np.z] } })
      }
      // Publish the complete move once per frame, with collision feedback in the viewport.
      const result = store.updateParts({ profiles: updates, connectors: connectorUpdates, panels: panelUpdates, fittings: fittingUpdates, equipment: equipmentUpdates }, { history: !ts.dragMoved })
      feedback(result)
      if (result.status === 'applied') ts.markDragMoved()
      if (result.status === 'rejected') { ts.setSnapRefs([]); ts.setSnapGuides([]) }
      ts.setDragConflict(movingPartsConflict(useStore.getState().profiles, new Set(updates.map((u) => u.id))))
    }

    const onPointerMove = (e: PointerEvent) => applyDrag(e)

    const onPointerUp = (e: PointerEvent) => {
      const ts = useToolStore.getState()
      if (ts.resize) {
        applyResize(e)
        resizingGesture.current = null
        finishTransformGesture()
        useToolStore.getState().stopResize()
        useToolStore.getState().setDragConflict(false)
        return
      }
      if (!ts.isDragging) return
      // Browsers coalesce pointermove events per frame; make sure the release position is applied
      if (ts.dragMoved) applyDrag(e)
      finishTransformGesture()
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
