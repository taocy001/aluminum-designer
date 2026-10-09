import { useShallow } from 'zustand/react/shallow'
import { useViewStore, isObjectVisible } from '../store/useViewStore'
import { useInspectionStore } from '../store/useInspectionStore'
import React, { Suspense, useEffect, useMemo, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, Grid, Line } from '@react-three/drei'
import * as THREE from 'three'
import { useStore } from '../store/useStore'
import { pickCandidatesAtScreen } from '../utils/screenPick'
import { connectorSeatAt, seatFor } from '../utils/bracketSeat'
import { frontmostId, promoteFrontmost, hitPartId } from '../utils/frontmost'
import { readout } from '../utils/measure'
import SnapMarker from './SnapMarker'
import EditAlignmentGuides from './EditAlignmentGuides'
import { translations } from '../utils/translations'
import { fittingObb, leafObb, fittingBodies } from '../utils/fittingGeometry'
import { equipmentBody, equipmentClearance } from '../utils/equipmentGeometry'
import { obbCorners } from '../utils/obb'
import { cutAway } from '../utils/frontmost'
import { assemblySteps, shownAt } from '../utils/assembly'
import { useToolStore } from '../store/useToolStore'
import { getProfileEndpoints } from '../utils/geometryCore'
import { computeFrameBounds, getProfileDir, type ProfileTrims } from '../utils/jointUtils'
import { analyzeFrame, connectorOBB, panelOBB, type Conflict } from '../utils/analysis'
import type { SpecMismatch } from '../utils/specCompat'
import Profile from './Profile'
import Connectors from './Connectors'
import Panel from './Panel'
import Fitting from './Fitting'
import Equipment from './Equipment'
import Gestures from './Gestures'
import FrameDimensions from './FrameDimensions'
import DrawingHandler from './DrawingHandler'
import ConnectorEditPreview from './ConnectorEditPreview'
import SuggestionGhost from './SuggestionGhost'
import DragHandler from './DragHandler'
import PointerRouter from './PointerRouter'
import ResizeHandles from './ResizeHandles'
import TransformGizmo from './TransformGizmo'
import TextSprite from './TextSprite'
import LabelLayout from './LabelLayout'
import PartNumberLabels from './PartNumberLabels'

const DEFAULT_CAM = new THREE.Vector3(600, 500, 600)

/** how much one press of the zoom buttons moves the camera, as a fraction of its distance */
const ZOOM_STEP = 0.2

