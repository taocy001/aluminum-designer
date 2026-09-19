import React, { useMemo, useState } from 'react'
import * as THREE from 'three'
import { getProfileShape, ProfileSpec } from '../utils/profileShapes'
import { useToolStore } from '../store/useToolStore'
import { useStore } from '../store/useStore'

interface ProfileProps {
  id: string
  spec: ProfileSpec
  length: number
  position: [number, number, number]
  quaternion: [number, number, number, number]
  isSelected?: boolean
  onClick?: (multi: boolean) => void
}

const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)

const Profile: React.FC<ProfileProps> = ({
  id, spec, length, position, quaternion, isSelected = false, onClick
}) => {
  const viewMode = useToolStore(s => s.viewMode)
  const selectMode = useToolStore(s => s.selectMode)
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
  const color = isSelected
    ? '#3b82f6'
    : isDraggingThis
      ? '#f59e0b'
      : isHovered
        ? '#d1d5db'
        : '#b0bec5'

  // In draw mode (without selectMode), profiles are not interactive
  const onPointerDown = inDrawMode && !selectMode ? undefined : (e: any) => {
    e.stopPropagation()
    const multi = !!(e.nativeEvent?.ctrlKey || e.nativeEvent?.metaKey)

    // In navigate mode (non-select), start drag
    if (viewMode === 'navigate' && !selectMode) {
      const hitOnGround = new THREE.Vector3()
      if (e.ray && e.ray.intersectPlane(GROUND_PLANE, hitOnGround)) {
        // Snapshot current state as one undo entry for the whole drag
        useStore.getState().snapshotHistory()

        // Build group origins for multi-profile drag
        const { selectedIds: curSelected, profiles: curProfiles } = useStore.getState()
        const groupOrigins: Record<string, [number, number, number]> = {}
        // Include dragged profile + any other selected profiles
        const dragGroup = curSelected.includes(id) ? curSelected : [id]
        for (const sid of dragGroup) {
          const p = curProfiles.find(pr => pr.id === sid)
          if (p) groupOrigins[sid] = [p.position[0], p.position[1], p.position[2]]
        }

        startDrag(id, hitOnGround.clone(), new THREE.Vector3(...position), groupOrigins)
      }
    }

    // Selection (after drag setup so selectedIds is stable for group origins above)
    onClick?.(multi)
  }

  return (
    <mesh
      position={new THREE.Vector3(...position)}
      quaternion={new THREE.Quaternion(...quaternion).normalize()}
      scale={[1, 1, safeLen]}
      geometry={geometry}
      raycast={inDrawMode && !selectMode ? () => null : undefined}
      onPointerOver={inDrawMode && !selectMode ? undefined : () => setIsHovered(true)}
      onPointerOut={inDrawMode && !selectMode ? undefined : () => setIsHovered(false)}
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
