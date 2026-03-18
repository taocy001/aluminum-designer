import React, { useMemo, useState } from 'react'
import * as THREE from 'three'
import { useToolStore } from '../store/useToolStore'
import { useDrawTool } from '../hooks/useDrawTool'
import { Line } from '@react-three/drei'
import { getProfileShape } from '../utils/profileShapes'

const DrawingHandler: React.FC = () => {
  const { handlePointerDown, handlePointerMove } = useDrawTool()
  const { isDrawing, startPoint, currentPoint, snapPoint, placementMode, activeSpec, viewMode } = useToolStore()
  const [hoverNormal, setHoverNormal] = useState(new THREE.Vector3(0, 1, 0))

  // Single source of geometry for the active spec
  const previewGeo = useMemo(() => {
    try {
      const shape = getProfileShape(activeSpec)
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false })
      geo.computeVertexNormals()
      return geo
    } catch(e) {
      const fallback = new THREE.BoxGeometry(20, 20, 1)
      fallback.translate(0, 0, 0.5)
      return fallback
    }
  }, [activeSpec])

  const xform = useMemo(() => {
    if (!isDrawing || !startPoint || !currentPoint) return null
    const dist = startPoint.distanceTo(currentPoint)
    if (dist < 0.1) return null

    // Align local +Z with draw direction (same convention as placed profiles)
    const dir = new THREE.Vector3().subVectors(currentPoint, startPoint).normalize()
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir)

    return { pos: startPoint.clone(), quat, scale: dist }
  }, [isDrawing, startPoint, currentPoint])

  const connectorQuat = useMemo(() => {
    const q = new THREE.Quaternion()
    q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), hoverNormal)
    return q
  }, [hoverNormal])

  return (
    <>
      {viewMode === 'draw' && (
        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, -0.05, 0]}
          onPointerDown={(e) => {
            e.stopPropagation()
            handlePointerDown(e)
          }}
          onPointerMove={(e) => {
            e.stopPropagation()
            setHoverNormal(new THREE.Vector3(0, 1, 0))
            handlePointerMove(e)
          }}
        >
          <planeGeometry args={[10000, 10000]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}

      {/* VERIFIED RED LINE */}
      {isDrawing && startPoint && currentPoint && (
        <Line points={[startPoint.toArray(), currentPoint.toArray()]} color="#ef4444" lineWidth={1} />
      )}

      {/* HIGH-PRECISION STABLE PREVIEW */}
      {placementMode === 'profile' && xform && (
        <mesh 
          position={xform.pos} 
          quaternion={xform.quat} 
          scale={[1, 1, xform.scale]}
          geometry={previewGeo}
          raycast={() => null}
        >
          <meshStandardMaterial
            color="#3b82f6"
            metalness={0.3}
            roughness={0.6}
            polygonOffset
            polygonOffsetFactor={-1}
          />
        </mesh>
      )}

      {/* Snap Indicator */}
      {snapPoint && (
        <mesh position={snapPoint} raycast={() => null}>
          <sphereGeometry args={[4, 16, 16]} />
          <meshStandardMaterial color="#facc15" emissive="#facc15" emissiveIntensity={0.5} />
        </mesh>
      )}

      {/* Connector Preview */}
      {placementMode === 'connector' && currentPoint && (
        <group 
          position={[currentPoint.x, currentPoint.y, currentPoint.z]} 
          quaternion={connectorQuat}
          raycast={() => null}
        >
          <mesh>
            <boxGeometry args={[20, 4, 20]} />
            <meshStandardMaterial color="#10b981" transparent opacity={0.5} />
          </mesh>
        </group>
      )}
    </>
  )
}

export default DrawingHandler
