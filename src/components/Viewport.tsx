import React, { Suspense, useEffect, useMemo, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, Grid, Line } from '@react-three/drei'
import * as THREE from 'three'
import { useStore } from '../store/useStore'
import { pickCandidatesAtScreen } from '../utils/screenPick'
import { connectorSeatAt, seatFor } from '../utils/bracketSeat'
import { leafObb } from '../utils/fittingGeometry'
import { useToolStore } from '../store/useToolStore'
import { getProfileEndpoints } from '../utils/geometryCore'
import { computeFrameBounds, getProfileDir, type ProfileTrims } from '../utils/jointUtils'
import { analyzeFrame, type Conflict } from '../utils/analysis'
import type { SpecMismatch } from '../utils/specCompat'
import Profile from './Profile'
import Connector from './Connector'
import Panel from './Panel'
import Fitting from './Fitting'
import FrameDimensions from './FrameDimensions'
import DrawingHandler from './DrawingHandler'
import DragHandler from './DragHandler'
import PointerRouter from './PointerRouter'
import ResizeHandles from './ResizeHandles'
import TransformGizmo from './TransformGizmo'
import TextSprite from './TextSprite'

const DEFAULT_CAM = new THREE.Vector3(600, 500, 600)

/** how much one press of the zoom buttons moves the camera, as a fraction of its distance */
const ZOOM_STEP = 0.2

// Fits the camera to the whole frame when triggered (or resets when empty)
const CameraController: React.FC = () => {
  const { camera, controls } = useThree()
  const cameraResetTrigger = useToolStore((s) => s.cameraResetTrigger)
  const cameraFitScope = useToolStore((s) => s.cameraFitScope)
  const zoomStep = useToolStore((s) => s.zoomStep)
  const zoomAt = useToolStore((s) => s.zoomAt)
  const clearZoom = useToolStore((s) => s.clearZoom)
  const prevTrigger = useRef(0)

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
  const framedOnOpen = useRef(false)
  useEffect(() => {
    if (framedOnOpen.current) return
    const fitIfAny = (s: ReturnType<typeof useStore.getState>) => {
      if (framedOnOpen.current) return true
      if (s.profiles.length + s.panels.length + s.fittings.length === 0) return false
      framedOnOpen.current = true
      useToolStore.getState().triggerCameraReset('all')
      return true
    }
    if (fitIfAny(useStore.getState())) return
    const stop = useStore.subscribe((s) => { if (fitIfAny(s)) stop() })
    return stop
  }, [])

  useEffect(() => {
    if (cameraResetTrigger === prevTrigger.current) return
    prevTrigger.current = cameraResetTrigger
    const orbit = controls as any
    // F frames the selection, the Home button frames everything. When only boards are
    // selected there is still something to look at, so panels count too.
    const doc = useStore.getState()
    let subject = doc.profiles
    let bounds: THREE.Box3 | null = null
    if (cameraFitScope === 'selection' && doc.selectedIds.length > 0) {
      const ids = new Set(doc.selectedIds)
      subject = doc.profiles.filter((p) => ids.has(p.id))
      bounds = subject.length > 0 ? computeFrameBounds(subject) : null
      for (const b of doc.panels) {
        if (!ids.has(b.id)) continue
        const half = Math.max(b.width, b.height, b.thickness) / 2
        const c = new THREE.Vector3(...b.position)
        ;(bounds ??= new THREE.Box3()).expandByPoint(c.clone().addScalar(half)).expandByPoint(c.clone().addScalar(-half))
      }
    }
    bounds ??= computeFrameBounds(doc.profiles)
    let target = new THREE.Vector3(0, 0, 0)
    let pos = DEFAULT_CAM.clone()
    if (bounds) {
      target = bounds.getCenter(new THREE.Vector3())
      const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 100)
      const persp = camera as THREE.PerspectiveCamera
      const dist = radius / Math.sin(THREE.MathUtils.degToRad(persp.fov) / 2) * 1.1
      pos = target.clone().add(new THREE.Vector3(1, 0.8, 1).normalize().multiplyScalar(dist))
    }
    camera.position.copy(pos)
    if (orbit) { orbit.target.copy(target); orbit.update() } else camera.lookAt(target)
  }, [cameraResetTrigger, cameraFitScope, camera, controls])

  return null
}

