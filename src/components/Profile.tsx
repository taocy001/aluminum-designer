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
}

const Profile: React.FC<ProfileProps> = ({
  id, spec, length, position, quaternion, trims, isSelected = false,
}) => {
  const isDraggingThis = useToolStore((s) => s.isDragging && (s.dragProfileId === id || id in s.dragGroupOrigins))
  const isSnapTarget = useToolStore((s) => s.hoverTargetId === id)
  const isHovered = useToolStore((s) => s.viewMode === 'navigate' && !s.isDragging && s.hoverProfileId === id)

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

  const color = isSelected ? '#3b82f6' : isDraggingThis ? '#f59e0b' : isSnapTarget ? '#67e8f9' : isHovered ? '#e2e8f0' : '#b0bec5'

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
        metalness={0.3}
        roughness={0.6}
        emissive={isSnapTarget ? new THREE.Color('#0e7490') : isHovered && !isSelected ? new THREE.Color('#1e40af') : new THREE.Color(0, 0, 0)}
        emissiveIntensity={isSnapTarget ? 0.6 : 0.8}
      />
    </mesh>
  )
}

export default Profile
