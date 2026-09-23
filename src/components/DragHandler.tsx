import React, { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { useToolStore } from '../store/useToolStore'
import { noteNext } from '../utils/opLog'
import { useStore, type ConnectorData, type PanelData, type ProfileData } from '../store/useStore'
import { getProfileEndpoints, getProfileDir } from '../utils/geometryCore'
import { closestParamLineToRay } from '../utils/pickUtils'
import { computeDragSnap, alignThreshold, ALIGN_PX } from '../utils/dragSnap'
import { pixelsToWorld } from './ResizeHandles'
import { MIN_LENGTH } from '../utils/profileFactory'
import { movingPartsConflict } from '../utils/analysis'
import { lowestPointY } from '../utils/profileFactory'
import { roundToGrid } from '../utils/specUtils'
import { toScreen } from '../utils/pickUtils'

/** endpoint snapping while dragging: generous on screen, capped in world units */
const SNAP_PX = 24
const SNAP_MAX_MM = 60
/**
 * Always snap within this world distance, however far the camera is zoomed out.
 *
 * It has to stay well under the smallest move anybody makes on purpose. At 20 mm it was
 * exactly the size of a deliberate nudge, so a rail asked to come down 20 mm landed back on
 * the endpoint it started from and the move looked impossible.
 */
const SNAP_MIN_MM = 6

/**
 * An arrow drag is a measured adjustment, not a placement: the axis is already chosen and
 * the distance is the whole point. Snapping stays, but only close enough to catch a part
 * that is nearly there, never far enough to swallow the move.
 */
const AXIS_SNAP_PX = 10
const AXIS_SNAP_MAX_MM = 12
/** a press near an end face only starts a stretch once the pointer travels this far */
const RESIZE_SLOP_PX = 4

/**
 * Snap either end of the moved profile to any endpoint of the others.
 * Measured in pixels (like the drawing tool) so the pull feels the same at any zoom,
 * with a world-space cap so a distant endpoint never grabs the member.
 */
function snapProfilePosition(
  p: ProfileData, newStart: THREE.Vector3, others: ProfileData[],
  camera: THREE.Camera, size: { width: number; height: number }, tight = false,
): { position: THREE.Vector3; refId: string | null } {
  const maxMm = tight ? AXIS_SNAP_MAX_MM : SNAP_MAX_MM
  const minMm = tight ? 2 : SNAP_MIN_MM
  const maxPx = tight ? AXIS_SNAP_PX : SNAP_PX
  const { start, end } = getProfileEndpoints({ ...p, position: [newStart.x, newStart.y, newStart.z] })
  const offset = end.clone().sub(start)
  const dir = getProfileDir(p)
  let best: THREE.Vector3 | null = null
  let bestRef: string | null = null
  let bestPx = maxPx
  for (const o of others) {
    // Endpoints join members that meet at an angle. Two parallel members side by side are a
    // different intent — they belong face to face, which the alignment snap handles.
    if (Math.abs(getProfileDir(o).dot(dir)) > 0.99) continue
    const eps = getProfileEndpoints(o)
    for (const ep of [eps.start, eps.end]) {
      const epPx = toScreen(ep, camera, size)
      for (const [corner, candidate] of [[start, ep], [end, ep.clone().sub(offset)]] as const) {
        const world = ep.distanceTo(corner)
        if (world > maxMm) continue
        const px = epPx.distanceTo(toScreen(corner, camera, size))
        const effective = world <= minMm ? Math.min(px, maxPx - 1) : px
        if (effective < bestPx) { bestPx = effective; best = candidate.clone(); bestRef = o.id }
      }
    }
  }
  return { position: best ?? newStart, refId: best ? bestRef : null }
}

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
  const resizingId = useRef<string | null>(null)

  useEffect(() => {
    const canvas = gl.domElement

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
      const profile = store.profiles.find((p) => p.id === rs.id)
      if (!profile) return false

      const dir = getProfileDir(profile)
      const origin = new THREE.Vector3(...rs.origin)
      const fixed = rs.end === 'start' ? origin.clone().addScaledVector(dir, rs.length) : origin.clone()
      const t = closestParamLineToRay(fixed, dir, rayFor(e))
      if (t === null) return true

      // A click near an end face must not resize anything: wait for real pointer travel,
      // and keep the offset between the press point and the end so nothing jumps.
      if (resizingId.current !== rs.id) {
        if (Math.hypot(e.clientX - rs.downX, e.clientY - rs.downY) <= RESIZE_SLOP_PX) return true
        resizingId.current = rs.id
        store.snapshotHistory()
        ts.markDragMoved()   // the gesture now owns a history entry; an exact commit must not add a second
      }

      const signed = rs.end === 'start' ? -t : t
      const raw = signed + (rs.length - rs.grabLength)   // press offset carried along
      let length = Math.max(MIN_LENGTH, roundToGrid(raw))

      const posFor = (len: number): [number, number, number] => rs.end === 'start'
        ? [fixed.x - dir.x * len, fixed.y - dir.y * len, fixed.z - dir.z * len]
        : [fixed.x, fixed.y, fixed.z]

      // the floor limits how far the grabbed end can go; the fixed end must not move
      let position = posFor(length)
      const sink = lowestPointY({ ...profile, length, position })
      if (sink < 0) {
        const dirY = rs.end === 'start' ? -dir.y : dir.y
        if (Math.abs(dirY) > 1e-6) {
          length = Math.max(MIN_LENGTH, length - Math.abs(sink / dirY))
          position = posFor(length)
        }
      }
      store.updateProfile(rs.id, { length, position })
      ts.setDragConflict(movingPartsConflict(useStore.getState().profiles, new Set([rs.id])))
      return true
    }

    const applyDrag = (e: { clientX: number; clientY: number }) => {
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

      if (!ts.dragMoved) {
        if (delta.lengthSq() <= 0.25) return
        // First real movement: record one undo entry for the whole drag
        ts.markDragMoved()
        store.snapshotHistory()
      }
      const all = store.profiles
      const ids = Object.keys(dragGroupOrigins)
      const dragIds = new Set(ids.length ? ids : [dragProfileId])
      const others = all.filter((p) => !dragIds.has(p.id))
      const single = dragIds.size === 1

      // Group delta: snap the grabbed member, then apply the same offset to everything
      const lead = all.find((p) => p.id === dragProfileId)
      const leadOrigin = new THREE.Vector3(...(dragGroupOrigins[dragProfileId] ?? dragOriginPos.toArray()))
      const leadNew = leadOrigin.clone().add(delta)
      leadNew.x = roundToGrid(leadNew.x); leadNew.y = roundToGrid(leadNew.y); leadNew.z = roundToGrid(leadNew.z)
      const endpointSnap = single && lead && dragKind === 'profile' && !ts.dragFree
        ? snapProfilePosition(lead, leadNew, others, camera, size, ts.dragAxis !== null)
        : { position: leadNew, refId: null }
      const snapped = endpointSnap.position
      const joinedAtEndpoint = endpointSnap.refId !== null
      const groupDelta = snapped.clone().sub(leadOrigin)

      const dragged = all.filter((p) => dragIds.has(p.id))

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
        const snap = computeDragSnap(dragged, proposed, others, threshold)
        // an axis-locked move only takes the pull on its own axis; announcing the others
        // would point at alignments the part was never allowed to make
        const lockedAxis = ts.dragAxis ? { x: 0, y: 1, z: 2 }[ts.dragAxis] : dragVertical ? 1 : null
        const guides = lockedAxis === null ? snap.guides : snap.guides.filter((g) => g.axis === lockedAxis)
        if (lockedAxis !== null) {
          if (lockedAxis !== 0) snap.offset.x = 0
          if (lockedAxis !== 1) snap.offset.y = 0
          if (lockedAxis !== 2) snap.offset.z = 0
        }
        groupDelta.add(snap.offset)
        ts.setSnapRefs(guides.length ? snap.refIds : [])
        ts.setSnapGuides(guides)
      }

      // keep the whole group on or above the floor, whatever each part's orientation is,
      // and do it last so no snap can push it back under
      const sink = groupSink(dragged, dragGroupOrigins, groupDelta)
      if (sink < 0) groupDelta.y -= sink

      const updates: Array<{ id: string; updates: Partial<ProfileData> }> = []
      for (const pid of dragIds) {
        const p = all.find((q) => q.id === pid)
        if (!p) continue
        const origin = new THREE.Vector3(...(dragGroupOrigins[pid] ?? p.position))
        const np = origin.clone().add(groupDelta)
        updates.push({ id: pid, updates: { position: [np.x, np.y, np.z] } })
      }
      const connectorUpdates: Array<{ id: string; updates: Partial<ConnectorData> }> = []
      for (const cid of dragIds) {
        const c = store.connectors.find((q) => q.id === cid)
        if (!c) continue
        const origin = new THREE.Vector3(...(dragGroupOrigins[cid] ?? c.position))
        const np = origin.clone().add(groupDelta)
        connectorUpdates.push({ id: cid, updates: { position: [np.x, np.y, np.z] } })
      }
      const panelUpdates: Array<{ id: string; updates: Partial<PanelData> }> = []
      for (const bid of dragIds) {
        const b = store.panels.find((q) => q.id === bid)
        if (!b) continue
        const origin = new THREE.Vector3(...(dragGroupOrigins[bid] ?? b.position))
        const np = origin.clone().add(groupDelta)
        panelUpdates.push({ id: bid, updates: { position: [np.x, np.y, np.z] } })
      }

      // Interference is allowed while moving: conflicting members turn red instead of the
      // drag silently sticking. Only the floor rule still clamps (handled above).
      // one write per frame: separate sets would re-render the scene N times and show
      // a frame where the connectors have moved but the members have not
      store.updateParts({ profiles: updates, connectors: connectorUpdates, panels: panelUpdates })
      ts.setDragConflict(movingPartsConflict(useStore.getState().profiles, new Set(updates.map((u) => u.id))))
    }

    const onPointerMove = (e: PointerEvent) => applyDrag(e)

    const onPointerUp = (e: PointerEvent) => {
      const ts = useToolStore.getState()
      if (ts.resize) {
        applyResize(e)
        resizingId.current = null
        useToolStore.getState().stopResize()
        useToolStore.getState().setDragConflict(false)
        return
      }
      if (!ts.isDragging) return
      // Browsers coalesce pointermove events per frame; make sure the release position is applied
      if (ts.dragMoved) applyDrag(e)
      useToolStore.getState().stopDrag()
    }

    canvas.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    return () => {
      canvas.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }
  }, [gl, camera, size])

  return null
}

export default DragHandler