// Resolves frame selection rect → profile IDs (any endpoint or midpoint inside the box)
const FrameSelector: React.FC = () => {
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
    for (const profile of useStore.getState().profiles) {
      const { start, end } = getProfileEndpoints(profile)
      const mid = start.clone().lerp(end, 0.5)
      if (inside(start) && inside(end) || inside(mid)) selected.push(profile.id)
    }
    useStore.getState().selectItems(selected)
  }, [frameSelectRect, camera, size, clearFrameSelectRect])

  return null
}

// Cut-length labels, placed just outside the member body
const DimensionLabels: React.FC<{ trims: Map<string, ProfileTrims> }> = ({ trims }) => {
  const profiles = useStore((s) => s.profiles)
  return (
    <>
      {profiles.map((p) => {
        const { start, end } = getProfileEndpoints(p)
        const mid = start.clone().lerp(end, 0.5)
        const dir = getProfileDir(p)
        if (Math.abs(dir.y) > 0.7) { mid.x += 26; mid.z += 26 } else mid.y += 30
        const cut = trims.get(p.id)?.cutLength ?? p.length
        return <TextSprite key={p.id} text={String(Math.round(cut))} position={mid.toArray() as [number, number, number]} />
      })}
    </>
  )
}

// Dev-only: expose camera helpers for end-to-end tests
const DevHook: React.FC = () => {
  const { camera, size, gl, controls, scene } = useThree()
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const w = window as any
    w.__aluframe = w.__aluframe ?? {}
    w.__aluframe.camera = camera
    w.__aluframe.controls = controls
    // what the pointer would find at a point on the canvas, for tests and for debugging
    w.__aluframe.THREE = THREE
    w.__aluframe.seatFor = seatFor
    w.__aluframe.leafObb = leafObb
    w.__aluframe.connectorSeatAt = connectorSeatAt
    w.__aluframe.pickAt = (clientX: number, clientY: number) => {
      camera.updateMatrixWorld()
      const rect = gl.domElement.getBoundingClientRect()
      const cursor = new THREE.Vector2(clientX - rect.left, clientY - rect.top)
      const ndc = new THREE.Vector2((cursor.x / rect.width) * 2 - 1, -(cursor.y / rect.height) * 2 + 1)
      const rc = new THREE.Raycaster()
      rc.setFromCamera(ndc, camera)
      const st = useStore.getState()
      return pickCandidatesAtScreen(cursor, rc.ray, camera, { width: rect.width, height: rect.height },
        st.profiles, st.connectors, st.panels, st.fittings).map((p) => ({ kind: p.kind, id: p.id }))
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
    // The box on screen, not the size R3F last recorded. They are the same once the layout
    // has settled and different while it has not, and everything else that turns a point
    // into a pixel — picking, the gizmo, the pointer itself — measures the box. A hook that
    // measured something else put every test's clicks tens of pixels off the thing they
    // were aiming at, which read as flakiness.
    w.__aluframe.worldToClient = (x: number, y: number, z: number) => {
      // `project` reads matrixWorldInverse, which the renderer refreshes when it draws — so
      // between moving the camera and the next frame it still describes where the camera
      // used to be. Asking for a point's pixel in that window answered for the old view,
      // and every click aimed at that pixel landed tens of pixels off the part. It costs
      // nothing to bring the matrices up to date first.
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
const ConflictMarker: React.FC<{ conflict: Conflict }> = ({ conflict }) => {
  const size = conflict.region.getSize(new THREE.Vector3())
  const center = conflict.region.getCenter(new THREE.Vector3())
  const [w, h, d] = [size.x + 3, size.y + 3, size.z + 3]

  // built once per size: dragging re-renders this every frame, and EdgesGeometry is not cheap
  const geometries = useMemo(() => {
    const box = new THREE.BoxGeometry(w, h, d)
    return { box, edges: new THREE.EdgesGeometry(box) }
  }, [w, h, d])
  useEffect(() => () => { geometries.box.dispose(); geometries.edges.dispose() }, [geometries])

  return (
    <group position={center} raycast={() => null}>
      <mesh geometry={geometries.box} renderOrder={6}>
        <meshBasicMaterial color="#ff2d2d" transparent opacity={0.5} depthTest={false} />
      </mesh>
      <lineSegments geometry={geometries.edges} renderOrder={7}>
        <lineBasicMaterial color="#fecaca" transparent opacity={0.95} depthTest={false} />
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
  useFrame(() => {
    if (!ref.current) return
    const dist = ref.current.position.distanceTo(camera.position)
    const persp = camera as THREE.PerspectiveCamera
    const world = 2 * Math.tan(THREE.MathUtils.degToRad(persp.fov ?? 45) / 2) * dist * (26 / size.height)
    ref.current.scale.set(world, world, 1)
  })
  return (
    <sprite ref={ref} position={at} renderOrder={8} raycast={() => null}>
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  )
}

/**
 * Only the joints that cannot be built get a marker. Crossing series is a note about which
 * brackets to order, not a mistake — a 2040 on a 4040 is an everyday pairing — so marking
 * every one of them would put warnings all over a perfectly good frame.
 */
const MismatchMarkers: React.FC<{ mismatches: SpecMismatch[] }> = ({ mismatches }) => (
  <>
    {mismatches.filter((m) => m.kind === 'face').map((m) => <MismatchMarker key={`${m.a}-${m.b}`} at={m.at} />)}
  </>
)

const ConflictMarkers: React.FC<{ conflicts: Conflict[] }> = ({ conflicts }) => (
  <>
    {conflicts.map((c, i) => <ConflictMarker key={`${c.a}-${c.b}-${i}`} conflict={c} />)}
  </>
)

/** Dashed lines through the coordinate a drag has just snapped to */
const SnapGuides: React.FC = () => {
  const guides = useToolStore((s) => s.snapGuides)
  const isDragging = useToolStore((s) => s.isDragging)
  const profiles = useStore((s) => s.profiles)
  if (!isDragging || guides.length === 0) return null

  return (
    <>
      {guides.filter((g) => g.kind !== 'endpoint').map((g, i) => {
        const ref = profiles.find((p) => p.id === g.refId)
        if (!ref) return null
        const { start, end } = getProfileEndpoints(ref)
        const mid = start.clone().lerp(end, 0.5)
        const span = Math.max(start.distanceTo(end), 400) * 1.6
        // a long line lying on the shared coordinate, along the two axes it is not fixed on
        const dirs: Array<[number, number, number]> = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
        const along = dirs[(g.axis + 1) % 3]
        const base = [mid.x, mid.y, mid.z]
        base[g.axis] = g.coord
        const a: [number, number, number] = [base[0] - along[0] * span, base[1] - along[1] * span, base[2] - along[2] * span]
        const b: [number, number, number] = [base[0] + along[0] * span, base[1] + along[1] * span, base[2] + along[2] * span]
        return <Line key={`${g.axis}-${i}`} points={[a, b]} color="#22d3ee" lineWidth={1.5} dashed dashSize={12} gapSize={8} depthTest={false} />
      })}
    </>
  )
}

const Viewport: React.FC = () => {
  const { profiles, connectors, panels, fittings, selectedIds } = useStore()
  const { isDragging, showDimensionLabels, selectMode } = useToolStore()
  const { trims, conflicts, conflictIds, mismatches } = useMemo(() => analyzeFrame(profiles), [profiles])

  const orbitEnabled = !isDragging && !selectMode
  // One mapping for the whole canvas, whatever is in hand: the buttons must not change
  // meaning under the user. Left orbits unless the press turns out to be a click on
  // something (DrawingHandler and PointerRouter decide that on release).
  const mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }

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

      {profiles.map((p) => (
        <Profile key={p.id} {...p} trims={trims.get(p.id)} isSelected={selectedIds.includes(p.id)} conflict={conflictIds.has(p.id)} />
      ))}

      {connectors.map((c) => (
        <Connector key={c.id} {...c} isSelected={selectedIds.includes(c.id)} />
      ))}

      {panels.map((b) => (
        <Panel key={b.id} {...b} isSelected={selectedIds.includes(b.id)} />
      ))}

      {fittings.map((f) => (
        <Fitting key={f.id} {...f} isSelected={selectedIds.includes(f.id)} />
      ))}

      {showDimensionLabels && <DimensionLabels trims={trims} />}
      <FrameDimensions />
      <ConflictMarkers conflicts={conflicts} />
      <MismatchMarkers mismatches={mismatches} />
      <SnapGuides />

      <DrawingHandler />
      <DragHandler />
      <PointerRouter />
      <ResizeHandles />
      <TransformGizmo />
      <FrameSelector />

      {/* No damping. drei turns it on by default, which eases the camera toward the cursor
          over several frames — smooth to look at and a quarter of a drag behind your hand.
          Measured: a 200 px pan moved the scene 149 px. Here the view goes where you put it. */}
      <OrbitControls makeDefault enabled={orbitEnabled} mouseButtons={mouseButtons}
        enableDamping={false} minDistance={50} maxDistance={30000} />
      <CameraController />
      <DevHook />
      </Suspense>
    </Canvas>
  )
}

export default Viewport