// Fits the camera to the whole frame when triggered (or resets when empty)
const CameraController: React.FC = () => {
  const { camera, controls, gl, size } = useThree()
  const cameraResetTrigger = useToolStore((s) => s.cameraResetTrigger)
  const cameraFitScope = useToolStore((s) => s.cameraFitScope)
  const cameraViewRequest = useToolStore((s) => s.cameraViewRequest)
  const zoomStep = useToolStore((s) => s.zoomStep)
  const zoomAt = useToolStore((s) => s.zoomAt)
  const clearZoom = useToolStore((s) => s.clearZoom)
  const focus = useInspectionStore(s => s.focus)
  useEffect(() => {
    if (!focus) return
    const orbit = controls as any
    const target = new THREE.Vector3(...focus.position)
    const direction = camera.position.clone().sub(orbit?.target ?? new THREE.Vector3()).normalize()
    if (direction.lengthSq() < 0.5) direction.copy(DEFAULT_CAM).normalize()
    const persp = camera as THREE.PerspectiveCamera
    const halfFov = Math.min(THREE.MathUtils.degToRad(persp.fov) / 2,
      Math.atan(Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2) * persp.aspect))
    camera.position.copy(target).addScaledVector(direction, 120 / Math.sin(halfFov))
    if (orbit) { orbit.target.copy(target); orbit.update() } else camera.lookAt(target)
  }, [focus, camera, controls])
  const prevTrigger = useRef(0)

  useEffect(() => {
    if (!cameraViewRequest) return
    const orbit = controls as any
    const target = orbit?.target ?? new THREE.Vector3()
    const distance = Math.max(50, camera.position.distanceTo(target))
    const directions = {
      top: new THREE.Vector3(0, 1, 0.000001),
      front: new THREE.Vector3(0, 0, 1),
      right: new THREE.Vector3(1, 0, 0),
      iso: new THREE.Vector3(1, 0.8, 1),
    }
    camera.position.copy(target).addScaledVector(directions[cameraViewRequest.view].normalize(), distance)
    if (orbit) orbit.update()
    else camera.lookAt(target)
  }, [cameraViewRequest, camera, controls])

  // The buttons do what the wheel does: move the camera along its own sight line, keeping
  // what it is looking at in the middle. Within the same limits OrbitControls enforces.
  // A double click means "look here": the point under the cursor becomes what the camera
  // is looking at, and it comes closer. Framing the whole drawing is what the Home button is.
  useEffect(() => {
    if (!zoomAt) return
    const orbit = controls as any
    const target = orbit?.target ?? new THREE.Vector3()
    const to = new THREE.Vector3(...zoomAt)
    const toCam = camera.position.clone().sub(target)
    const next = THREE.MathUtils.clamp(toCam.length() * (1 - ZOOM_STEP * 2), 50, 30000)
    camera.position.copy(to.clone().addScaledVector(toCam.normalize(), next))
    if (orbit) { orbit.target.copy(to); orbit.update() } else camera.lookAt(to)
    clearZoom()
  }, [zoomAt, camera, controls, clearZoom])

  useEffect(() => {
    if (zoomStep === 0) return
    const orbit = controls as any
    const target = orbit?.target ?? new THREE.Vector3()
    const toCam = camera.position.clone().sub(target)
    const dist = toCam.length()
    const next = THREE.MathUtils.clamp(dist * (1 - ZOOM_STEP * Math.sign(zoomStep)), 50, 30000)
    camera.position.copy(target.clone().addScaledVector(toCam.normalize(), next))
    orbit?.update()
    clearZoom()
  }, [zoomStep, camera, controls, clearZoom])

  /**
   * Frame the drawing when the page opens.
   *
   * The camera starts where it starts, which for a new drawing is a sensible place to stand
   * and for a three-metre kitchen restored from the last session is somewhere inside it. It
   * waits for the document because the store hydrates from storage, and it only ever does
   * this once — after that, where the camera is, is where the person put it.
   */
  useEffect(() => {
    // Fit the view only to content present when the page opens.
    const s = useStore.getState()
    if (s.profiles.length + s.connectors.length + s.panels.length + s.fittings.length + s.equipment.length === 0) return
    useToolStore.getState().triggerCameraReset('all')
  }, [])

  useEffect(() => {
    if (cameraResetTrigger === prevTrigger.current) return
    prevTrigger.current = cameraResetTrigger
    const orbit = controls as any
    const doc = useStore.getState()
    const ids = cameraFitScope === 'selection' && doc.selectedIds.length > 0 ? new Set(doc.selectedIds) : null
    const chosen = <T extends { id: string }>(parts: T[]) => parts.filter((p) => isObjectVisible(p.id) && (!ids || ids.has(p.id)))
    let bounds = computeFrameBounds(chosen(doc.profiles))
    const boxes = [
      ...chosen(doc.connectors).map(connectorOBB), ...chosen(doc.panels).map(panelOBB),
      ...chosen(doc.fittings).flatMap((f) => fittingBodies(f)), ...chosen(doc.equipment).map(equipmentBody),
    ]
    for (const box of boxes) for (const point of obbCorners(box)) (bounds ??= new THREE.Box3()).expandByPoint(point)
    let target = new THREE.Vector3(0, 0, 0)
    let pos = DEFAULT_CAM.clone()
    if (bounds) {
      target = bounds.getCenter(new THREE.Vector3())
      const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 100)
      const persp = camera as THREE.PerspectiveCamera
      const verticalHalfFov = THREE.MathUtils.degToRad(persp.fov) / 2
      const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * persp.aspect)
      // Leave room for canvas controls and for the drawing readout that appears
      // after the first click. Fitting to the raw canvas can hide the next joint.
      const canvasRect = gl.domElement.getBoundingClientRect()
      const toolbar = document.querySelector('[data-viewport-toolbar]')?.getBoundingClientRect()
      const hud = document.querySelector('[data-viewport-readout]')?.getBoundingClientRect()
      const drawingSpace = useToolStore.getState().held === 'profile' ? 80 : 0
      const top = Math.max(24, (toolbar?.bottom ?? canvasRect.top) - canvasRect.top + 16 + drawingSpace,
        (hud?.bottom ?? canvasRect.top) - canvasRect.top + 16)
      const heightRatio = Math.max(0.25, 1 - 2 * top / size.height)
      const widthRatio = Math.max(0.25, 1 - 48 / size.width)
      const fitHalfFov = Math.min(Math.atan(Math.tan(verticalHalfFov) * heightRatio),
        Math.atan(Math.tan(horizontalHalfFov) * widthRatio))
      const dist = radius / Math.sin(fitHalfFov) * 1.1
      const direction = camera.position.clone().sub(orbit?.target ?? new THREE.Vector3()).normalize()
      pos = target.clone().addScaledVector(direction, dist)
    }
    camera.position.copy(pos)
    if (orbit) { orbit.target.copy(target); orbit.update() } else camera.lookAt(target)
  }, [cameraResetTrigger, cameraFitScope, camera, controls, gl, size])

  return null
}

