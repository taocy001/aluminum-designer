import React, { useMemo } from 'react'
import * as THREE from 'three'
import { getProfileShape, ProfileSpec } from '../utils/profileShapes'
import { useToolStore } from '../store/useToolStore'
import type { ProfileTrims } from '../utils/jointUtils'

interface ProfileProps {
  id: string
  spec: ProfileSpec
  length: number
  position: [number, number, number]
  quaternion: [number, number, number, number]
  trims?: ProfileTrims
  isSelected?: boolean
  /** true when this member interferes with another one */
  conflict?: boolean
  /** a finished part: visible and still a snapping reference, but nothing moves it */
  locked?: boolean
}

const Profile: React.FC<ProfileProps> = ({
  id, spec, length, position, quaternion, trims, isSelected = false, conflict = false, locked = false,
}) => {
  const isDraggingThis = useToolStore((s) => s.isDragging && (s.dragProfileId === id || id in s.dragGroupOrigins))
  const isSnapTarget = useToolStore((s) => s.hoverTargetId === id || s.snapRefIds.includes(id))
  const isHovered = useToolStore((s) => !s.isDragging && s.hoverProfileId === id)

  const geometry = useMemo(() => {
    const shape = getProfileShape(spec)
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false })
    geo.computeVertexNormals()
    return geo
  }, [spec])

  // Real (trimmed) geometry: butt ends are cut back, through ends extended
  const quat = useMemo(() => new THREE.Quaternion(...quaternion).normalize(), [quaternion])
  const { meshPos, cutLen } = useMemo(() => {
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(quat)
    const startTrim = trims?.start.trim ?? 0
    const cut = trims?.cutLength ?? length
    const pos = new THREE.Vector3(...position).addScaledVector(dir, startTrim)
    return { meshPos: pos, cutLen: isFinite(cut) && cut > 0.1 ? cut : 1 }
  }, [position, quat, trims, length])

  // Interference is allowed, so it has to be visible: conflicting members read red.
  // A lock reads as a colder, darker metal — different enough to spot in a crowded frame,
  // quiet enough that a locked sub-frame does not shout over the part being worked on.
  const color = conflict ? '#b91c1c'
    : isSelected ? (locked ? '#1e40af' : '#3b82f6')
    : isDraggingThis ? '#f59e0b'
    : isSnapTarget ? '#67e8f9'
    : isHovered ? (locked ? '#94a3b8' : '#e2e8f0')
    : locked ? '#78909c'
    : '#b0bec5'

  return (
    <mesh
      position={meshPos}
      quaternion={quat}
      scale={[1, 1, cutLen]}
      geometry={geometry}
      userData={{ profileId: id }}
    >
      <meshStandardMaterial
        color={color}
        metalness={locked ? 0.55 : 0.3}
        roughness={locked ? 0.35 : 0.6}
        emissive={conflict && isSelected ? new THREE.Color('#1d4ed8')
          : conflict ? new THREE.Color('#7f1d1d')
          : isSnapTarget ? new THREE.Color('#0e7490')
          : isHovered && !isSelected ? new THREE.Color('#1e40af')
          : new THREE.Color(0, 0, 0)}
        emissiveIntensity={isSnapTarget ? 0.6 : 0.8}
      />
    </mesh>
  )
}

/**
 * Drawn again only when something about this member changed.
 *
 * Dragging one rail rebuilt every member in the drawing, because the joint analysis hands
 * out a fresh trims object for each of them every time — equal, but not the same object.
 * The trims are compared by what they say; everything else by identity, which the store
 * keeps for every member it did not touch.
 */
const sameTrims = (a?: ProfileTrims, b?: ProfileTrims) => a === b || (!!a && !!b
  && a.cutLength === b.cutLength && a.start.trim === b.start.trim && a.end.trim === b.end.trim)

export default React.memo(Profile, (a, b) => {
  for (const k of Object.keys(b) as Array<keyof ProfileProps>) {
    if (k === 'trims') continue
    if (a[k] !== b[k]) return false
  }
  return Object.keys(a).length === Object.keys(b).length && sameTrims(a.trims, b.trims)
})
