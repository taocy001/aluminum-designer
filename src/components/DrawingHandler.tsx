import React, { useMemo, useCallback, useRef, useEffect } from 'react'
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
import { connectorSeatAt } from '../utils/bracketSeat'
import Connector from './Connector'
import { translations } from '../utils/translations'

const AXIS_COLORS: Record<string, string> = { x: '#ef4444', y: '#22c55e', z: '#3b82f6' }
/** a left press that travels this far orbits the camera instead of placing a point */
const ORBIT_SLOP_PX = 5

const DrawingHandler: React.FC = () => {
  const { isDrawing, startPoint, currentPoint, snapPoint, snapKind, held, activeSpec, activeConnectorType, drawAxis, alignGuides } = useToolStore()
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
  const rightDownRef = useRef<{ x: number; y: number } | null>(null)
  /** surface the pointer is over, so a face-mounted part knows which side it was dropped on */
  const hoverNormal = useRef<THREE.Vector3 | null>(null)
  /** set while a press in draw mode is moving a member rather than drawing */
  const draggedThisPress = useRef(false)
  /** left press in draw mode: a click places a point, a press-and-drag orbits the camera */
  const leftDownRef = useRef<{ x: number; y: number; ray: THREE.Ray; cursor: THREE.Vector2; orbiting: boolean } | null>(null)

  // Right-click cancels only when the pointer did not travel (a right-drag is an orbit)
  useEffect(() => {
    const onUp = (e: PointerEvent) => {
      if (e.button !== 2) return   // a left-click release must not consume the pending right-click
      const down = rightDownRef.current
      rightDownRef.current = null
      if (!down) return
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return
      const ts = useToolStore.getState()
      if (!ts.isDrawing) return
      ts.cancelDraw()
      ts.showToast(translations[ts.language].toastDrawCancelled, 'info')
    }
    window.addEventListener('pointerup', onUp)
    return () => window.removeEventListener('pointerup', onUp)
  }, [])

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

    // while the left button is held and the pointer travels, the gesture is an orbit:
    // freeze the preview so the line does not chase the camera
    if (useToolStore.getState().isDragging) { draggedThisPress.current = true; return }
    const down = leftDownRef.current
    if (down) {
      const moved = Math.hypot(e.nativeEvent.clientX - down.x, e.nativeEvent.clientY - down.y)
      if (moved > ORBIT_SLOP_PX) down.orbiting = true
      if (down.orbiting) return
    }

    if (ts.isDrawing) {
      updateEnd(ray, cursor)
      return
    }
    const profiles = useStore.getState().profiles
    const pick = pickPoint(ray, cursor, camera, size, profiles, hitMember(ray), ts.workPlaneY)
    hoverNormal.current = pick.normal ?? null
    if (pick.kind === 'none') { ts.setHover(null, null); ts.updateDraw({ alignGuides: [] }); return }
    const aligned = pick.kind === 'ground' && (pick.guides?.length ?? 0) > 0
    ts.setHover(pick.point, aligned || pick.kind !== 'ground' ? pick.point : null, pick.kind === 'ground' ? (aligned ? 'align' : null) : pick.kind, pick.profileId ?? null)
    ts.updateDraw({ alignGuides: (pick.guides ?? []).map((g) => ({ from: g.from.toArray() as any, to: g.to.toArray() as any })) })
  }, [camera, size, updateEnd, hitMember])

  const onPointerDown = useCallback((e: any) => {
    const ts = useToolStore.getState()
    // Right button: a plain click cancels the draw, a drag orbits the camera (decided on release)
    if (e.button === 2) {
      rightDownRef.current = { x: e.nativeEvent.clientX, y: e.nativeEvent.clientY }
      return
    }
    if (e.button !== 0) return
    // while a suggestion is showing, a click answers it rather than drawing
    if (ts.suggestion) { leftDownRef.current = null; return }

    // Decide on release: a click draws, a press-and-drag orbits. The press ray is kept so a
    // tap without a preceding move still places a point, and a release outside the canvas does not.
    leftDownRef.current = {
      x: e.nativeEvent.clientX, y: e.nativeEvent.clientY,
      ray: (e.ray as THREE.Ray).clone(), cursor: cursorFromEvent(e), orbiting: false,
    }
    void ts
  }, [camera, size, updateEnd])

  /** The actual placement, run on release when the gesture turned out to be a click */
  const placeAt = useCallback((ray: THREE.Ray, cursor: THREE.Vector2) => {
    const ts = useToolStore.getState()
    if (ts.suggestion) return

    if (ts.held === 'connector') {
      if (!ts.activeConnectorType) return
      const pick = pickPoint(ray, cursor, camera, size, useStore.getState().profiles, hitMember(ray), ts.workPlaneY)
      if (pick.kind === 'none') return
      placeConnector(pick.point, ts.activeConnectorType, pick.normal ?? null)
      return
    }

    if (!ts.isDrawing) {
      const pick = pickPoint(ray, cursor, camera, size, useStore.getState().profiles, hitMember(ray), ts.workPlaneY)
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

  // Release decides between drawing and orbiting
  useEffect(() => {
    const onUp = (e: PointerEvent) => {
      if (e.button !== 0) return               // another button's release must not eat the press
      const down = leftDownRef.current
      leftDownRef.current = null
      if (!down) return
      const ts = useToolStore.getState()
      if (!ts.held) return
      if (ts.isDragging || draggedThisPress.current) { draggedThisPress.current = false; return }  // the press moved a member
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
      if (down.orbiting || moved > ORBIT_SLOP_PX) return  // it was a camera move
      // the press ray is the fresh one: a hover ray can predate a camera change or a tap
      placeAt(down.ray, down.cursor)
    }
    window.addEventListener('pointerup', onUp)
    return () => window.removeEventListener('pointerup', onUp)
  }, [placeAt])

  const { hh } = specDims(activeSpec)

  // The ghost asks the placement the same question it will ask on the click, so the part
  // does not jump when the button goes down — near a corner it lands on the joint, seated
  // on its slots, which is some way from wherever the pointer happens to be.
  const connectorPreview = useMemo(() => {
    if (held !== 'connector' || !activeConnectorType || !currentPoint) return null
    return connectorSeatAt(activeConnectorType, currentPoint, useStore.getState().profiles, hoverNormal.current)
  }, [held, activeConnectorType, currentPoint])

  return (
    <>
      {/* Invisible catcher sphere — receives pointer events regardless of camera angle */}
      {held !== null && (
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

      {/* Member preview: a neutral ghost. The axis colour lives on the centreline and the
          HUD instead, so a member being drawn along X is never mistaken for one flagged red. */}
      {held === 'profile' && xform && (
        <mesh position={xform.pos} quaternion={xform.quat} scale={[1, 1, xform.scale]} geometry={previewGeo} raycast={() => null}>
          <meshStandardMaterial color="#cbd5e1" metalness={0.2} roughness={0.7} transparent opacity={0.6} depthWrite={false} />
        </mesh>
      )}

      {/* Snap indicator (endpoint / centerline / alignment) — constant screen size.
          While placing a connector the ghost itself shows the spot, and the marker would
          sit right on top of a part that is only a few tens of millimetres across. */}
      {held === 'profile' && snapPoint && (
        <SnapMarker position={snapPoint} kind={snapKind ?? 'endpoint'} />
      )}

      {/* Hover cursor on the floor when not snapped */}
      {held !== null && !isDrawing && currentPoint && !snapPoint && (
        <mesh position={[currentPoint.x, currentPoint.y + 0.2, currentPoint.z]} rotation={[-Math.PI / 2, 0, 0]} raycast={() => null}>
          <ringGeometry args={[hh * 0.6, hh * 0.9, 24]} />
          <meshBasicMaterial color="#94a3b8" transparent opacity={0.8} side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* Alignment guides */}
      {alignGuides.map((g, i) => (
        <Line key={i} points={[g.from, g.to]} color="#a78bfa" lineWidth={1} dashed dashSize={8} gapSize={5} />
      ))}

      {/* Connector preview: the real part, where it would land.
          A bracket is twenty millimetres on a frame metres across — at any useful zoom it is
          a few pixels, and a few translucent pixels are none. So it comes with a ring that
          keeps its size on screen whatever the zoom, and a line back to the pointer when the
          part has settled onto a joint some way off. */}
      {held === 'connector' && activeConnectorType && currentPoint && connectorPreview && (
        <>
          <Connector
            type={activeConnectorType}
            series={connectorPreview.series}
            position={connectorPreview.position}
            quaternion={connectorPreview.quaternion}
            preview
          />
          <SnapMarker position={connectorPreview.position} kind={connectorPreview.seated ? 'seat' : 'loose'} size={0.055} />
          {connectorPreview.seated
            && currentPoint.distanceTo(new THREE.Vector3(...connectorPreview.position)) > 8 && (
            <Line points={[currentPoint.toArray(), connectorPreview.position]}
              color="#34d399" lineWidth={1.5} dashed dashSize={6} gapSize={4} />
          )}
        </>
      )}
    </>
  )
}

export default DrawingHandler
