import React, { useMemo, useCallback, useRef, useEffect, useState } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { Html, Line } from '@react-three/drei'
import { useToolStore } from '../store/useToolStore'
import { useStore } from '../store/useStore'
import { getProfileShape } from '../utils/profileShapes'
import { pickDrawingStart } from '../utils/pickDrawingStart'
import { modelPointFromHit, pickPoint, resolveAxisEnd, type MeshHit } from '../utils/pickUtils'
import SnapMarker from './SnapMarker'
import { floorY, tryAddProfile, placeConnector } from '../utils/profileFactory'
import { specDims } from '../utils/specUtils'
import { resolveConnectorPlacement } from '../utils/connectorPlacement'
import { connectorEntry } from '../utils/connectorCatalog'
import { profileBodyEndpoints, profileFace } from '../utils/profileFaces'
import Connector from './Connector'
import { translations } from '../utils/translations'
import { drawingInput, drawingStartAnchor, prepareDrawingPreview } from '../utils/drawPreview'
import { computeTrims } from '../utils/jointUtils'
import { FacePatch } from './SnapFaces'
import { DrawContactGuides } from './DrawContactGuides'
import { gizmoState } from './TransformGizmo'

const AXIS_COLORS: Record<string, string> = { x: '#ef4444', y: '#22c55e', z: '#3b82f6' }
/** a left press that travels this far orbits the camera instead of placing a point */
const ORBIT_SLOP_PX = 5

