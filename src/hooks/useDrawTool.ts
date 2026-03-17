import { useCallback } from 'react'
import * as THREE from 'three'
import { ThreeEvent } from '@react-three/fiber'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'

export const useDrawTool = () => {
  const { addProfile, addConnector } = useStore()
  
  const handlePointerDown = useCallback((e: ThreeEvent<PointerEvent>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    
    const toolStore = useToolStore.getState()
    const { isDrawing, startPoint, activeSpec, placementMode, activeConnectorType, setDrawing, setPoints } = toolStore
    
    if (!e.point || !isFinite(e.point.x)) return

    const point = e.point.clone()
    point.x = Math.round(point.x / 5) * 5
    point.y = Math.round(point.y / 5) * 5
    point.z = Math.round(point.z / 5) * 5
    
    if (placementMode === 'profile') {
      if (!isDrawing) {
        setPoints(point, point)
        setDrawing(true)
      } else if (startPoint) {
        const dist = startPoint.distanceTo(point)
        if (dist > 5) {
          const direction = new THREE.Vector3().subVectors(point, startPoint).normalize()
          
          // CORRECT ORIENTATION: 
          // Our model extrudes along +Z. Map +Z to target direction.
          const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction)
          
          addProfile({
            id: `p-${Date.now()}`,
            spec: activeSpec,
            length: dist,
            position: [startPoint.x, startPoint.y, startPoint.z],
            quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
            miterCuts: [],
            holes: []
          })
        }
        setDrawing(false)
        setPoints(null, null)
      }
    } else if (placementMode === 'connector' && activeConnectorType) {
      addConnector({
        id: `c-${Date.now()}`,
        type: activeConnectorType,
        position: [e.point.x, e.point.y, e.point.z],
        quaternion: [0, 0, 0, 1]
      })
    }
  }, [addProfile, addConnector])

  const handlePointerMove = useCallback((e: ThreeEvent<PointerEvent>) => {
    if (!e.point || !isFinite(e.point.x)) return
    const toolStore = useToolStore.getState()
    const { isDrawing, startPoint, setPoints } = toolStore

    if (isDrawing && startPoint) {
      const point = e.point.clone()
      point.x = Math.round(point.x / 5) * 5
      point.y = Math.round(point.y / 5) * 5
      point.z = Math.round(point.z / 5) * 5
      setPoints(startPoint, point)
    } else {
      setPoints(null, e.point)
    }
  }, [])

  return {
    handlePointerDown,
    handlePointerMove
  }
}
