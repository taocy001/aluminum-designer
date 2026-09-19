import React, { useMemo, useState } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { getProfileShape, ProfileSpec } from '../utils/profileShapes'
import { useToolStore } from '../store/useToolStore'
import { useStore } from '../store/useStore'
import type { ProfileTrims } from '../utils/jointUtils'

interface ProfileProps {
  id: string
  spec: ProfileSpec
  length: number
  position: [number, number, number]
  quaternion: [number, number, number, number]
  trims?: ProfileTrims
  isSelected?: boolean
  onSelect?: (multi: boolean) => void
}

const Profile: React.FC<ProfileProps> = ({
  id, spec, length, position, quaternion, trims, isSelected = false, onSelect,
}) => {
  const viewMode = useToolStore((s) => s.viewMode)
  const selectMode = useToolStore((s) => s.selectMode)
  const isDraggingThis = useToolStore((s) => s.isDragging && (s.dragProfileId === id || id in s.dragGroupOrigins))
  const controls = useThree((s) => s.controls) as any
  const isSnapTarget = useToolStore((s) => s.hoverTargetId === id)
  const [isHovered, setIsHovered] = useState(false)

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

  const interactive = viewMode === 'navigate'
  const color = isSelected ? '#3b82f6' : isDraggingThis ? '#f59e0b' : isSnapTarget ? '#67e8f9' : isHovered ? '#d1d5db' : '#b0bec5'

  const onPointerDown = interactive ? (e: any) => {
    if (e.button !== 0) return
    e.stopPropagation()
    // R3F v9 no longer stops the native event: keep it from reaching the <main> handler that clears the selection
    e.nativeEvent?.stopPropagation?.()
    // OrbitControls listens on the same canvas and would start rotating before React disables it
    if (controls) controls.enabled = false
    const multi = !!(e.nativeEvent?.ctrlKey || e.nativeEvent?.metaKey)
    const shift = !!e.nativeEvent?.shiftKey

    if (!selectMode) {
      const store = useStore.getState()
      // Keep an existing multi-selection when grabbing one of its members
      const dragGroup = store.selectedIds.includes(id) && !multi ? store.selectedIds : [id]
      const groupOrigins: Record<string, [number, number, number]> = {}
      for (const sid of dragGroup) {
        const p = store.profiles.find((pr) => pr.id === sid)
        if (p) groupOrigins[sid] = [p.position[0], p.position[1], p.position[2]]
      }

      // Drag plane through the member's centerline (not the surface hit) so the centerline follows the cursor exactly:
      // horizontal plane at the member's height, or a camera-facing vertical plane with Shift
      const ray: THREE.Ray = e.ray
      const surface: THREE.Vector3 = e.point.clone()
      const anchor = new THREE.Vector3(surface.x, position[1], surface.z)
      let plane: THREE.Plane
      if (shift) {
        const n = ray.direction.clone().negate(); n.y = 0
        if (n.lengthSq() < 1e-6) n.set(0, 0, 1)
        plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n.normalize(), anchor)
      } else {
        plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -position[1])
      }
      const grab = new THREE.Vector3()
      if (!ray.intersectPlane(plane, grab)) grab.copy(anchor)
      useToolStore.getState().startDrag({
        id, hit: grab, origin: new THREE.Vector3(...position), groupOrigins, plane, vertical: shift,
      })
      if (!(store.selectedIds.includes(id) && !multi)) onSelect?.(multi)
    } else {
      onSelect?.(multi)
    }
  } : undefined

  return (
    <mesh
      position={meshPos}
      quaternion={quat}
      scale={[1, 1, cutLen]}
      geometry={geometry}
      userData={{ profileId: id }}
      onPointerOver={interactive ? (e) => { e.stopPropagation(); setIsHovered(true) } : undefined}
      onPointerOut={interactive ? () => setIsHovered(false) : undefined}
      onPointerDown={onPointerDown}
    >
      <meshStandardMaterial
        color={color}
        metalness={0.3}
        roughness={0.6}
        emissive={isSnapTarget ? new THREE.Color('#0e7490') : isHovered && !isSelected ? new THREE.Color('#334155') : new THREE.Color(0, 0, 0)}
        emissiveIntensity={isSnapTarget ? 0.6 : 1}
      />
    </mesh>
  )
}

export default Profile
