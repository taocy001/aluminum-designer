import React, { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { getProfileEndpoints, getProfileDir } from '../utils/geometryCore'

/** the handle's world radius, and the zone around an end face that reacts to a press */
export const END_GRAB_MM = 30
const HANDLE_RADIUS_MM = END_GRAB_MM * 0.6
/** the puck never draws smaller than this on screen, and the grab zone follows it */
export const HANDLE_MIN_SCREEN = 0.012

/**
 * Small pucks on the end faces of the single selected member. Dragging one stretches the
 * member along its own axis; the opposite end stays put.
 */
/** how much the puck is scaled up at a given camera distance to stay legible */
export function handleScale(cameraDistance: number): number {
  return Math.max(1, (cameraDistance * HANDLE_MIN_SCREEN) / HANDLE_RADIUS_MM)
}

/** world-space radius of the end grab zone, matching what is drawn */
export function endGrabRadius(cameraDistance: number): number {
  return END_GRAB_MM * handleScale(cameraDistance)
}

const ResizeHandles: React.FC = () => {
  const selectedIds = useStore((s) => s.selectedIds)
  const profiles = useStore((s) => s.profiles)
  const viewMode = useToolStore((s) => s.viewMode)
  const resize = useToolStore((s) => s.resize)
  const { camera } = useThree()

  const target = selectedIds.length === 1 ? profiles.find((p) => p.id === selectedIds[0]) : undefined
  const meshes = useRef<Array<THREE.Mesh | null>>([])

  // the puck matches the grab zone in world units, but never shrinks below a legible size
  useFrame(() => {
    for (const m of meshes.current) {
      if (!m) continue
      m.scale.setScalar(handleScale(m.position.distanceTo(camera.position)))
    }
  })

  const handles = useMemo(() => {
    if (!target || viewMode !== 'navigate') return []
    const { start, end } = getProfileEndpoints(target)
    return [
      { key: 'start' as const, pos: start, active: resize?.id === target.id && resize.end === 'start' },
      { key: 'end' as const, pos: end, active: resize?.id === target.id && resize.end === 'end' },
    ]
  }, [target, viewMode, resize])

  if (handles.length === 0) return null
  const dir = getProfileDir(target!)
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)

  return (
    <>
      {handles.map((h, i) => (
        <mesh
          key={h.key}
          ref={(m) => { meshes.current[i] = m }}
          position={h.pos}
          quaternion={quat}
          raycast={() => null}
          renderOrder={8}
        >
          <cylinderGeometry args={[HANDLE_RADIUS_MM, HANDLE_RADIUS_MM, HANDLE_RADIUS_MM * 0.5, 20]} />
          <meshBasicMaterial color={h.active ? '#fbbf24' : '#38bdf8'} transparent opacity={h.active ? 1 : 0.85} depthTest={false} />
        </mesh>
      ))}
    </>
  )
}

export default ResizeHandles