/**
 * Resolves a frame-selection rectangle to the parts inside it.
 *
 * Members are caught by their two ends or their middle. Everything else — brackets, boards,
 * doors and drawers — is caught by its own middle, which is the only point every kind of part
 * has. Dragging a box round a row of doors and getting the posts behind them is not a
 * selection anybody asked for.
 */
/** Apply a global clipping plane to profiles, boards, connectors and fittings. Cut faces are uncapped. */
const SectionPlane: React.FC = () => {
  const { gl } = useThree()
  const section = useToolStore((s) => s.section)
  useEffect(() => {
    if (!section) { gl.localClippingEnabled = false; gl.clippingPlanes = []; return }
    const sign = section.flip ? -1 : 1
    const n = new THREE.Vector3(
      section.axis === 'x' ? sign : 0, section.axis === 'y' ? sign : 0, section.axis === 'z' ? sign : 0,
    )
    gl.clippingPlanes = [new THREE.Plane(n, -section.at * sign)]
    return () => { gl.clippingPlanes = [] }
  }, [gl, section])
  return null
}

const FrameSelector: React.FC<{ visibleIds: Set<string> }> = ({ visibleIds }) => {
  const { camera, size } = useThree()
  const frameSelectRect = useToolStore((s) => s.frameSelectRect)
  const clearFrameSelectRect = useToolStore((s) => s.clearFrameSelectRect)

  useEffect(() => {
    if (!frameSelectRect) return
    const { x1, y1, x2, y2 } = frameSelectRect
    clearFrameSelectRect()
    if (x2 - x1 < 5 || y2 - y1 < 5) return

    const inside = (v: THREE.Vector3) => {
      const p = v.clone().project(camera)
      const sx = (p.x + 1) / 2 * size.width
      const sy = (1 - p.y) / 2 * size.height
      return sx >= x1 && sx <= x2 && sy >= y1 && sy <= y2
    }
    const selected: string[] = []
    const s = useStore.getState()
    for (const profile of s.profiles) {
      const { start, end } = getProfileEndpoints(profile)
      const mid = start.clone().lerp(end, 0.5)
      if (inside(start) && inside(end) || inside(mid)) selected.push(profile.id)
    }
    for (const c of s.connectors) if (inside(connectorOBB(c).center)) selected.push(c.id)
    for (const b of s.panels) if (inside(new THREE.Vector3(...b.position))) selected.push(b.id)
    for (const f of s.fittings) if (inside(fittingObb(f).center)) selected.push(f.id)
    for (const e of s.equipment) if (inside(equipmentBody(e).center)) selected.push(e.id)
    s.selectItems(selected.filter(id => visibleIds.has(id)))
  }, [frameSelectRect, camera, size, clearFrameSelectRect, visibleIds])

  return null
}

