import React, { useMemo, useCallback, useRef } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { Line } from '@react-three/drei'
import { useToolStore } from '../store/useToolStore'
import { useStore } from '../store/useStore'
import { getProfileShape } from '../utils/profileShapes'
import { pickPoint, resolveAxisEnd, type MeshHit } from '../utils/pickUtils'
import SnapMarker from './SnapMarker'
import { floorY, tryAddProfile, placeConnector } from '../utils/profileFactory'
import { specDims } from '../utils/specUtils'

const AXIS_COLORS: Record<string, string> = { x: '#ef4444', y: '#22c55e', z: '#3b82f6' }

const DrawingHandler: React.FC = () => {
  const { isDrawing, startPoint, currentPoint, snapPoint, snapKind, placementMode, activeSpec, viewMode, drawAxis, alignGuides } = useToolStore()
  const { camera, size, scene } = useThree()
  const raycaster = useMemo(() => new THREE.Raycaster(), [])

  /** First member body under the ray (the catcher sphere and markers are skipped) */
  const hitMember = useCallback((ray: THREE.Ray): MeshHit | null => {
    raycaster.ray.copy(ray)
    const meshes: THREE.Object3D[] = []
    scene.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.userData?.profileId) meshes.push(o) })
    const hits = raycaster.intersectObjects(meshes, false)
    const h = hits[0]
    if (!h || !h.face) return null
    const normal = h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize()
    return { profileId: h.object.userData.profileId as string, point: h.point.clone(), normal }
  }, [raycaster, scene])
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

    const meshHit = hitMember(ray)
    // Pass 1: which axis is the user pulling along?
    const first = resolveAxisEnd(origin, ray, cursor, camera, size, profiles, ts.lockedAxis, meshHit)
    if (!first) {
      ts.updateDraw({ startPoint: origin.clone(), currentPoint: origin.clone(), snapPoint: null, drawAxis: null, alignGuides: [], snapKind: null, hoverTargetId: null })
      return
    }
    // Horizontal members are lifted so they rest on the floor instead of sinking into it
    const start = origin.clone()
    if (first.axis !== 'y') start.y = Math.max(start.y, floorY(ts.activeSpec))

    const res = start.equals(origin)
      ? first
      : resolveAxisEnd(start, ray, cursor, camera, size, profiles, first.axis, meshHit)
    if (!res) return

    ts.updateDraw({
      startPoint: start,
      currentPoint: res.end,
      snapPoint: res.snapKind === 'grid' ? null : res.end.clone(),
      snapKind: res.snapKind,
      hoverTargetId: res.targetId,
      drawAxis: res.axis,
      alignGuides: res.guide ? [{ from: res.guide.from.toArray() as any, to: res.guide.to.toArray() as any }] : [],
    })
  }, [camera, size, hitMember])

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
    const pick = pickPoint(ray, cursor, camera, size, profiles, hitMember(ray))
    if (pick.kind === 'none') { ts.setHover(null, null); ts.updateDraw({ alignGuides: [] }); return }
    const aligned = pick.kind === 'ground' && (pick.guides?.length ?? 0) > 0
    ts.setHover(pick.point, aligned || pick.kind !== 'ground' ? pick.point : null, pick.kind === 'ground' ? (aligned ? 'align' : null) : pick.kind, pick.profileId ?? null)
    ts.updateDraw({ alignGuides: (pick.guides ?? []).map((g) => ({ from: g.from.toArray() as any, to: g.to.toArray() as any })) })
  }, [camera, size, updateEnd, hitMember])

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
      const pick = pickPoint(ray, cursor, camera, size, useStore.getState().profiles, hitMember(ray))
      if (pick.kind === 'none') return
      placeConnector(pick.point, ts.activeConnectorType)
      return
    }

    if (!ts.isDrawing) {
      const pick = pickPoint(ray, cursor, camera, size, useStore.getState().profiles, hitMember(ray))
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
  }, [camera, size, updateEnd, hitMember])

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
      {isDrawing && startPoint && <SnapMarker position={startPoint} kind="start" size={0.022} />}

      {/* Member preview */}
      {placementMode === 'profile' && xform && (
        <mesh position={xform.pos} quaternion={xform.quat} scale={[1, 1, xform.scale]} geometry={previewGeo} raycast={() => null}>
          <meshStandardMaterial color={axisColor} metalness={0.3} roughness={0.6} transparent opacity={0.65} depthWrite={false} />
        </mesh>
      )}

      {/* Snap indicator (endpoint / centerline / alignment) — constant screen size */}
      {viewMode === 'draw' && snapPoint && <SnapMarker position={snapPoint} kind={snapKind ?? 'endpoint'} />}

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
