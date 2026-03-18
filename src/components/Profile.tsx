import React, { useMemo, useState } from 'react'
import * as THREE from 'three'
import { getProfileShape, ProfileSpec } from '../utils/profileShapes'
import { useToolStore } from '../store/useToolStore'

interface ProfileProps {
  id: string
  spec: ProfileSpec
  length: number
  position: [number, number, number]
  quaternion: [number, number, number, number]
  isSelected?: boolean
  onClick?: () => void
}

const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)

const Profile: React.FC<ProfileProps> = ({
  id, spec, length, position, quaternion, isSelected = false, onClick
}) => {
  const viewMode = useToolStore(s => s.viewMode)
  const startDrag = useToolStore(s => s.startDrag)
  const isDraggingThis = useToolStore(s => s.isDragging && s.dragProfileId === id)
  const safeLen = isFinite(length) && length > 0.1 ? length : 1

  const [isHovered, setIsHovered] = useState(false)

  const geometry = useMemo(() => {
    try {
      const shape = getProfileShape(spec)
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false })
      geo.computeVertexNormals()
      return geo
    } catch (e) {
      const fallback = new THREE.BoxGeometry(20, 20, 1)
      fallback.translate(0, 0, 0.5)
      return fallback
    }
  }, [spec])

  const inDrawMode = viewMode === 'draw'
  // Color: selected > dragging > hovered > default
  const color = isSelected
    ? '#3b82f6'
    : isDraggingThis
      ? '#f59e0b'
      : isHovered
        ? '#d1d5db'
        : '#b0bec5'

  const onPointerDown = inDrawMode ? undefined : (e: any) => {
    e.stopPropagation()
    const hitOnGround = new THREE.Vector3()
    if (e.ray.intersectPlane(GROUND_PLANE, hitOnGround)) {
      startDrag(id, hitOnGround.clone(), new THREE.Vector3(...position))
    }
    onClick?.()
  }

  return (
    <mesh
      position={new THREE.Vector3(...position)}
      quaternion={new THREE.Quaternion(...quaternion).normalize()}
      scale={[1, 1, safeLen]}
      geometry={geometry}
      raycast={inDrawMode ? () => null : undefined}
      onPointerOver={inDrawMode ? undefined : () => setIsHovered(true)}
      onPointerOut={inDrawMode ? undefined : () => setIsHovered(false)}
      onPointerDown={onPointerDown}
    >
      <meshStandardMaterial
        color={color}
        metalness={isDraggingThis ? 0.1 : 0.3}
        roughness={0.6}
        emissive={isHovered && !isSelected ? new THREE.Color('#334155') : new THREE.Color(0, 0, 0)}
      />
    </mesh>
  )
}

export default Profile
