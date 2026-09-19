import React, { useEffect } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { useToolStore } from '../store/useToolStore'
import { useStore, type ProfileData } from '../store/useStore'
import { getProfileEndpoints, wouldOverlap } from '../utils/snapUtils'
import { getProfileAxis } from '../utils/jointUtils'
import { floorY } from '../utils/profileFactory'
import { roundToGrid } from '../utils/specUtils'

const SNAP_MM = 20

/** Snap either end of the moved profile to any endpoint of the others. Returns the adjusted start position. */
function snapProfilePosition(p: ProfileData, newStart: THREE.Vector3, others: ProfileData[]): THREE.Vector3 {
  const { start, end } = getProfileEndpoints({ ...p, position: [newStart.x, newStart.y, newStart.z] })
  const offset = end.clone().sub(start)
  let best: THREE.Vector3 | null = null
  let bestD = SNAP_MM
  for (const o of others) {
    const eps = getProfileEndpoints(o)
    for (const ep of [eps.start, eps.end]) {
      const d1 = ep.distanceTo(start)
      if (d1 < bestD) { bestD = d1; best = ep.clone() }
      const d2 = ep.distanceTo(end)
      if (d2 < bestD) { bestD = d2; best = ep.clone().sub(offset) }
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
  const { gl, camera } = useThree()

  useEffect(() => {
    const canvas = gl.domElement

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
      const snapped = single ? snapProfilePosition(lead, leadNew, others) : leadNew
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
      const valid = updates.every((u) => {
        const orig = all.find((p) => p.id === u.id)!
        const cand = { ...orig, position: u.updates.position! }
        if (getProfileAxis(cand) !== 'y' && cand.position[1] < floorY(cand.spec) - 0.01) return false
        return !wouldOverlap(cand, others)
      })
      if (valid) store.updateProfiles(updates)
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
  }, [gl, camera])

  return null
}

export default DragHandler