const DrawingHandler: React.FC = () => {
  const { isDrawing, isDragging, startPoint, currentPoint, snapPoint, snapKind, held, activeSpec, activeConnectorType, drawAxis, alignGuides, drawStartFace, drawSnapFace, drawStartAlignmentFace, drawSnapAlignmentFace, drawLengthInput, language } = useToolStore()
  const profiles = useStore((s) => s.profiles)
  const connectors = useStore((s) => s.connectors)
  const throughRule = useStore((s) => s.throughRule)
  const { camera, size, scene, gl } = useThree()
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
  /** Only canvas events update this point; moving onto the HUD must not steer a draft. */
  const lastCanvasPointer = useRef<THREE.Vector2 | null>(null)
  const pointerOnCanvas = useRef(false)
  const pointerButtons = useRef(0)
  const rightDownRef = useRef<{ x: number; y: number } | null>(null)
  /** surface the pointer is over, so a face-mounted part knows which side it was dropped on */
  const hoverNormal = useRef<THREE.Vector3 | null>(null)
  const hoverJointPoint = useRef<THREE.Vector3 | null>(null)
  const [connectorSelection, setConnectorSelection] = useState<number | string>(0)
  const connectorChoice = useRef<{ choice: number | string; cursor: THREE.Vector2; type: string }>({
    choice: 0, cursor: new THREE.Vector2(Infinity, Infinity), type: '',
  })
  const choiceAt = useCallback((cursor: THREE.Vector2, type: string) => {
    const previous = connectorChoice.current
    if (previous.type !== type || previous.cursor.distanceTo(cursor) > 3) {
      connectorChoice.current = { choice: 0, cursor: cursor.clone(), type }
      setConnectorSelection(0)
      return 0
    }
    return previous.choice
  }, [])
  const cycleConnector = useCallback((step: number) => {
    const ts = useToolStore.getState(), store = useStore.getState()
    if (ts.held !== 'connector' || !ts.activeConnectorType || !ts.currentPoint) return
    const current = resolveConnectorPlacement(ts.activeConnectorType, ts.currentPoint,
      store.profiles, store.connectors, hoverNormal.current, connectorChoice.current.choice, hoverJointPoint.current ?? undefined)
    if (current.count < 2) return
    const index = (current.index + step + current.count) % current.count
    const key = current.keys[index]
    connectorChoice.current.choice = key
    const pointer = lastCanvasPointer.current
    if (pointer) {
      const rect = gl.domElement.getBoundingClientRect()
      connectorChoice.current.cursor.set(pointer.x - rect.left, pointer.y - rect.top)
    }
    setConnectorSelection(key)
  }, [gl])

  useEffect(() => {
    connectorChoice.current = { choice: 0, cursor: new THREE.Vector2(Infinity, Infinity), type: activeConnectorType ?? '' }
    setConnectorSelection(0)
  }, [held, activeConnectorType])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || useToolStore.getState().held !== 'connector' || !pointerOnCanvas.current) return
      if ((event.target as HTMLElement | null)?.closest('input,textarea,select,button,[contenteditable="true"]')) return
      event.preventDefault()
      cycleConnector(event.shiftKey ? -1 : 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cycleConnector])
  /** set while a press in draw mode is moving a member rather than drawing */
  const draggedThisPress = useRef(false)
  /** left press in draw mode: a click places a point, a press-and-drag orbits the camera */
  const leftDownRef = useRef<{ x: number; y: number; ray: THREE.Ray; cursor: THREE.Vector2; orbiting: boolean } | null>(null)
  const consumePointer = useCallback(() => {
    leftDownRef.current = null
    rightDownRef.current = null
    pointerButtons.current = 0
    draggedThisPress.current = false
  }, [])

  useEffect(() => {
    const canvas = gl.domElement
    const enter = () => { pointerOnCanvas.current = true }
    const leave = () => { pointerOnCanvas.current = false }
    const down = (event: PointerEvent) => { pointerButtons.current = event.buttons }
    const move = (event: PointerEvent) => { pointerButtons.current = event.buttons }
    const up = (event: PointerEvent) => { pointerButtons.current = event.buttons }
    canvas.addEventListener('pointerenter', enter)
    canvas.addEventListener('pointerleave', leave)
    canvas.addEventListener('pointerdown', down)
    canvas.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      canvas.removeEventListener('pointerenter', enter)
      canvas.removeEventListener('pointerleave', leave)
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [gl])

  // Right-click cancels only when the pointer did not travel (a right-drag is an orbit)
  useEffect(() => {
    gl.domElement.addEventListener('aluframe:consume-pointer', consumePointer)
    window.addEventListener('pointercancel', consumePointer)
    window.addEventListener('blur', consumePointer)
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
    return () => {
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', consumePointer)
      window.removeEventListener('blur', consumePointer)
      gl.domElement.removeEventListener('aluframe:consume-pointer', consumePointer)
    }
  }, [gl, consumePointer])

  const previewGeo = useMemo(() => {
    const shape = getProfileShape(activeSpec)
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false })
    geo.computeVertexNormals()
    return geo
  }, [activeSpec])
  useEffect(() => () => previewGeo.dispose(), [previewGeo])

  const xform = useMemo(() => {
    if (!isDrawing || !startPoint || !currentPoint) return null
    return prepareDrawingPreview(startPoint, currentPoint, activeSpec, profiles, { startFace: drawStartFace, endFace: drawSnapFace, startAlignmentFace: drawStartAlignmentFace }, drawLengthInput)
  }, [isDrawing, startPoint, currentPoint, activeSpec, profiles, throughRule, drawStartFace, drawSnapFace, drawStartAlignmentFace, drawLengthInput])
  const invalidLengthInput = drawLengthInput.trim() !== '' && (!Number.isFinite(Number(drawLengthInput)) || Number(drawLengthInput) < 10)
  const previewEnd = xform && xform.position.clone().addScaledVector(new THREE.Vector3(0, 0, 1).applyQuaternion(xform.quaternion), xform.cutLength)
  const faceMessage = invalidLengthInput ? translations[language].toastTooShort
    : xform?.issue === 'face-direction' ? translations[language].faceDirectionBlocked
    : xform?.issue === 'face-oblique' ? translations[language].faceObliqueBlocked
    : xform?.issue === 'face-end-conflict' ? translations[language].faceEndConflict
    : xform?.issue === 'face-too-short' ? translations[language].toastTooShort : null

  const pendingFace = isDrawing ? drawStartFace : drawSnapFace
  const hoverFace = useMemo(() => {
    const target = pendingFace && profiles.find((p) => p.id === pendingFace.profileId)
    return target && pendingFace ? profileFace(target, pendingFace, computeTrims(target, profiles)) : null
  }, [pendingFace, profiles, throughRule])
  const pendingPoint = isDrawing ? startPoint : currentPoint
  const pendingAlignment = isDrawing ? drawStartAlignmentFace : drawSnapAlignmentFace
  const hoverAnchor = useMemo(() => hoverFace && pendingPoint
    ? drawingStartAnchor(pendingPoint, activeSpec, profiles, hoverFace, pendingAlignment) : null,
  [pendingPoint, activeSpec, profiles, hoverFace, pendingAlignment])
  const alignmentFace = useMemo(() => {
    const target = pendingAlignment && profiles.find((p) => p.id === pendingAlignment.profileId)
    return target && pendingAlignment ? profileFace(target, pendingAlignment, computeTrims(target, profiles)) : null
  }, [pendingAlignment, profiles, throughRule])
  const alignmentEdge = useMemo(() => {
    if (!alignmentFace || !hoverFace) return []
    const normal = new THREE.Vector3(...hoverFace.normal)
    const center = new THREE.Vector3(...hoverFace.center)
    const edge = alignmentFace.corners.filter((point) => Math.abs(new THREE.Vector3(...point).sub(center).dot(normal)) < 0.001)
    if (edge.length !== 2 || alignmentFace.axis === 2 || !pendingPoint) return edge
    // A T joint belongs to a small part of the through rail's long edge. Emphasize
    // the chosen position, rather than suggesting that its entire side is the joint.
    const a = new THREE.Vector3(...edge[0]), b = new THREE.Vector3(...edge[1])
    const along = b.clone().sub(a).normalize(), length = a.distanceTo(b)
    const at = THREE.MathUtils.clamp(pendingPoint.clone().sub(a).dot(along), 0, length)
    const { hw, hh } = specDims(activeSpec)
    const half = Math.max(20, hw, hh)
    return [a.clone().addScaledVector(along, Math.max(0, at - half)).toArray(),
      a.clone().addScaledVector(along, Math.min(length, at + half)).toArray()] as [number, number, number][]
  }, [alignmentFace, hoverFace, pendingPoint, activeSpec])

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
    const first = resolveAxisEnd(origin, ray, cursor, camera, size, profiles, ts.lockedAxis, meshHit, ts.drawSnapFace)
    if (!first) {
      ts.updateDraw({ startPoint: origin.clone(), currentPoint: origin.clone(), snapPoint: null, drawAxis: null, alignGuides: [], snapKind: null, hoverTargetId: null, drawSnapFace: null })
      return
    }
    // Horizontal members are lifted so they rest on the floor instead of sinking into it
    const start = origin.clone()
    if (first.axis !== 'y') start.y = Math.max(start.y, floorY(ts.activeSpec))

    let res = start.equals(origin)
      ? first
      : resolveAxisEnd(start, ray, cursor, camera, size, profiles, first.axis, meshHit, ts.drawSnapFace)
    if (!res) return

    // The selected start face may offset the section sideways. Resolve the target
    // along that actual section axis while keeping the original construction point.
    const startPreview = prepareDrawingPreview(start, res.end, ts.activeSpec, profiles, { startFace: ts.drawStartFace, startAlignmentFace: ts.drawStartAlignmentFace })
    if (startPreview && !startPreview.blocked) {
      const offset = new THREE.Vector3(...startPreview.profile.position).sub(start)
      offset.addScaledVector(res.dir, -offset.dot(res.dir))
      if (offset.lengthSq() > 1e-6) {
        const adjusted = resolveAxisEnd(start.clone().add(offset), ray, cursor, camera, size, profiles, res.axis, meshHit, ts.drawSnapFace)
        if (adjusted) res = { ...adjusted, end: adjusted.end.clone().sub(offset) }
      }
    }

    ts.updateDraw({
      startPoint: start,
      currentPoint: res.end,
      snapPoint: res.snapKind === 'grid' ? null : res.end.clone(),
      snapKind: res.snapKind,
      hoverTargetId: res.targetId,
      drawSnapFace: res.face,
      drawAxis: res.axis,
      alignGuides: res.guide ? [{ from: res.guide.from.toArray() as any, to: res.guide.to.toArray() as any }] : [],
    })
  }, [camera, size, hitMember])

  const updateHover = useCallback((ray: THREE.Ray, cursor: THREE.Vector2) => {
    const ts = useToolStore.getState()
    const profiles = useStore.getState().profiles
    const hit = hitMember(ray)
    const cornerHit = hit && ts.held === 'connector' && connectorEntry(ts.activeConnectorType ?? '')?.fit === 'corner'
    const pick: ReturnType<typeof pickDrawingStart> = ts.held === 'profile'
      ? pickDrawingStart(ray, cursor, camera, size, profiles, hit, ts.workPlaneY, ts.drawSnapFace)
      : cornerHit ? { ...hit, kind: 'segment' }
      : pickPoint(ray, cursor, camera, size, profiles, hit, ts.workPlaneY, ts.drawSnapFace)
    if (ts.held === 'connector') choiceAt(cursor, ts.activeConnectorType ?? '')
    hoverNormal.current = pick.normal ?? null
    hoverJointPoint.current = cornerHit ? modelPointFromHit(hit, profiles, ray)?.point ?? null : null
    if (pick.kind === 'none') { ts.setHover(null, null); ts.updateDraw({ alignGuides: [] }); return }
    const aligned = pick.kind === 'ground' && (pick.guides?.length ?? 0) > 0
    ts.setHover(pick.point, aligned || pick.kind !== 'ground' ? pick.point : null, pick.kind === 'ground' ? (aligned ? 'align' : null) : pick.kind, pick.profileId ?? null, pick.face ?? null, pick.alignmentFace ?? null)
    ts.updateDraw({ alignGuides: (pick.guides ?? []).map((g) => ({ from: g.from.toArray() as any, to: g.to.toArray() as any })) })
  }, [camera, size, hitMember, choiceAt])

  const refreshPointer = useCallback(() => {
    const client = lastCanvasPointer.current
    if (!client) return
    const rect = gl.domElement.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const cursor = new THREE.Vector2(client.x - rect.left, client.y - rect.top)
    raycaster.setFromCamera(new THREE.Vector2(cursor.x / rect.width * 2 - 1, 1 - cursor.y / rect.height * 2), camera)
    const ray = raycaster.ray.clone()
    if (useToolStore.getState().isDrawing) updateEnd(ray, cursor)
    else updateHover(ray, cursor)
  }, [camera, gl, raycaster, updateEnd, updateHover])

  // Recompute synchronously with a keyboard/spec change. Waiting for another pointer
  // event (or even the next render) lets an immediate Enter commit the previous axis.
  useEffect(() => useToolStore.subscribe((state, previous) => {
    if (!state.isDrawing || state.isDragging) return
    if (state.lockedAxis !== previous.lockedAxis || state.activeSpec !== previous.activeSpec) refreshPointer()
  }), [refreshPointer])

  const lastView = useRef({ world: new THREE.Matrix4(), projection: new THREE.Matrix4(), width: 0, height: 0 })
  useFrame(() => {
    const previous = lastView.current
    if (previous.world.equals(camera.matrixWorld) && previous.projection.equals(camera.projectionMatrix)
      && previous.width === size.width && previous.height === size.height) return
    previous.world.copy(camera.matrixWorld); previous.projection.copy(camera.projectionMatrix)
    previous.width = size.width; previous.height = size.height
    const ts = useToolStore.getState()
    // During orbit/pan the draft stays put. A stationary canvas pointer after a wheel
    // zoom needs a fresh ray, while a pointer on a toolbar/HUD keeps its chosen point.
    if (pointerOnCanvas.current && pointerButtons.current === 0 && ts.held && !ts.viewMode && !ts.isDragging) refreshPointer()
  })

  const onPointerMove = useCallback((e: any) => {
    const ray: THREE.Ray = e.ray
    const cursor = cursorFromEvent(e)
    lastCanvasPointer.current = new THREE.Vector2(e.nativeEvent.clientX, e.nativeEvent.clientY)
    pointerOnCanvas.current = true
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
    updateHover(ray, cursor)
  }, [size, updateEnd, updateHover])

  const onPointerDown = useCallback((e: any) => {
    const ts = useToolStore.getState()
    if (gizmoState.busy) { leftDownRef.current = null; return }
    lastCanvasPointer.current = new THREE.Vector2(e.nativeEvent.clientX, e.nativeEvent.clientY)
    pointerOnCanvas.current = true
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
      const profiles = useStore.getState().profiles
      const hit = hitMember(ray)
      const cornerHit = hit && connectorEntry(ts.activeConnectorType)?.fit === 'corner'
      const pick = cornerHit ? { ...hit, kind: 'segment' as const }
        : pickPoint(ray, cursor, camera, size, profiles, hit, ts.workPlaneY)
      if (pick.kind === 'none') return
      const jointPoint = cornerHit ? modelPointFromHit(hit, profiles, ray)?.point : undefined
      placeConnector(pick.point, ts.activeConnectorType, pick.normal ?? null, choiceAt(cursor, ts.activeConnectorType), jointPoint)
      return
    }

    if (!ts.isDrawing) {
      const pick = pickDrawingStart(ray, cursor, camera, size, useStore.getState().profiles, hitMember(ray), ts.workPlaneY, ts.drawSnapFace)
      if (pick.kind === 'none') return
      ts.beginDraw(pick.point, pick.face, pick.alignmentFace)
      return
    }

    updateEnd(ray, cursor)
    const { startPoint: s, currentPoint: c, activeSpec, drawStartFace, drawSnapFace, drawStartAlignmentFace, drawLengthInput } = useToolStore.getState()
    if (!s || !c) return
    if (s.distanceTo(c) < 1) return // no direction yet — ignore the click
    const input = drawingInput(s, c, { startFace: drawStartFace, endFace: drawSnapFace, startAlignmentFace: drawStartAlignmentFace }, drawLengthInput)
    if (!input) return
    if (tryAddProfile(s, input.end, activeSpec, input.faces)) ts.cancelDraw()
  }, [camera, size, updateEnd, hitMember, choiceAt])

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

  const connectorPlacement = useMemo(() => {
    if (held !== 'connector' || !activeConnectorType || !currentPoint) return null
    return resolveConnectorPlacement(activeConnectorType, currentPoint, profiles, connectors, hoverNormal.current,
      connectorSelection, hoverJointPoint.current ?? undefined)
  }, [held, activeConnectorType, currentPoint, profiles, connectors, throughRule, connectorSelection])
  const connectorPreview = connectorPlacement?.seat

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
      {isDrawing && !invalidLengthInput && startPoint && currentPoint && drawDist > 1 && (
        <Line points={[(xform?.position ?? startPoint).toArray(), (previewEnd ?? currentPoint).toArray()]} color={axisColor} lineWidth={2} />
      )}

      {/* Start marker */}
      {isDrawing && startPoint && !xform?.contacts.some((c) => c.end === 'start') && <SnapMarker position={xform?.position ?? hoverAnchor ?? startPoint} kind="start" size={0.022} />}

      {/* Member preview: a neutral ghost. The axis colour lives on the centreline and the
          HUD instead, so a member being drawn along X is never mistaken for one flagged red. */}
      {held === 'profile' && xform && (
        <mesh position={xform.position} quaternion={xform.quaternion} scale={[1, 1, xform.cutLength]} geometry={previewGeo} raycast={() => null}
          userData={{ drawingPreview: true, previewProfile: xform.profile }}>
          <meshStandardMaterial color={xform.blocked ? '#f87171' : '#cbd5e1'} metalness={0.2} roughness={0.7} transparent opacity={0.6} depthWrite={false} />
        </mesh>
      )}

      {held === 'profile' && isDrawing && faceMessage && <Html fullscreen style={{ pointerEvents: 'none' }}>
        <div data-testid="face-placement-status" role="status"
          className="absolute bottom-14 left-1/2 -translate-x-1/2 w-max max-w-[calc(100vw-2rem)] rounded-lg border border-amber-400/50 bg-slate-900/95 px-3 py-2 text-center text-xs text-amber-200">
          {faceMessage}
        </div>
      </Html>}

      {held === 'profile' && !isDragging && (!isDrawing || !xform) && hoverFace && (
        <FacePatch face={hoverFace} anchor={hoverAnchor ?? undefined} color="#22d3ee" role="target"
          fillOpacity={0.32} lineWidth={4} />
      )}
      {held === 'profile' && !isDragging && (!isDrawing || !xform) && alignmentFace && <>
        <FacePatch face={alignmentFace} color="#22d3ee" role="alignment" showNormal={false} fillOpacity={0.1} lineWidth={2} />
        {alignmentEdge.length === 2 && <Line points={alignmentEdge} color="#67e8f9" lineWidth={5}
          depthTest={false} depthWrite={false} renderOrder={30} raycast={() => null} />}
      </>}
      {held === 'profile' && !isDragging && xform && <DrawContactGuides contacts={xform.contacts} language={language} />}

      {/* Snap indicator (endpoint / centerline / alignment) — constant screen size.
          While placing a connector the ghost itself shows the spot, and the marker would
          sit right on top of a part that is only a few tens of millimetres across. */}
      {held === 'profile' && snapPoint && !xform?.contacts.some((c) => c.end === 'end') && (
        <SnapMarker position={!isDrawing && hoverAnchor ? hoverAnchor : isDrawing && previewEnd ? previewEnd : snapPoint}
          kind={!isDrawing && hoverFace ? 'candidate' : snapKind ?? 'endpoint'} size={!isDrawing && hoverFace ? 0.02 : 0.032} />
      )}

      {/* Hover cursor on the floor when not snapped */}
      {held !== null && !isDrawing && currentPoint && !snapPoint && (
        <mesh position={[currentPoint.x, currentPoint.y + 0.2, currentPoint.z]} rotation={[-Math.PI / 2, 0, 0]} raycast={() => null}>
          <ringGeometry args={[hh * 0.6, hh * 0.9, 24]} />
          <meshBasicMaterial color="#94a3b8" transparent opacity={0.8} side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* Alignment guides */}
      {(!isDrawing || !xform?.contacts.some((c) => c.end === 'end')) && alignGuides.map((g, i) => (
        <Line key={i} points={[g.from, g.to]} color="#a78bfa" lineWidth={1} dashed dashSize={8} gapSize={5} />
      ))}

      {/* Preview and highlighted members share the committed placement choice. */}
      {held === 'connector' && activeConnectorType && currentPoint && connectorPreview && connectorPlacement && (
        <>
          <group userData={{ connectorPreview: true, seatLegs: connectorPlacement.legs }}>
            {connectorPlacement.allowed && <Connector
              type={activeConnectorType}
              series={connectorPreview.series}
              position={connectorPreview.position}
              quaternion={connectorPreview.quaternion}
              preview
            />}
          </group>
          <SnapMarker position={connectorPreview.position} kind={connectorPreview.seated ? 'seat' : 'loose'} size={0.055} />
          {connectorPlacement.legs?.map((id) => {
            const profile = profiles.find((p) => p.id === id)
            if (!profile) return null
            const ends = profileBodyEndpoints(profile, computeTrims(profile, profiles))
            return <Line key={id} points={[ends.start, ends.end]} color="#67e8f9" lineWidth={3}
              transparent opacity={0.65} depthTest={false} depthWrite={false} raycast={() => null} />
          })}
          {connectorEntry(activeConnectorType)?.fit === 'corner' && <Html fullscreen
            calculatePosition={(_, __, viewport) => [viewport.width / 2, viewport.height / 2]}
            // This screen overlay stays visible even when the world origin is behind the camera.
            onOcclude={() => {}} style={{ pointerEvents: 'none' }}>
            <div data-testid="connector-seat-hud" data-seat-index={connectorPlacement.index} data-seat-count={connectorPlacement.count}
              className="absolute bottom-24 md:bottom-14 left-1/2 -translate-x-1/2 flex items-center gap-2 w-max max-w-[calc(100%-2rem)] rounded-lg border border-cyan-400/40 bg-slate-900/95 px-3 py-2 text-center text-xs text-slate-200">
              <span role="status">
                {!connectorPlacement.allowed ? translations[language].connectorNoSeat
                  : translations[language].connectorSeatChoice(connectorPlacement.index + 1, connectorPlacement.count)}
                {connectorPlacement.occupied && <span className="block text-amber-300">{translations[language].connectorOccupied}</span>}
              </span>
            </div>
          </Html>}
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
