import React, { useEffect } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { useToolStore } from '../store/useToolStore'
import { useStore } from '../store/useStore'
import { findSnapPoint, wouldOverlap } from '../utils/snapUtils'

const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)

const DragHandler: React.FC = () => {
  const { gl, camera } = useThree()
  const { updateProfile, updateProfiles } = useStore()

  useEffect(() => {
    const canvas = gl.domElement

    const onPointerMove = (e: PointerEvent) => {
      const { isDragging, dragProfileId, dragStartHit, dragOriginPos, dragGroupOrigins } = useToolStore.getState()
      if (!isDragging || !dragProfileId || !dragStartHit || !dragOriginPos) return

      const rect = canvas.getBoundingClientRect()
      const x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      const y = -((e.clientY - rect.top) / rect.height) * 2 + 1

      const raycaster = new THREE.Raycaster()
      raycaster.setFromCamera(new THREE.Vector2(x, y), camera)

      const currentHit = new THREE.Vector3()
      if (!raycaster.ray.intersectPlane(GROUND_PLANE, currentHit)) return

      const delta = currentHit.clone().sub(dragStartHit)
      const allProfiles = useStore.getState().profiles
      const isGroup = Object.keys(dragGroupOrigins).length > 1

      if (isGroup) {
        const dragIds = new Set(Object.keys(dragGroupOrigins))
        const otherProfiles = allProfiles.filter((p) => !dragIds.has(p.id))

        const updates = Object.entries(dragGroupOrigins).map(([pid, origin]) => {
          const newPos = new THREE.Vector3(...origin).add(delta)
          newPos.x = Math.round(newPos.x / 5) * 5
          newPos.z = Math.round(newPos.z / 5) * 5
          // Y: keep origin Y (ground plane drag keeps delta.y = 0 for horizontal profiles)
          newPos.y = origin[1]
          return { id: pid, updates: { position: [newPos.x, newPos.y, newPos.z] as [number, number, number] } }
        })

        // Only move group if no profile in it would overlap with non-group profiles
        const allValid = updates.every((u) => {
          const orig = allProfiles.find((p) => p.id === u.id)
          if (!orig) return false
          const candidate = { ...orig, position: u.updates.position }
          return !wouldOverlap(candidate, otherProfiles)
        })

        if (allValid) updateProfiles(updates)
      } else {
        // Single profile drag
        let newPos = dragOriginPos.clone().add(delta)
        newPos.x = Math.round(newPos.x / 5) * 5
        newPos.z = Math.round(newPos.z / 5) * 5

        const snap = findSnapPoint(newPos, allProfiles.filter((p) => p.id !== dragProfileId), 15)
        if (snap) {
          newPos.x = snap.x
          newPos.y = snap.y
          newPos.z = snap.z
        }

        const currentProfile = allProfiles.find((p) => p.id === dragProfileId)
        if (!currentProfile) return

        const finalPos: [number, number, number] = [newPos.x, newPos.y, newPos.z]
        const candidate = { ...currentProfile, position: finalPos }
        const otherProfiles = allProfiles.filter((p) => p.id !== dragProfileId)

        if (!wouldOverlap(candidate, otherProfiles)) {
          updateProfile(dragProfileId, { position: finalPos })
        }
      }
    }

    const onPointerUp = () => {
      const { isDragging, stopDrag } = useToolStore.getState()
      if (isDragging) stopDrag()
    }

    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    return () => {
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
    }
  }, [gl, camera, updateProfile, updateProfiles])

  return null
}

export default DragHandler