// Cut-length labels, placed just outside the member body
/** Label each local dimension at its edge: X width, Y height, Z thickness or depth. */
const PartDimensions: React.FC<{
  position: [number, number, number]
  quaternion: [number, number, number, number]
  sizes: Array<[string, number]>
  color: string
  owner: string
}> = ({ position, quaternion, sizes, color, owner }) => {
  const q = useMemo(() => new THREE.Quaternion(...quaternion).normalize(), [quaternion])
  const centre = useMemo(() => new THREE.Vector3(...position), [position])
  const [[wl, w], [hl, h], [tl, t]] = sizes
  const ax = new THREE.Vector3(1, 0, 0).applyQuaternion(q)
  const ay = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
  const az = new THREE.Vector3(0, 0, 1).applyQuaternion(q)
  const mm = (v: number) => String(Math.round(v))
  /**
   * Inside the outline, just in from the edge each one measures.
   *
   * Outside, the labels float in the space around the part and belong to nothing in
   * particular — three numbers in mid-air next to three other parts' numbers. In from the
   * edge, each one is unmistakably on the part and on the side it is measuring, and the part
   * keeps its own outline clear.
   */
  const IN = 26
  const at = (a: THREE.Vector3, d: number, b: THREE.Vector3, e: number) =>
    centre.clone().addScaledVector(a, d).addScaledVector(b, e)
      .addScaledVector(az, t / 2 + 1).toArray() as [number, number, number]
  const inset = (v: number, by: number) => Math.max(0, v / 2 - by)
  return (
    <>
      <TextSprite text={`${wl} ${mm(w)}`} color={color} height={22} owner={owner} position={at(ay, -inset(h, IN), ax, 0)} />
      <TextSprite text={`${hl} ${mm(h)}`} color={color} height={22} owner={owner} position={at(ax, inset(w, IN * 1.6), ay, 0)} />
      <TextSprite text={`${tl} ${mm(t)}`} color={color} height={22} owner={owner} position={at(ax, -inset(w, IN * 1.6), ay, inset(h, IN))} />
    </>
  )
}

/**
 * The size of every part, on the part.
 *
 * A member has one number that matters, its cut length. A board and a drawer have three, and
 * they are labelled with the same letters the properties panel uses — W, H, T for a board and
 * W, H, D for a drawer or a door — because a number on the drawing that does not say which
 * field it is sends you counting axes.
 */
const DimensionLabels: React.FC<{ trims: Map<string, ProfileTrims>; visibleIds: Set<string> }> = ({ trims, visibleIds }) => {
  const profiles = useStore((s) => s.profiles)
  const panels = useStore((s) => s.panels)
  const fittings = useStore((s) => s.fittings)
  const equipment = useStore((s) => s.equipment)
  const mm = (v: number) => String(Math.round(v))
  return (
    <>
      {profiles.filter(p => visibleIds.has(p.id)).map((p) => {
        const { start, end } = getProfileEndpoints(p)
        const mid = start.clone().lerp(end, 0.5)
        const dir = getProfileDir(p)
        if (Math.abs(dir.y) > 0.7) { mid.x += 26; mid.z += 26 } else mid.y += 30
        const cut = trims.get(p.id)?.cutLength ?? p.length
        return <TextSprite key={p.id} text={String(Math.round(cut))} priority={2} owner={p.id} position={mid.toArray() as [number, number, number]} />
      })}

      {panels.filter(p => visibleIds.has(p.id)).map((b) => (
        <PartDimensions key={b.id} owner={b.id}
          position={b.position} quaternion={b.quaternion}
          sizes={[['W', b.width], ['H', b.height], ['T', b.thickness]]} color="#fde68a" />
      ))}

      {equipment.filter(p => visibleIds.has(p.id)).map((e) => <PartDimensions key={e.id} owner={e.id} position={e.position} quaternion={e.quaternion}
        sizes={[['W', e.width], ['H', e.height], ['D', e.depth]]} color="#5eead4" />)}
      {fittings.filter(p => visibleIds.has(p.id)).map((f) => {
        // A door is labelled as the leaf you would cut: its own width, height and thickness,
        // on the leaf and following it open. Its depth is the cabinet's, and "D 670" on a
        // door read as a door 670 thick.
        const leaf = f.kind === 'door' ? leafObb(f, f.open ?? 0) : null
        if (leaf) {
          const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(...leaf.axes))
          return <PartDimensions key={f.id} owner={f.id}
            position={leaf.center.toArray() as [number, number, number]} quaternion={[q.x, q.y, q.z, q.w]}
            sizes={[['W', leaf.half.x * 2], ['H', leaf.half.y * 2], ['T', leaf.half.z * 2]]} color="#7dd3fc" />
        }
        return <PartDimensions key={f.id} owner={f.id}
          position={f.position} quaternion={f.quaternion}
          sizes={[['W', f.width], ['H', f.height], ['D', f.depth]]} color="#7dd3fc" />
      })}
    </>
  )
}

