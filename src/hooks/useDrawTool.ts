import { useCallback } from 'react'
import * as THREE from 'three'
import { ThreeEvent } from '@react-three/fiber'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { findSnapPoint, snapToAxis, wouldOverlap } from '../utils/snapUtils'

export const useDrawTool = () => {
  const { addProfile, addConnector } = useStore()

  const handlePointerDown = useCallback((e: ThreeEvent<PointerEvent>) => {
    if (e.button !== 0) return
    e.stopPropagation()

    const toolStore = useToolStore.getState()
    const { isDrawing, startPoint, activeSpec, placementMode, activeConnectorType, snapPoint, setDrawing, setPoints, setSnapPoint } = toolStore

    if (!e.point || !isFinite(e.point.x)) return

    // Use snap point if available, otherwise grid-round
    let point: THREE.Vector3
    if (snapPoint) {
      point = snapPoint.clone()
    } else {
      point = e.point.clone()
      point.x = Math.round(point.x / 5) * 5
      point.y = Math.round(point.y / 5) * 5
      point.z = Math.round(point.z / 5) * 5
    }

    if (placementMode === 'profile') {
      if (!isDrawing) {
        setPoints(point, point)
        setDrawing(true)
      } else if (startPoint) {
        // Axis-align the endpoint
        const axisPoint = snapPoint ? point : snapToAxis(startPoint, point)
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

          const profiles = useStore.getState().profiles
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

  const handlePointerMove = useCallback((e: ThreeEvent<PointerEvent>) => {
    if (!e.point || !isFinite(e.point.x)) return
    const toolStore = useToolStore.getState()
    const { isDrawing, startPoint, setPoints, setSnapPoint } = toolStore
    const profiles = useStore.getState().profiles

    // Compute snap point from all profile endpoints
    const snap = findSnapPoint(e.point, profiles)
    setSnapPoint(snap)

    let point: THREE.Vector3
    if (snap) {
      point = snap.clone()
    } else {
      point = e.point.clone()
      point.x = Math.round(point.x / 5) * 5
      point.y = Math.round(point.y / 5) * 5
      point.z = Math.round(point.z / 5) * 5
    }

    if (isDrawing && startPoint) {
      // Apply axis constraint during preview (unless snapping to an endpoint)
      const constrained = snap ? point : snapToAxis(startPoint, point)
      setPoints(startPoint, constrained)
    } else {
      setPoints(null, point)
    }
  }, [])

  return { handlePointerDown, handlePointerMove }
}
