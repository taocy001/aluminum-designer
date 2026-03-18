import React, { useMemo } from 'react'
import * as THREE from 'three'
import { getProfileShape, ProfileSpec } from '../utils/profileShapes'

interface ProfileProps {
  id: string
  spec: ProfileSpec
  length: number
  position: [number, number, number]
  quaternion: [number, number, number, number]
  isSelected?: boolean
  onClick?: () => void
}

const Profile: React.FC<ProfileProps> = ({
  id,
  spec,
  length,
  position,
  quaternion,
  isSelected = false,
  onClick
}) => {
  // Use scale instead of re-extruding for 100% stability
  const safeLen = isFinite(length) && length > 0.1 ? length : 1
  
  const geometry = useMemo(() => {
    try {
      const shape = getProfileShape(spec)
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false })
      geo.computeVertexNormals()
      return geo
    } catch (e) {
      console.warn(`[RESCUE] Profile ${id} failed geometry creation.`)
      const fallback = new THREE.BoxGeometry(20, 20, 1)
      fallback.translate(0, 0, 0.5)
      return fallback
    }
  }, [spec])

  return (
    <mesh
      position={new THREE.Vector3(...position)}
      quaternion={new THREE.Quaternion(...quaternion).normalize()}
      scale={[1, 1, safeLen]} // Scale the Z-axis to represent length
      geometry={geometry}
      onClick={(e) => {
        e.stopPropagation()
        onClick?.()
      }}
    >
      <meshStandardMaterial
        color={isSelected ? '#3b82f6' : '#b0bec5'}
        metalness={0.3}
        roughness={0.6}
      />
    </mesh>
  )
}

export default Profile