/** Render measurement endpoints and distance above the scene. */
const MeasureOverlay: React.FC = () => {
  const measuring = useToolStore((s) => s.measuring)
  const language = useToolStore((s) => s.language)
  if (!measuring?.from) return null
  const t = translations[language]
  const { from, to } = measuring
  if (!to) {
    return <>
      <SnapMarker position={from} kind="endpoint" />
      <TextSprite text={t.measureHint2} throughWalls position={[from.x, from.y + 60, from.z]} height={22} />
    </>
  }
  const r = readout({ from, to })
  const mid = from.clone().lerp(to, 0.5)
  return (
    <>
      <SnapMarker position={from} kind="endpoint" />
      <SnapMarker position={to} kind="endpoint" />
      <Line points={[from.toArray(), to.toArray()]} color="#facc15" lineWidth={2} />
      <TextSprite throughWalls color="#fde68a" height={26}
        text={`${r.total}`} position={[mid.x, mid.y + 40, mid.z]} />
      <TextSprite throughWalls color="#94a3b8" height={18}
        text={`X ${r.dx} · Y ${r.dy} · Z ${r.dz}`} position={[mid.x, mid.y + 10, mid.z]} />
    </>
  )
}

// Dev-only: expose camera helpers for end-to-end tests
const DevHook: React.FC = () => {
  const { camera, size, gl, controls, scene } = useThree()
  useEffect(() => {
    if (!import.meta.env.DEV && !import.meta.env.VITE_TEST_HOOK) return
    const w = window as any
    w.__aluframe = w.__aluframe ?? {}
    w.__aluframe.camera = camera
    w.__aluframe.sceneRoot = scene
    w.__aluframe.controls = controls
    // what the pointer would find at a point on the canvas, for tests and for debugging
    w.__aluframe.THREE = THREE
    w.__aluframe.seatFor = seatFor
    w.__aluframe.leafObb = leafObb
    w.__aluframe.fittingObb = fittingObb
    w.__aluframe.equipmentBody = equipmentBody
    w.__aluframe.equipmentClearance = equipmentClearance
    w.__aluframe.connectorSeatAt = connectorSeatAt
    // what the renderer actually draws at a pixel, by raycasting the real meshes: the
    // yardstick the screen-space picker is measured against
    w.__aluframe.frontmostAt = (clientX: number, clientY: number) => {
      camera.updateMatrixWorld()
      const rect = gl.domElement.getBoundingClientRect()
      const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
      const rc = new THREE.Raycaster()
      rc.setFromCamera(ndc, camera)
      for (const h of rc.intersectObjects(scene.children, true)) {
        if (cutAway(h.point)) continue
        const id = hitPartId(h)
        if (id) return { id, dist: h.distance }
      }
      return null
    }
    w.__aluframe.pickAt = (clientX: number, clientY: number) => {
      camera.updateMatrixWorld()
      const rect = gl.domElement.getBoundingClientRect()
      const cursor = new THREE.Vector2(clientX - rect.left, clientY - rect.top)
      const ndc = new THREE.Vector2((cursor.x / rect.width) * 2 - 1, -(cursor.y / rect.height) * 2 + 1)
      const rc = new THREE.Raycaster()
      rc.setFromCamera(ndc, camera)
      const st = useStore.getState()
      const visible = useToolStore.getState().showFittings ? st.fittings : []
      const list = pickCandidatesAtScreen(cursor, rc.ray, camera, { width: rect.width, height: rect.height },
        st.profiles, st.connectors, st.panels, visible, undefined, st.equipment).filter(p => isObjectVisible(p.id))
      return promoteFrontmost(list, frontmostId(scene, rc.ray, camera)).map((p) => ({ kind: p.kind, id: p.id }))
    }
    w.__aluframe.countByName = (name: string) => {
      let n = 0
      scene.traverse((o: THREE.Object3D) => { if (o.name === name) n++ })
      return n
    }
    w.__aluframe.spriteCount = () => {
      let n = 0
      scene.traverse((o: THREE.Object3D) => { if ((o as THREE.Sprite).isSprite) n++ })
      return n
    }
    w.__aluframe.setView = (pos: [number, number, number], target: [number, number, number] = [0, 0, 0]) => {
      camera.position.set(...pos)
      const orbit = controls as any
      if (orbit) { orbit.target.set(...target); orbit.update() } else camera.lookAt(...target)
    }
    // Project using the current canvas DOM bounds, including layout transitions.
    w.__aluframe.worldToClient = (x: number, y: number, z: number) => {
      // Refresh camera matrices before projecting world coordinates.
      camera.updateMatrixWorld()
      const rect = gl.domElement.getBoundingClientRect()
      const p = new THREE.Vector3(x, y, z).project(camera)
      return { x: rect.left + (p.x + 1) / 2 * rect.width, y: rect.top + (1 - p.y) / 2 * rect.height }
    }
  }, [camera, size, gl, controls, scene])
  return null
}

