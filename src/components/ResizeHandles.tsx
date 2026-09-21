import React, { useMemo } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { getProfileEndpoints, getProfileDir } from '../utils/geometryCore'
import { specDims } from '../utils/specUtils'
import TextSprite from './TextSprite'

/** Pixels from an end face that count as "reaching for the end" */
export const END_GRAB_PX = 26
/** Never let the two ends of a short member both claim the pointer */
const END_ZONE_FRACTION = 1 / 3

/** World distance that corresponds to `px` screen pixels at `dist` from a perspective camera */
export function pixelsToWorld(px: number, dist: number, camera: THREE.Camera, viewportHeight: number): number {
  const fov = (camera as THREE.PerspectiveCamera).fov ?? 45
  const viewHeight = 2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2) * dist
  return (px / Math.max(1, viewportHeight)) * viewHeight
}

/** How close to an end face a press has to be to start a stretch, in world units */
export function endGrabRadius(profileLength: number, dist: number, camera: THREE.Camera, viewportHeight: number): number {
  return Math.min(pixelsToWorld(END_GRAB_PX, dist, camera, viewportHeight), profileLength * END_ZONE_FRACTION)
}

/**
 * End-face affordances for the single selected member.
 *
 * Idle, an end is marked only by a thin bright rim on the face itself. Reaching for an end
 * floats a flat arrow just outside it, sized from the section, and a stretch in progress
 * shows the live length next to it. Persistent pucks read as part of the model and hid the
 * very face the user is aiming at.
 */
const ResizeHandles: React.FC = () => {
  const selectedIds = useStore((s) => s.selectedIds)
  const profiles = useStore((s) => s.profiles)
  const viewMode = useToolStore((s) => s.viewMode)
  const resize = useToolStore((s) => s.resize)
  const hoverEnd = useToolStore((s) => s.hoverEnd)
  const { camera, size } = useThree()

  const target = selectedIds.length === 1 ? profiles.find((p) => p.id === selectedIds[0]) : undefined
  const live = resize?.id === target?.id ? resize : null

  const geometry = useMemo(() => {
    if (!target) return null
    const { start, end } = getProfileEndpoints(target)
    const dir = getProfileDir(target)
    const { w, h } = specDims(target.spec)
    return { start, end, dir, section: Math.max(w, h) }
  }, [target])

  // the arrow is scaled on the object every frame: a ref read during render would freeze
  // at whatever value React last rendered with, and camera motion does not re-render
  const arrows = React.useRef<Array<THREE.Mesh | null>>([])
  useFrame(() => {
    if (!geometry) return
    const wanted = pixelsToWorld(END_GRAB_PX, geometry.start.distanceTo(camera.position), camera, size.height)
    const s = Math.max(1, wanted / Math.max(geometry.section * 0.6, 1))
    for (const m of arrows.current) m?.scale.setScalar(s)
  })

  // a drag or a mode switch must not leave an arrow lit on an end nobody is pointing at
  if (!target || !geometry || viewMode !== 'navigate') return null
  const { start, end, dir, section } = geometry
  const arrowLen = section * 0.75
  const arrowRadius = section * 0.38

  const ends: Array<{ key: 'start' | 'end'; pos: THREE.Vector3; out: THREE.Vector3 }> = [
    { key: 'start', pos: start, out: dir.clone().negate() },
    { key: 'end', pos: end, out: dir.clone() },
  ]

  return (
    <>
      {ends.map(({ key, pos, out }) => {
        const shown = live ? live.end === key : hoverEnd === key
        const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), out)
        return (
          <group key={key}>
            {/* the end face itself stays marked, quietly */}
            <mesh position={pos} quaternion={quat} raycast={() => null} renderOrder={8}>
              <torusGeometry args={[section * 0.55, section * 0.045, 6, 20]} />
              <meshBasicMaterial color={shown ? '#fbbf24' : '#38bdf8'} transparent opacity={shown ? 0.95 : 0.5} depthTest={false} />
            </mesh>
            {shown && (
              <mesh
                ref={(m) => { arrows.current[key === 'start' ? 0 : 1] = m }}
                position={pos.clone().addScaledVector(out, arrowLen * 0.75)}
                quaternion={quat}
                raycast={() => null}
                renderOrder={9}
              >
                <coneGeometry args={[arrowRadius, arrowLen, 18]} />
                <meshBasicMaterial color="#fbbf24" transparent opacity={0.8} depthTest={false} />
              </mesh>
            )}
          </group>
        )
      })}
      {live && (
        <TextSprite
          text={`${Math.round(target.length)} mm`}
          position={(live.end === 'start' ? start : end).clone().addScaledVector(
            live.end === 'start' ? dir.clone().negate() : dir, section * 2.2,
          ).toArray() as [number, number, number]}
          height={section * 1.6}
          color="#fde68a"
        />
      )}
    </>
  )
}

export default ResizeHandles
