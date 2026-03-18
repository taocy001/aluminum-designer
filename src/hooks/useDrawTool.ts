import { useCallback } from 'react'
import * as THREE from 'three'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { findSnapPoint, snapToAxis, wouldOverlap } from '../utils/snapUtils'

export const useDrawTool = () => {
  const { addProfile, addConnector } = useStore()

  // Both handlers now accept a pre-computed world point (not ThreeEvent)
  const handlePointerDown = useCallback((worldPoint: THREE.Vector3) => {
    const toolStore = useToolStore.getState()
    const { isDrawing, startPoint, activeSpec, placementMode, activeConnectorType, setDrawing, setPoints, setSnapPoint } = toolStore

    const profiles = useStore.getState().profiles
    const snap = findSnapPoint(worldPoint, profiles, 20, startPoint)

    let point: THREE.Vector3
    if (snap) {
      point = snap.clone()
    } else {
      point = worldPoint.clone()
      point.x = Math.round(point.x / 5) * 5
      point.y = Math.round(point.y / 5) * 5
      point.z = Math.round(point.z / 5) * 5
    }

    if (placementMode === 'profile') {
      if (!isDrawing) {
        setPoints(point, point)
        setDrawing(true)
      } else if (startPoint) {
        const axisPoint = snapToAxis(startPoint, point)
        const dist = startPoint.distanceTo(axisPoint)

        if (dist > 5) {
          const direction = new THREE.Vector3().subVectors(axisPoint, startPoint).normalize()
          const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction)

          const candidate = {
            id: `p-${Date.now()}`,
            spec: activeSpec,
            length: dist,
            position: [startPoint.x, startPoint.y, startPoint.z] as [number, number, number],
            quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w] as [number, number, number, number],
            miterCuts: [],
            holes: []
          }

          if (!wouldOverlap(candidate, profiles)) {
            addProfile(candidate)
          }
        }

        setDrawing(false)
        setPoints(null, null)
        setSnapPoint(null)
      }
    } else if (placementMode === 'connector' && activeConnectorType) {
      addConnector({
        id: `c-${Date.now()}`,
        type: activeConnectorType,
        position: [point.x, point.y, point.z],
        quaternion: [0, 0, 0, 1]
      })
    }
  }, [addProfile, addConnector])

  const handlePointerMove = useCallback((worldPoint: THREE.Vector3) => {
    const toolStore = useToolStore.getState()
    const { isDrawing, startPoint, setPoints, setSnapPoint } = toolStore
    const profiles = useStore.getState().profiles

    const snap = findSnapPoint(worldPoint, profiles, 20, startPoint)
    setSnapPoint(snap)

    let point = snap ? snap.clone() : (() => {
      const p = worldPoint.clone()
      p.x = Math.round(p.x / 5) * 5
      p.y = Math.round(p.y / 5) * 5
      p.z = Math.round(p.z / 5) * 5
      return p
    })()

    if (isDrawing && startPoint) {
      setPoints(startPoint, snapToAxis(startPoint, point))
    } else {
      setPoints(null, point)
    }
  }, [])

  return { handlePointerDown, handlePointerMove }
}