/**
 * Marks exactly where members interfere: a bright box with a wire outline, drawn through
 * the geometry so the spot is findable even when it sits inside the parts.
 */
const ConflictMarker: React.FC<{ conflict: Conflict; clearance?: boolean }> = ({ conflict, clearance = false }) => {
  const size = conflict.region.getSize(new THREE.Vector3())
  const center = conflict.region.getCenter(new THREE.Vector3())
  const [w, h, d] = [size.x + 3, size.y + 3, size.z + 3]

  // built once per size: dragging re-renders this every frame, and EdgesGeometry is not cheap
  const geometries = useMemo(() => {
    const box = new THREE.BoxGeometry(w, h, d)
    return { box, edges: new THREE.EdgesGeometry(box) }
  }, [w, h, d])
  useEffect(() => () => { geometries.box.dispose(); geometries.edges.dispose() }, [geometries])

  // The fill sits where the clash is, behind whatever is in front of it: drawn over
  // everything, it buried the very joint someone had zoomed in to put right. The outline
  // still shows through, so a clash hidden behind a post can be found — and seen past.
  return (
    <group position={center} raycast={() => null} name={clearance ? 'equipment-clearance-conflict' : 'body-conflict'}>
      <mesh geometry={geometries.box} renderOrder={6}>
        <meshBasicMaterial color={clearance ? '#f59e0b' : '#ff2d2d'} transparent opacity={0.45} depthWrite={false} />
      </mesh>
      <lineSegments geometry={geometries.edges} renderOrder={7}>
        <lineBasicMaterial color={clearance ? '#fde68a' : '#fecaca'} transparent opacity={0.9} depthTest={false} />
      </lineSegments>
    </group>
  )
}

/**
 * An amber ring at a joint whose two profiles cannot be bolted together. Interference is
 * red and is about geometry; this is about buildability, so it reads differently on purpose.
 */
