import React, { useMemo, useCallback, useRef } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { Line } from '@react-three/drei'
import { useToolStore } from '../store/useToolStore'
import { useStore } from '../store/useStore'
import { getProfileShape } from '../utils/profileShapes'
import { pickPoint, resolveAxisEnd } from '../utils/pickUtils'
import { floorY, tryAddProfile, placeConnector } from '../utils/profileFactory'
import { specDims } from '../utils/specUtils'

const AXIS_COLORS: Record<string, string> = { x: '#ef4444', y: '#22c55e', z: '#3b82f6' }

const DrawingHandler: React.FC = () => {
  const { isDrawing, startPoint, currentPoint, snapPoint, placementMode, activeSpec, viewMode, drawAxis, alignGuides } = useToolStore()
  const { camera, size } = useThree()
  const lastRay = useRef<THREE.Ray | null>(null)
  const lastCursor = useRef<THREE.Vector2 | null>(null)

  const previewGeo = useMemo(() => {
    const shape = getProfileShape(activeSpec)
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false })
    geo.computeVertexNormals()
    return geo
  }, [activeSpec])

  const xform = useMemo(() => {
    if (!isDrawing || !startPoint || !currentPoint) return null
    const dist = startPoint.distanceTo(currentPoint)
    if (dist < 0.1) return null
    const dir = new THREE.Vector3().subVectors(currentPoint, startPoint).normalize()
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir)
    return { pos: startPoint.clone(), quat, scale: dist }
  }, [isDrawing, startPoint, currentPoint])

  const axisColor = drawAxis ? AXIS_COLORS[drawAxis] : '#94a3b8'
  const drawDist = startPoint && currentPoint ? startPoint.distanceTo(currentPoint) : 0

  const cursorFromEvent = (e: any): THREE.Vector2 =>
    new THREE.Vector2((e.pointer.x + 1) / 2 * size.width, (1 - e.pointer.y) / 2 * size.height)

  /** Recompute the axis-constrained end point for the current cursor */
  const updateEnd = useCallback((ray: THREE.Ray, cursor: THREE.Vector2) => {
    const ts = useToolStore.getState()
    if (!ts.isDrawing || !ts.drawOrigin) return
    const profiles = useStore.getState().profiles
    const origin = ts.drawOrigin

    // Pass 1: which axis is the user pulling along?
    const first = resolveAxisEnd(origin, ray, cursor, camera, size, profiles, ts.lockedAxis)
    if (!first) {
      ts.updateDraw({ startPoint: origin.clone(), currentPoint: origin.clone(), snapPoint: null, drawAxis: null, alignGuides: [] })
      return
    }
    // Horizontal members are lifted so they rest on the floor instead of sinking into it
    const start = origin.clone()
    if (first.axis !== 'y') start.y = Math.max(start.y, floorY(ts.activeSpec))

    const res = start.equals(origin)
      ? first
      : resolveAxisEnd(start, ray, cursor, camera, size, profiles, first.axis)
    if (!res) return

    ts.updateDraw({
      startPoint: start,
      currentPoint: res.end,
      snapPoint: res.snapPoint,
      drawAxis: res.axis,
      alignGuides: res.guide ? [{ from: res.guide.from.toArray() as any, to: res.guide.to.toArray() as any }] : [],
    })
  }, [camera, size])

  const onPointerMove = useCallback((e: any) => {
    const ray: THREE.Ray = e.ray
    const cursor = cursorFromEvent(e)
    lastRay.current = ray.clone()
    lastCursor.current = cursor
    const ts = useToolStore.getState()

    if (ts.isDrawing) {
      updateEnd(ray, cursor)
      return
    }
    const profiles = useStore.getState().profiles
    const pick = pickPoint(ray, cursor, camera, size, profiles)
    if (pick.kind === 'none') { ts.setHover(null, null); return }
    ts.setHover(pick.point, pick.kind === 'ground' ? null : pick.point)
  }, [camera, size, updateEnd])

  const onPointerDown = useCallback((e: any) => {
    const ts = useToolStore.getState()
    // Right button: cancel current draw (orbit keeps working through OrbitControls)
    if (e.button === 2) {
      if (ts.isDrawing) ts.cancelDraw()
      return
    }
    if (e.button !== 0) return

    const ray: THREE.Ray = e.ray
    const cursor = cursorFromEvent(e)

    if (ts.placementMode === 'connector') {
      if (!ts.activeConnectorType) return
      const pick = pickPoint(ray, cursor, camera, size, useStore.getState().profiles)
      if (pick.kind === 'none') return
      placeConnector(pick.point, ts.activeConnectorType)
      return
    }

    if (!ts.isDrawing) {
      const pick = pickPoint(ray, cursor, camera, size, useStore.getState().profiles)
      if (pick.kind === 'none') return
      ts.beginDraw(pick.point)
      return
    }

    updateEnd(ray, cursor)
    const { startPoint: s, currentPoint: c, activeSpec } = useToolStore.getState()
    if (!s || !c) return
    if (s.distanceTo(c) < 1) return // no direction yet — ignore the click
    tryAddProfile(s, c, activeSpec)
    ts.cancelDraw()
  }, [camera, size, updateEnd])

  const { hh } = specDims(activeSpec)

  return (
    <>
      {/* Invisible catcher sphere — receives pointer events regardless of camera angle */}
      {viewMode === 'draw' && (
        <mesh onPointerDown={onPointerDown} onPointerMove={onPointerMove}>
          <sphereGeometry args={[50000, 8, 6]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.BackSide} />
        </mesh>
      )}

      {/* Centerline of the member being drawn */}
      {isDrawing && startPoint && currentPoint && drawDist > 1 && (
        <Line points={[startPoint.toArray(), currentPoint.toArray()]} color={axisColor} lineWidth={2} />
      )}

      {/* Start marker */}
      {isDrawing && startPoint && (
        <mesh position={startPoint} raycast={() => null}>
          <sphereGeometry args={[3, 12, 12]} />
          <meshBasicMaterial color={axisColor} />
        </mesh>
      )}

      {/* Member preview */}
      {placementMode === 'profile' && xform && (
        <mesh position={xform.pos} quaternion={xform.quat} scale={[1, 1, xform.scale]} geometry={previewGeo} raycast={() => null}>
          <meshStandardMaterial color={axisColor} metalness={0.3} roughness={0.6} transparent opacity={0.65} depthWrite={false} />
        </mesh>
      )}

      {/* Snap indicator (endpoint / centerline hit) */}
      {viewMode === 'draw' && snapPoint && (
        <mesh position={snapPoint} raycast={() => null}>
          <sphereGeometry args={[4, 16, 16]} />
          <meshBasicMaterial color="#facc15" />
        </mesh>
      )}

      {/* Hover cursor on the floor when not snapped */}
      {viewMode === 'draw' && !isDrawing && currentPoint && !snapPoint && (
        <mesh position={[currentPoint.x, currentPoint.y + 0.2, currentPoint.z]} rotation={[-Math.PI / 2, 0, 0]} raycast={() => null}>
          <ringGeometry args={[hh * 0.6, hh * 0.9, 24]} />
          <meshBasicMaterial color="#94a3b8" transparent opacity={0.8} side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* Alignment guides */}
      {alignGuides.map((g, i) => (
        <Line key={i} points={[g.from, g.to]} color="#a78bfa" lineWidth={1} dashed dashSize={8} gapSize={5} />
      ))}

      {/* Connector preview */}
      {viewMode === 'draw' && placementMode === 'connector' && currentPoint && (
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
