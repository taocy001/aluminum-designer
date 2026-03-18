import React, { useEffect } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { useToolStore } from '../store/useToolStore'
import { useStore } from '../store/useStore'
import { findSnapPoint } from '../utils/snapUtils'

const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)

const DragHandler: React.FC = () => {
  const { gl, camera } = useThree()
  const { updateProfile } = useStore()

  useEffect(() => {
    const canvas = gl.domElement

    const onPointerMove = (e: PointerEvent) => {
      const { isDragging, dragProfileId, dragStartHit, dragOriginPos } = useToolStore.getState()
      if (!isDragging || !dragProfileId || !dragStartHit || !dragOriginPos) return

      const rect = canvas.getBoundingClientRect()
      const x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      const y = -((e.clientY - rect.top) / rect.height) * 2 + 1

      const raycaster = new THREE.Raycaster()
      raycaster.setFromCamera(new THREE.Vector2(x, y), camera)

      const currentHit = new THREE.Vector3()
      if (!raycaster.ray.intersectPlane(GROUND_PLANE, currentHit)) return

      const delta = currentHit.clone().sub(dragStartHit)
      let newPos = dragOriginPos.clone().add(delta)

      newPos.x = Math.round(newPos.x / 5) * 5
      newPos.z = Math.round(newPos.z / 5) * 5

      const snap = findSnapPoint(newPos, useStore.getState().profiles.filter(p => p.id !== dragProfileId), 15)
      if (snap) {
        newPos.x = snap.x
        newPos.z = snap.z
      }

      updateProfile(dragProfileId, { position: [newPos.x, dragOriginPos.y, newPos.z] })
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
  }, [gl, camera, updateProfile])

  return null
}

export default DragHandler
