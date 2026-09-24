import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { selectionPivot, type RotAxis } from '../utils/editOps'

export type GizmoPart = { kind: 'move' | 'rotate'; axis: RotAxis }

/**
 * What the gizmo is doing right now, shared with PointerRouter so a press on a handle is
 * never also treated as a press on the model. The handles are plain meshes in the scene,
 * so the router hit-tests them itself rather than relying on event order.
 */
export const gizmoState = {
  busy: false,
  /** picking proxies, plus a point that sits on the visible handle for callers to aim at */
  handles: [] as Array<{ part: GizmoPart; object: THREE.Object3D; probe: THREE.Object3D }>,
}

export function gizmoHandleAt(ray: THREE.Ray): GizmoPart | null {
  const raycaster = new THREE.Raycaster()
  raycaster.ray.copy(ray)
  let move: { part: GizmoPart; distance: number } | null = null
  let rotate: { part: GizmoPart; distance: number } | null = null
  for (const h of gizmoState.handles) {
    const hits = raycaster.intersectObject(h.object, false)
    if (!hits.length) continue
    const slot = h.part.kind === 'move' ? move : rotate
    if (!slot || hits[0].distance < slot.distance) {
      if (h.part.kind === 'move') move = { part: h.part, distance: hits[0].distance }
      else rotate = { part: h.part, distance: hits[0].distance }
    }
  }
  // where an arc crosses an arrow, the arrow wins: it is the thinner target of the two
  return (move ?? rotate)?.part ?? null
}

const AXES: RotAxis[] = ['x', 'y', 'z']
const AXIS_VECTOR: Record<RotAxis, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
}
const AXIS_COLOR: Record<RotAxis, string> = { x: '#ef4444', y: '#22c55e', z: '#3b82f6' }
const HOVER_COLOR = '#fde047'
/** the gizmo spans this fraction of the viewport height, whatever the zoom */
const GIZMO_SCREEN = 0.115
/** the arc spans the middle of its quadrant, so its ends stay off the two arrows */
const ARC_START = 0.34
const ARC_SWEEP = Math.PI / 2 - 0.68
const ARC_RADIUS = 0.78

/**
 * Move arrows and rotation arcs on the selection, the way every 3D tool does it: a straight
 * arrow per world axis for sliding along it (the green one is how a part is moved vertically,
 * without a modifier), and an arc lying in each axis' own plane for turning 90° about it.
 * Orientation plus colour says which axis a handle belongs to, so nothing has to be labelled.
 */