const MismatchMarker: React.FC<{ at: THREE.Vector3 }> = ({ at }) => {
  const { camera, size } = useThree()
  const ref = useRef<THREE.Sprite>(null)
  // a plain three object rather than a JSX element: `line` in JSX is the SVG one
  const leader = useMemo(() => {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()])
    const mat = new THREE.LineBasicMaterial({ color: '#fbbf24', transparent: true, opacity: 0.55, depthTest: false })
    const l = new THREE.Line(geo, mat)
    l.renderOrder = 8
    l.raycast = () => null
    return l
  }, [])
  useEffect(() => () => { leader.geometry.dispose(); (leader.material as THREE.Material).dispose() }, [leader])
  const texture = useMemo(() => {
    const c = document.createElement('canvas')
    c.width = c.height = 64
    const g = c.getContext('2d')!
    g.strokeStyle = '#fbbf24'
    g.lineWidth = 8
    g.beginPath(); g.arc(32, 32, 24, 0, Math.PI * 2); g.stroke()
    g.beginPath(); g.moveTo(32, 20); g.lineTo(32, 36); g.moveTo(32, 42); g.lineTo(32, 44); g.stroke()
    const tex = new THREE.CanvasTexture(c)
    tex.needsUpdate = true
    return tex
  }, [])
  useEffect(() => () => texture.dispose(), [texture])
  /**
   * The marker stands beside the joint, not on it, with a thin line pointing back.
   *
   * It is drawn in front of everything on purpose — a warning you cannot see is no warning —
   * and sitting on the joint that meant it covered the very thing it was telling you to go
   * and look at. Zooming in only made it worse, because it keeps its size on screen. Up and
   * to the right of the joint, in the camera's own frame, so it stays out of the way from
   * every angle.
   */
  useFrame(() => {
    if (!ref.current) return
    const persp = camera as THREE.PerspectiveCamera
    const dist = at.distanceTo(camera.position)
    const world = 2 * Math.tan(THREE.MathUtils.degToRad(persp.fov ?? 45) / 2) * dist * (26 / size.height)
    ref.current.scale.set(world, world, 1)

    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
    const beside = at.clone().addScaledVector(right, world * 1.1).addScaledVector(up, world * 1.1)
    ref.current.position.copy(beside)
    leader.geometry.setFromPoints([at.clone(), beside])
    leader.geometry.computeBoundingSphere()
  })
  return (
    <>
      <primitive object={leader} />
      <sprite ref={ref} position={at} renderOrder={9} raycast={() => null}>
        <spriteMaterial map={texture} transparent depthTest={false} />
      </sprite>
    </>
  )
}

/** Mark joints without a verified connector, including incompatible slot systems. */
const MismatchMarkers: React.FC<{ mismatches: SpecMismatch[] }> = ({ mismatches }) => (
  <>
    {mismatches.map((m) => <MismatchMarker key={`${m.a}-${m.b}`} at={m.at} />)}
  </>
)

const ConflictMarkers: React.FC<{ conflicts: Conflict[] }> = ({ conflicts }) => (
  <>
    {conflicts.map((c, i) => <ConflictMarker key={`${c.a}-${c.b}-${i}`} conflict={c} />)}
  </>
)

function InspectionMarker() {
  const focus = useInspectionStore(s => s.focus)
  return focus ? <SnapMarker position={focus.position} kind="issue" size={.05} /> : null
}

