import React, { useMemo, useRef, useCallback, useState } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { useToolStore } from '../store/useToolStore'
import { useDrawTool } from '../hooks/useDrawTool'
import { Line } from '@react-three/drei'
import { getProfileShape } from '../utils/profileShapes'
import { getProfileEndpoints, findSnapPoint, snapToAxis } from '../utils/snapUtils'
import { useStore } from '../store/useStore'

const AXIS_COLORS: Record<string, string> = { x: '#ef4444', y: '#22c55e', z: '#3b82f6' }

function rayPlaneIntersect(ray: THREE.Ray, plane: THREE.Plane): THREE.Vector3 | null {
  const pt = new THREE.Vector3()
  return ray.intersectPlane(plane, pt) ? pt.clone() : null
}

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

interface AlignGuide {
  from: [number, number, number]
  to: [number, number, number]
}

const DrawingHandler: React.FC = () => {
  const { handlePointerDown, handlePointerMove } = useDrawTool()
  const { isDrawing, startPoint, currentPoint, snapPoint, placementMode, activeSpec, viewMode } = useToolStore()
  const { camera } = useThree()

  const startScreenRef = useRef<{ x: number; y: number } | null>(null)
  const isVerticalRef = useRef(false)
  const [alignGuides, setAlignGuides] = useState<AlignGuide[]>([])

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

  const computeAlignGuides = useCallback((axisPt: THREE.Vector3, currentStartPoint: THREE.Vector3) => {
    const profiles = useStore.getState().profiles
    const guides: AlignGuide[] = []
    const EPS = 3

    for (const profile of profiles) {
      const { start: ps, end: pe } = getProfileEndpoints(profile)
      for (const ep of [ps, pe]) {
        if (ep.distanceTo(currentStartPoint) < 2) continue

        if (Math.abs(ep.x - axisPt.x) < EPS) {
          guides.push({
            from: [ep.x, ep.y, ep.z],
            to: [axisPt.x, axisPt.y, axisPt.z],
          })
        } else if (Math.abs(ep.z - axisPt.z) < EPS) {
          guides.push({
            from: [ep.x, ep.y, ep.z],
            to: [axisPt.x, axisPt.y, axisPt.z],
          })
        } else if (Math.abs(ep.y - axisPt.y) < EPS) {
          guides.push({
            from: [ep.x, ep.y, ep.z],
            to: [axisPt.x, axisPt.y, axisPt.z],
          })
        }
      }
    }
    return guides
  }, [])

  const onPointerDown = useCallback((e: any) => {
    e.stopPropagation()
    const toolStore = useToolStore.getState()

    if (!toolStore.isDrawing) {
      startScreenRef.current = { x: e.nativeEvent.clientX, y: e.nativeEvent.clientY }
      isVerticalRef.current = false
      const pt = getWorldPoint(e.ray, null, false, camera)
      if (pt) handlePointerDown(pt)
    } else {
      const pt = getWorldPoint(e.ray, toolStore.startPoint, isVerticalRef.current, camera)
      if (pt) handlePointerDown(pt)
      setAlignGuides([])
    }
  }, [camera, handlePointerDown])

  const onPointerMove = useCallback((e: any) => {
    e.stopPropagation()
    const toolStore = useToolStore.getState()

    if (toolStore.isDrawing && startScreenRef.current) {
      const dx = Math.abs(e.nativeEvent.clientX - startScreenRef.current.x)
      const dy = Math.abs(e.nativeEvent.clientY - startScreenRef.current.y)
      isVerticalRef.current = dy > dx * 0.5
    }

    const pt = getWorldPoint(e.ray, toolStore.startPoint, isVerticalRef.current, camera)
    if (pt) {
      handlePointerMove(pt)

      // Compute alignment guides during draw preview
      if (toolStore.isDrawing && toolStore.startPoint) {
        const profiles = useStore.getState().profiles
        const snap = findSnapPoint(pt, profiles, 20, toolStore.startPoint)
        const snappedPt = snap ? snap.clone() : (() => {
          const p = pt.clone()
          p.x = Math.round(p.x / 5) * 5
          p.y = Math.round(p.y / 5) * 5
          p.z = Math.round(p.z / 5) * 5
          return p
        })()
        const axisPt = snapToAxis(toolStore.startPoint, snappedPt)
        setAlignGuides(computeAlignGuides(axisPt, toolStore.startPoint))
      } else {
        setAlignGuides([])
      }
    }
  }, [camera, handlePointerMove, computeAlignGuides])

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
            transparent
            opacity={0.7}
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

      {/* Alignment guides — dashed lines showing axis alignment with other endpoints */}
      {alignGuides.map((guide, i) => (
        <Line
          key={i}
          points={[guide.from, guide.to]}
          color="#a78bfa"
          lineWidth={1}
          dashed
          dashSize={8}
          gapSize={5}
        />
      ))}

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