const TransformGizmo: React.FC = () => {
  const { camera } = useThree()
  const selectedIds = useStore((s) => s.selectedIds)
  const profiles = useStore((s) => s.profiles)
  const connectors = useStore((s) => s.connectors)
  const panels = useStore((s) => s.panels)
  const fittings = useStore((s) => s.fittings)
  const selectMode = useToolStore((s) => s.selectMode)
  const isDragging = useToolStore((s) => s.isDragging)
  const showGizmo = useToolStore((s) => s.showGizmo)
  const pivotMode = useToolStore((s) => s.pivotMode)
  const hoverPart = useToolStore((s) => s.gizmoHover)

  const group = useRef<THREE.Group>(null)
  const handleRefs = useRef<Map<string, THREE.Object3D>>(new Map())
  const probeRefs = useRef<Map<string, THREE.Object3D>>(new Map())

  // A connector goes on one way and stays there, so the widget has nothing to offer it:
  // it counts towards where the pivot sits but never towards what can be moved. A board and
  // a door are not like that — they move and they turn like anything else, and leaving them
  // out meant selecting a drawer and being offered no handles at all.
  const selection = useMemo(() => {
    const ids = new Set(selectedIds)
    return {
      profiles: profiles.filter((p) => ids.has(p.id)),
      connectors: connectors.filter((c) => ids.has(c.id)),
      panels: panels.filter((b) => ids.has(b.id)),
      fittings: fittings.filter((f) => ids.has(f.id)),
    }
  }, [selectedIds, profiles, connectors, panels, fittings])

  // the widget sits on the pivot, so where it turns about is something you can see
  const anchor = useMemo(
    () => selectionPivot(selection.profiles, selection.connectors, pivotMode, selection.panels, selection.fittings),
    [selection, pivotMode])
  // a fully locked selection has nothing the gizmo could do
  const anyMovable = [...selection.profiles, ...selection.panels, ...selection.fittings].some((p) => !p.locked)
  const viewMode = useToolStore((s) => s.viewMode)
  // nothing moves while looking, so handles that promise to move something are a lie
  const active = showGizmo && !viewMode && !selectMode && !isDragging && selectedIds.length > 0 && anyMovable

  // one world size for the whole widget, refreshed every frame so zoom and orbit keep it steady
  useFrame(() => {
    if (!group.current || !active) return
    if (gizmoState.handles.length !== handleRefs.current.size) {
      gizmoState.handles = [...handleRefs.current.entries()].map(([key, object]) => {
        const [kind, axis] = key.split(':') as ['move' | 'rotate', RotAxis]
        return { part: { kind, axis }, object, probe: probeRefs.current.get(key) ?? object }
      })
    }
    const persp = camera as THREE.PerspectiveCamera
    const dist = anchor.distanceTo(camera.position)
    const viewHeight = 2 * Math.tan(THREE.MathUtils.degToRad(persp.fov ?? 45) / 2) * dist
    group.current.position.copy(anchor)
    group.current.scale.setScalar(viewHeight * GIZMO_SCREEN)
  })

  useEffect(() => {
    if (!active) { gizmoState.busy = false; gizmoState.handles = [] }
  }, [active])
  useEffect(() => () => { gizmoState.busy = false; gizmoState.handles = [] }, [])

  // refs only fill a map; publishing happens in the frame loop, because updating React state
  // from a ref callback re-renders, which re-attaches the refs, which updates the state again
  const register = useCallback((key: string) => (o: THREE.Object3D | null) => {
    if (o) handleRefs.current.set(key, o)
    else handleRefs.current.delete(key)
  }, [])
  const registerProbe = useCallback((key: string) => (o: THREE.Object3D | null) => {
    if (o) probeRefs.current.set(key, o)
    else probeRefs.current.delete(key)
  }, [])

  if (!active) return null

  const colorFor = (kind: 'move' | 'rotate', axis: RotAxis) =>
    hoverPart?.kind === kind && hoverPart.axis === axis ? HOVER_COLOR : AXIS_COLOR[axis]

  return (
    <group ref={group} renderOrder={25}>
      {AXES.map((axis) => {
        const dir = AXIS_VECTOR[axis]
        const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
        return (
          <group key={axis}>
            {/* move: a shaft and a head pointing along the axis */}
            <group position={dir.clone().multiplyScalar(0.62)} quaternion={quat}>
              <mesh renderOrder={25}>
                <cylinderGeometry args={[0.022, 0.022, 0.72, 10]} />
                <meshBasicMaterial color={colorFor('move', axis)} depthTest={false} transparent opacity={0.95} />
              </mesh>
              <mesh position={[0, 0.46, 0]} renderOrder={26}>
                <coneGeometry args={[0.075, 0.2, 14]} />
                <meshBasicMaterial color={colorFor('move', axis)} depthTest={false} transparent opacity={0.95} />
              </mesh>
              {/* an invisible sleeve makes the thin arrow comfortable to grab */}
              <mesh ref={register(`move:${axis}`)} position={[0, 0.1, 0]} visible={false}>
                {/* the sleeve you actually hit, three times the drawn shaft: aiming at a
                    two-pixel arrow is not aiming, it is luck */}
                <cylinderGeometry args={[0.12, 0.12, 1.06, 8]} />
                <meshBasicMaterial />
              </mesh>
              <object3D ref={registerProbe(`move:${axis}`)} position={[0, 0.25, 0]} />
            </group>

            {/* rotate: an arc lying in the plane this axis turns in, kept clear of the arrows
                at either end so the two never fight over the same pixels */}
            <group quaternion={quat}>
              <group rotation={[Math.PI / 2, 0, 0]}>
                <mesh rotation={[0, 0, ARC_START]} renderOrder={25}>
                  <torusGeometry args={[ARC_RADIUS, 0.024, 8, 24, ARC_SWEEP]} />
                  <meshBasicMaterial color={colorFor('rotate', axis)} depthTest={false} transparent opacity={0.95} />
                </mesh>
                <mesh ref={register(`rotate:${axis}`)} rotation={[0, 0, ARC_START]} visible={false}>
                  <torusGeometry args={[ARC_RADIUS, 0.1, 6, 20, ARC_SWEEP]} />
                  <meshBasicMaterial />
                </mesh>
              </group>
              {/* a point that really sits on the arc, so callers have somewhere to aim */}
              <object3D ref={registerProbe(`rotate:${axis}`)} position={[
                ARC_RADIUS * Math.cos(ARC_START + ARC_SWEEP / 2), 0, ARC_RADIUS * Math.sin(ARC_START + ARC_SWEEP / 2),
              ]} />
            </group>
          </group>
        )
      })}
    </group>
  )
}

export default TransformGizmo
