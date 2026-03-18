import React, { useMemo, useRef, useCallback } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { useToolStore } from '../store/useToolStore'
import { useDrawTool } from '../hooks/useDrawTool'
import { Line } from '@react-three/drei'
import { getProfileShape } from '../utils/profileShapes'

const AXIS_COLORS: Record<string, string> = { x: '#ef4444', y: '#22c55e', z: '#3b82f6' }

// Compute world point by intersecting a ray with a plane
function rayPlaneIntersect(ray: THREE.Ray, plane: THREE.Plane): THREE.Vector3 | null {
  const pt = new THREE.Vector3()
  return ray.intersectPlane(plane, pt) ? pt.clone() : null
}

// Get active drawing plane: horizontal for left/right screen movement, vertical for diagonal/vertical
function getWorldPoint(
  ray: THREE.Ray,
  startPoint: THREE.Vector3 | null,
  isVertical: boolean,
  camera: THREE.Camera
): THREE.Vector3 | null {
  if (!startPoint) {
    return rayPlaneIntersect(ray, new THREE.Plane(new THREE.Vector3(0, 1, 0), 0))
  }
  if (isVertical) {
    // Vertical plane passing through startPoint, perpendicular to camera's XZ direction
    const toCamera = new THREE.Vector3(camera.position.x - startPoint.x, 0, camera.position.z - startPoint.z)
    if (toCamera.lengthSq() < 0.001) toCamera.set(0, 0, 1)
    toCamera.normalize()
    return rayPlaneIntersect(ray, new THREE.Plane().setFromNormalAndCoplanarPoint(toCamera, startPoint))
  } else {
    return rayPlaneIntersect(ray, new THREE.Plane(new THREE.Vector3(0, 1, 0), -startPoint.y))
  }
}

function getActiveAxis(start: THREE.Vector3, end: THREE.Vector3): 'x' | 'y' | 'z' {
  const d = end.clone().sub(start)
  const ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z)
  if (ax >= ay && ax >= az) return 'x'
  if (ay >= ax && ay >= az) return 'y'
  return 'z'
}

const DrawingHandler: React.FC = () => {
  const { handlePointerDown, handlePointerMove } = useDrawTool()
  const { isDrawing, startPoint, currentPoint, snapPoint, placementMode, activeSpec, viewMode } = useToolStore()
  const { camera } = useThree()

  const startScreenRef = useRef<{ x: number; y: number } | null>(null)
  const isVerticalRef = useRef(false)

  const previewGeo = useMemo(() => {
    try {
      const shape = getProfileShape(activeSpec)
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false })
      geo.computeVertexNormals()
      return geo
    } catch (e) {
      const fallback = new THREE.BoxGeometry(20, 20, 1)
      fallback.translate(0, 0, 0.5)
      return fallback
    }
  }, [activeSpec])

  const xform = useMemo(() => {
    if (!isDrawing || !startPoint || !currentPoint) return null
    const dist = startPoint.distanceTo(currentPoint)
    if (dist < 0.1) return null
    const dir = new THREE.Vector3().subVectors(currentPoint, startPoint).normalize()
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir)
    return { pos: startPoint.clone(), quat, scale: dist }
  }, [isDrawing, startPoint, currentPoint])

  const activeAxis = useMemo(() => {
    if (!startPoint || !currentPoint) return null
    return getActiveAxis(startPoint, currentPoint)
  }, [startPoint, currentPoint])

  const axisColor = activeAxis ? AXIS_COLORS[activeAxis] : '#ef4444'
  const drawDist = startPoint && currentPoint ? startPoint.distanceTo(currentPoint) : 0

  const onPointerDown = useCallback((e: any) => {
    e.stopPropagation()
    const toolStore = useToolStore.getState()

    if (!toolStore.isDrawing) {
      // First click: record screen origin, always use horizontal plane
      startScreenRef.current = { x: e.nativeEvent.clientX, y: e.nativeEvent.clientY }
      isVerticalRef.current = false
      const pt = getWorldPoint(e.ray, null, false, camera)
      if (pt) handlePointerDown(pt)
    } else {
      // Second click: use the same isVertical state that was active during the last move
      const pt = getWorldPoint(e.ray, toolStore.startPoint, isVerticalRef.current, camera)
      if (pt) handlePointerDown(pt)
    }
  }, [camera, handlePointerDown])

  const onPointerMove = useCallback((e: any) => {
    e.stopPropagation()
    const toolStore = useToolStore.getState()

    if (toolStore.isDrawing && startScreenRef.current) {
      const dx = Math.abs(e.nativeEvent.clientX - startScreenRef.current.x)
      const dy = Math.abs(e.nativeEvent.clientY - startScreenRef.current.y)
      // Any vertical screen movement triggers vertical draw mode
      isVerticalRef.current = dy > dx * 0.5
    }

    const pt = getWorldPoint(e.ray, toolStore.startPoint, isVerticalRef.current, camera)
    if (pt) handlePointerMove(pt)
  }, [camera, handlePointerMove])

  return (
    <>
      {/* Invisible sphere — catches ALL pointer events regardless of camera angle */}
      {viewMode === 'draw' && (
        <mesh onPointerDown={onPointerDown} onPointerMove={onPointerMove}>
          <sphereGeometry args={[8000, 8, 6]} />
          <meshBasicMaterial
            transparent opacity={0} depthWrite={false}
            side={THREE.BackSide}
          />
        </mesh>
      )}

      {/* Axis-colored draw line */}
      {isDrawing && startPoint && currentPoint && drawDist > 1 && (
        <Line
          points={[startPoint.toArray(), currentPoint.toArray()]}
          color={axisColor}
          lineWidth={2}
        />
      )}

      {/* Profile preview — colored by active axis */}
      {placementMode === 'profile' && xform && (
        <mesh
          position={xform.pos}
          quaternion={xform.quat}
          scale={[1, 1, xform.scale]}
          geometry={previewGeo}
          raycast={() => null}
        >
          <meshStandardMaterial
            color={axisColor}
            metalness={0.3}
            roughness={0.6}
            polygonOffset
            polygonOffsetFactor={-1}
          />
        </mesh>
      )}

      {/* Snap indicator */}
      {snapPoint && (
        <mesh position={snapPoint} raycast={() => null}>
          <sphereGeometry args={[4, 16, 16]} />
          <meshStandardMaterial color="#facc15" emissive="#facc15" emissiveIntensity={0.6} />
        </mesh>
      )}

      {/* Connector preview */}
      {placementMode === 'connector' && currentPoint && (
        <group position={currentPoint} raycast={() => null}>
          <mesh>
            <boxGeometry args={[20, 4, 20]} />
            <meshStandardMaterial color="#10b981" transparent opacity={0.6} />
          </mesh>
        </group>
      )}
    </>
  )
}

export default DrawingHandler
