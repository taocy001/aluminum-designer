import React, { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import type { FittingData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { fittingParts, openTransform } from '../utils/fittingGeometry'

const LOOK: Record<string, { color: string; opacity: number; metalness: number; roughness: number }> = {
  mdf: { color: '#d6bb96', opacity: 1, metalness: 0.02, roughness: 0.85 },
  ply: { color: '#c9a06a', opacity: 1, metalness: 0.02, roughness: 0.8 },
  acrylic: { color: '#bfdbfe', opacity: 0.32, metalness: 0.1, roughness: 0.15 },
  alu: { color: '#c3cbd3', opacity: 1, metalness: 0.3, roughness: 0.5 },
}

/** how fast a drawer or a door catches up with where it has been asked to go (per second) */
const EASE = 6

/**
 * A drawer or a door, drawn as one thing.
 *
 * The parts come from `fittingGeometry`, so what is on screen and what is on the cut list
 * are the same drawer. How far it is open is a number on the fitting, and it is eased
 * towards rather than snapped to, because a drawer that teleports open tells you nothing
 * about whether it clears the handle next to it.
 */
const Fitting: React.FC<FittingData & { isSelected?: boolean }> = (f) => {
  const { id, material, isSelected, locked } = f
  const hovered = useToolStore((s) => !s.isDragging && s.hoverPartId === id)
  const parts = useMemo(() => fittingParts(f), [f])
  const target = useMemo(() => openTransform(f), [f])
  const moving = useRef<THREE.Group>(null)

  useFrame((_, dt) => {
    const g = moving.current
    if (!g) return
    const k = 1 - Math.exp(-EASE * dt)
    g.position.lerp(target.position, k)
    g.quaternion.slerp(target.quaternion, k)
  })

  const look = LOOK[material] ?? LOOK.ply
  const color = isSelected ? '#3b82f6' : hovered ? '#f5e6c8' : locked ? '#8b9aa6' : look.color
  const quat = useMemo(() => new THREE.Quaternion(...f.quaternion).normalize(), [f.quaternion])

  return (
    <group position={f.position} quaternion={quat} userData={{ fittingId: id }}>
      {/* the rails a drawer's runners are screwed to do not move with it */}
      {parts.rails.map((r, i) => (
        <mesh key={`r${i}`} position={r.position} raycast={() => null}>
          <boxGeometry args={[20, 20, r.length]} />
          <meshStandardMaterial color="#9aa5b1" metalness={0.3} roughness={0.6} />
        </mesh>
      ))}

      {/* hinges stay on the carcase edge whatever the door does */}
      {parts.hinges.map((h, i) => (
        <mesh key={`h${i}`} position={h} raycast={() => null}>
          <cylinderGeometry args={[5, 5, f.hingeType === 'continuous' ? f.height : 30, 10]} />
          <meshStandardMaterial color="#94a3b8" metalness={0.35} roughness={0.45} />
        </mesh>
      ))}

      <group ref={moving}>
        {parts.boards.map((b, i) => (
          <group key={i} position={b.position} quaternion={new THREE.Quaternion(...b.quaternion)}>
            <mesh>
              <boxGeometry args={[b.width, b.height, b.thickness]} />
              <meshStandardMaterial
                color={color} transparent={look.opacity < 1} opacity={look.opacity}
                metalness={look.metalness} roughness={look.roughness} />
            </mesh>
            <lineSegments raycast={() => null}>
              <edgesGeometry args={[new THREE.BoxGeometry(b.width, b.height, b.thickness)]} />
              <lineBasicMaterial color={isSelected ? '#93c5fd' : '#475569'} transparent opacity={0.8} />
            </lineSegments>
          </group>
        ))}
        {/* a handle, so which way it opens is readable without opening it */}
        <mesh position={[0, f.kind === 'drawer' ? 0 : 0, f.depth / 2 + 26]} raycast={() => null}>
          <boxGeometry args={f.kind === 'drawer' ? [Math.min(160, f.width * 0.5), 14, 14] : [14, Math.min(160, f.height * 0.4), 14]} />
          <meshStandardMaterial color="#64748b" metalness={0.5} roughness={0.35} />
        </mesh>
      </group>
    </group>
  )
}

export default Fitting
