import React, { useEffect } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { useToolStore } from '../store/useToolStore'
import { useStore, type ProfileData } from '../store/useStore'
import { getProfileEndpoints } from '../utils/geometryCore'
import { analyzeFrame } from '../utils/analysis'
import { lowestPointY } from '../utils/profileFactory'
import { roundToGrid } from '../utils/specUtils'
import { toScreen } from '../utils/pickUtils'

/** endpoint snapping while dragging: generous on screen, capped in world units */
const SNAP_PX = 14
const SNAP_MAX_MM = 40
/** always snap within this world distance, however far the camera is zoomed in */
const SNAP_MIN_MM = 8

/**
 * Snap either end of the moved profile to any endpoint of the others.
 * Measured in pixels (like the drawing tool) so the pull feels the same at any zoom,
 * with a world-space cap so a distant endpoint never grabs the member.
 */
function snapProfilePosition(
  p: ProfileData, newStart: THREE.Vector3, others: ProfileData[],
  camera: THREE.Camera, size: { width: number; height: number },
): THREE.Vector3 {
  const { start, end } = getProfileEndpoints({ ...p, position: [newStart.x, newStart.y, newStart.z] })
  const offset = end.clone().sub(start)
  let best: THREE.Vector3 | null = null
  let bestPx = SNAP_PX
  for (const o of others) {
    const eps = getProfileEndpoints(o)
    for (const ep of [eps.start, eps.end]) {
      const epPx = toScreen(ep, camera, size)
      for (const [corner, candidate] of [[start, ep], [end, ep.clone().sub(offset)]] as const) {
        const world = ep.distanceTo(corner)
        if (world > SNAP_MAX_MM) continue
        const px = epPx.distanceTo(toScreen(corner, camera, size))
        const effective = world <= SNAP_MIN_MM ? Math.min(px, SNAP_PX - 1) : px
        if (effective < bestPx) { bestPx = effective; best = candidate.clone() }
      }
    }
  }
  return best ?? newStart
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

  useEffect(() => {
    const canvas = gl.domElement

    const applyDrag = (e: { clientX: number; clientY: number }) => {
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
      const snapped = single && lead && dragKind === 'profile'
        ? snapProfilePosition(lead, leadNew, others, camera, size)
        : leadNew
      const groupDelta = snapped.clone().sub(leadOrigin)

      // keep the whole group on or above the floor, whatever each part's orientation is
      const dragged = all.filter((p) => dragIds.has(p.id))
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
      for (const cid of dragIds) {
        const c = store.connectors.find((q) => q.id === cid)
        if (!c) continue
        const origin = new THREE.Vector3(...(dragGroupOrigins[cid] ?? c.position))
        const np = origin.clone().add(groupDelta)
        store.updateConnector(cid, { position: [np.x, np.y, np.z] })
      }

      // Interference is allowed while moving: conflicting members turn red instead of the
      // drag silently sticking. Only the floor rule still clamps (handled above).
      store.updateProfiles(updates)
      const after = analyzeFrame(useStore.getState().profiles).conflictIds
      ts.setDragConflict(updates.some((u) => after.has(u.id)))
    }

    const onPointerMove = (e: PointerEvent) => applyDrag(e)

    const onPointerUp = (e: PointerEvent) => {
      const ts = useToolStore.getState()
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