const Viewport: React.FC = () => {
  const { profiles, connectors, panels, fittings, equipment, selectedIds, throughRule } = useStore(useShallow(s => ({
    profiles: s.profiles, connectors: s.connectors, panels: s.panels, fittings: s.fittings,
    equipment: s.equipment, selectedIds: s.selectedIds, throughRule: s.throughRule,
  })))
  const { isDragging, showDimensionLabels, showPartNumbers, selectMode, showFittings, buildStep } = useToolStore(useShallow(s => ({
    isDragging: s.isDragging, showDimensionLabels: s.showDimensionLabels, showPartNumbers: s.showPartNumbers,
    selectMode: s.selectMode, showFittings: s.showFittings, buildStep: s.buildStep,
  })))
  const steps = useMemo(() => (buildStep === null ? null : assemblySteps(profiles, connectors, panels, fittings, throughRule)),
    [buildStep, profiles, connectors, panels, fittings, throughRule])
  const on = useMemo(() => (steps && buildStep !== null ? shownAt(steps, buildStep) : null), [steps, buildStep])
  const { hiddenIds, isolatedIds } = useViewStore()
  const hidden = new Set(hiddenIds), isolated = isolatedIds ? new Set(isolatedIds) : null
  const showing = <T extends { id: string }>(list: T[], kind: 'profiles' | 'connectors' | 'panels' | 'fittings' | 'equipment') =>
    list.filter(x => !hidden.has(x.id) && (!isolated || isolated.has(x.id)) && (!on || kind === 'equipment' || on[kind].has(x.id)))
  const visibleIds = new Set([
    ...showing(profiles, 'profiles'), ...showing(connectors, 'connectors'), ...showing(panels, 'panels'),
    ...(showFittings ? showing(fittings, 'fittings') : []), ...showing(equipment, 'equipment'),
  ].map(p => p.id))
  const { trims, conflicts, conflictIds, equipmentConflicts, mismatches } = useMemo(
    () => analyzeFrame(profiles, connectors, panels, fittings, equipment), [profiles, connectors, panels, fittings, equipment, throughRule])
  const equipmentKinds = useMemo(() => {
    const kinds = new Map<string, 'equipment-body' | 'equipment-clearance'>()
    for (const c of equipmentConflicts) for (const id of [c.a, c.b]) {
      if (!kinds.has(id) || c.kind === 'equipment-body') kinds.set(id, c.kind)
    }
    return kinds
  }, [equipmentConflicts])

  const rotationGesture = useToolStore(s => s.rotationGesture)
  const orbitEnabled = !isDragging && !rotationGesture
  // Middle drag always orbits, including over dense models and while box selection is active.
  // Right drag pans; the wheel zooms. Left drag remains available to editing tools.
  const mouseButtons = { LEFT: selectMode ? undefined : THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN }

  return (
    <Canvas
      camera={{ position: DEFAULT_CAM.toArray(), fov: 45, near: 1, far: 100000 }}
      shadows={false}
      onContextMenu={(e) => e.preventDefault()}
      style={{ touchAction: 'none' }}
    >
      <Suspense fallback={null}>
      <color attach="background" args={['#1e293b']} />
      <ambientLight intensity={0.6} />
      <directionalLight position={[300, 500, 300]} intensity={1.2} />
      <directionalLight position={[-200, 300, -200]} intensity={0.4} color="#cce4ff" />

      <Grid infiniteGrid cellSize={50} sectionSize={500} fadeDistance={6000} fadeStrength={1.5} cellColor="#334155" sectionColor="#475569" position={[0, -0.5, 0]} />

      {showing(profiles, 'profiles').map((p) => (
        <Profile key={p.id} {...p} trims={trims.get(p.id)} isSelected={selectedIds.includes(p.id)} conflict={conflictIds.has(p.id)} />
      ))}

      <Connectors parts={showing(connectors, 'connectors')} selectedIds={selectedIds} />

      {showing(panels, 'panels').map((b) => (
        <Panel key={b.id} {...b} isSelected={selectedIds.includes(b.id)} />
      ))}

      {showFittings && showing(fittings, 'fittings').map((f) => (
        <Fitting key={f.id} {...f} isSelected={selectedIds.includes(f.id)} />
      ))}

      {showing(equipment, 'equipment').map((e) => <Equipment key={e.id} {...e} isSelected={selectedIds.includes(e.id)} conflict={equipmentKinds.get(e.id)} />)}

      <MeasureOverlay />
      {showDimensionLabels && <DimensionLabels trims={trims} visibleIds={visibleIds} />}
      {showPartNumbers && <PartNumberLabels profiles={showing(profiles, 'profiles')} connectors={showing(connectors, 'connectors')}
        panels={showing(panels, 'panels')} fittings={showFittings ? showing(fittings, 'fittings') : []} trims={trims} />}
      <FrameDimensions visibleIds={visibleIds} />
      <LabelLayout />
      <ConflictMarkers conflicts={conflicts.filter(c => visibleIds.has(c.a) && visibleIds.has(c.b))} />
      {equipmentConflicts.filter(c => visibleIds.has(c.a) && visibleIds.has(c.b)).map((c) => <ConflictMarker key={`${c.a}-${c.b}-${c.kind}`} conflict={c} clearance={c.kind === 'equipment-clearance'} />)}
      <MismatchMarkers mismatches={mismatches.filter(c => visibleIds.has(c.a) && visibleIds.has(c.b))} />
      <EditAlignmentGuides trims={trims} />

      <DrawingHandler />
      <ConnectorEditPreview />
      <SuggestionGhost />
      <DragHandler />
      <PointerRouter />
      <ResizeHandles />
      <TransformGizmo />
      <FrameSelector visibleIds={visibleIds} />
      <SectionPlane />

      {/* No damping. drei turns it on by default, which eases the camera toward the cursor
          over several frames — smooth to look at and a quarter of a drag behind your hand.
          Measured: a 200 px pan moved the scene 149 px. Here the view goes where you put it. */}
      <OrbitControls makeDefault enabled={orbitEnabled} mouseButtons={mouseButtons}
        enableDamping={false} minDistance={50} maxDistance={30000} />
      <CameraController />
      <InspectionMarker />
      <Gestures />
      <DevHook />
      </Suspense>
    </Canvas>
  )
}

export default React.memo(Viewport)
