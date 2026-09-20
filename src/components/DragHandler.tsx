import React, { useEffect } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { useToolStore } from '../store/useToolStore'
import { useStore, type ProfileData } from '../store/useStore'
import { getProfileEndpoints, wouldOverlap } from '../utils/snapUtils'
import { translations } from '../utils/translations'
import { getProfileAxis } from '../utils/jointUtils'
import { floorY } from '../utils/profileFactory'
import { roundToGrid } from '../utils/specUtils'
import { toScreen } from '../utils/pickUtils'

/** endpoint snapping while dragging: generous on screen, capped in world units */
const SNAP_PX = 14
const SNAP_MAX_MM = 40
/** always snap within this world distance, however far the camera is zoomed in */
const SNAP_MIN_MM = 8
/** a rejected drag repeats every frame — only tell the user this often (ms) */
const BLOCK_TOAST_INTERVAL = 1500

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

function clampFloor(p: ProfileData, pos: THREE.Vector3): void {
  const axis = getProfileAxis(p)
  if (axis === 'y') {
    // uprights: keep the lower end at or above the floor
    const { start, end } = getProfileEndpoints({ ...p, position: [pos.x, pos.y, pos.z] })
    const low = Math.min(start.y, end.y)
    if (low < 0) pos.y -= low
  } else {
    pos.y = Math.max(pos.y, floorY(p.spec))
  }
}

const DragHandler: React.FC = () => {
  const { gl, camera, size } = useThree()

  useEffect(() => {
    const canvas = gl.domElement
    let lastBlockToast = 0

    const applyDrag = (e: { clientX: number; clientY: number }) => {
      const ts = useToolStore.getState()
      const { isDragging, dragProfileId, dragStartHit, dragOriginPos, dragGroupOrigins, dragPlane, dragVertical } = ts
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

      // Group delta: snap the grabbed profile, then apply the same offset to all
      const lead = all.find((p) => p.id === dragProfileId)
      if (!lead) return
      const leadOrigin = new THREE.Vector3(...(dragGroupOrigins[dragProfileId] ?? dragOriginPos.toArray()))
      const leadNew = leadOrigin.clone().add(delta)
      leadNew.x = roundToGrid(leadNew.x); leadNew.y = roundToGrid(leadNew.y); leadNew.z = roundToGrid(leadNew.z)
      const snapped = single ? snapProfilePosition(lead, leadNew, others, camera, size) : leadNew
      if (single) clampFloor(lead, snapped)
      const groupDelta = snapped.clone().sub(leadOrigin)

      const updates: Array<{ id: string; updates: Partial<ProfileData> }> = []
      for (const pid of dragIds) {
        const p = all.find((q) => q.id === pid)
        if (!p) continue
        const origin = new THREE.Vector3(...(dragGroupOrigins[pid] ?? p.position))
        const np = origin.clone().add(groupDelta)
        updates.push({ id: pid, updates: { position: [np.x, np.y, np.z] } })
      }

      // Nothing in the group may end up overlapping a member outside the group
      let floorViolation = false
      const valid = updates.every((u) => {
        const orig = all.find((p) => p.id === u.id)!
        const cand = { ...orig, position: u.updates.position! }
        if (getProfileAxis(cand) !== 'y' && cand.position[1] < floorY(cand.spec) - 0.01) { floorViolation = true; return false }
        return !wouldOverlap(cand, others)
      })

      if (valid) {
        ts.setDragBlocked(false)
        store.updateProfiles(updates)
        return
      }
      // Rejected: say why instead of letting the member look stuck
      ts.setDragBlocked(true)
      const now = performance.now()
      if (now - lastBlockToast > BLOCK_TOAST_INTERVAL) {
        lastBlockToast = now
        const t = translations[ts.language]
        ts.showToast(floorViolation ? t.toastBelowFloor : t.toastDragOverlap, 'error')
      }
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
