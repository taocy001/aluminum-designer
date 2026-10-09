import React, { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import type { FittingData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { fittingHandle, fittingParts, openTransform, type Board } from '../utils/fittingGeometry'
import { fittingHandleHoles } from '../utils/fittingHandle'
import { panelShapeFromHoles } from '../utils/panelDrilling'

const LOOK: Record<string, { color: string; opacity: number; metalness: number; roughness: number }> = {
  mdf: { color: '#d6bb96', opacity: 1, metalness: 0.02, roughness: 0.85 },
  ply: { color: '#c9a06a', opacity: 1, metalness: 0.02, roughness: 0.8 },
  acrylic: { color: '#bfdbfe', opacity: 0.32, metalness: 0.1, roughness: 0.15 },
  alu: { color: '#c3cbd3', opacity: 1, metalness: 0.3, roughness: 0.5 },
}

/** how fast a drawer or a door catches up with where it has been asked to go (per second) */
const EASE = 6

const BoardView = React.memo(({ board, holes, color, look, selected }: {
  board: Board; holes: ReturnType<typeof fittingHandleHoles>; color: string; look: typeof LOOK[string]; selected?: boolean
}) => {
  const quaternion = useMemo(() => new THREE.Quaternion(...board.quaternion), [board.quaternion])
  const geometry = useMemo(() => {
    if (!holes.length) return new THREE.BoxGeometry(board.width, board.height, board.thickness)
    return new THREE.ExtrudeGeometry(panelShapeFromHoles(board.width, board.height, holes), {
      depth: board.thickness, bevelEnabled: false, curveSegments: 12,
    }).translate(0, 0, -board.thickness / 2)
  }, [board.width, board.height, board.thickness, holes])
  const edges = useMemo(() => {
    return new THREE.EdgesGeometry(geometry)
  }, [geometry])
  useEffect(() => () => { edges.dispose(); geometry.dispose() }, [edges, geometry])
  return <group position={board.position} quaternion={quaternion}>
    <mesh userData={{ fittingBoard: board.role }}>
      <primitive object={geometry} attach="geometry" />
      <meshStandardMaterial color={color} transparent={look.opacity < 1} opacity={look.opacity}
        metalness={look.metalness} roughness={look.roughness} />
    </mesh>
    <lineSegments raycast={() => null}>
      <primitive object={edges} attach="geometry" />
      <lineBasicMaterial color={selected ? '#93c5fd' : '#475569'} transparent opacity={0.8} />
    </lineSegments>
  </group>
})

/** Render fitting boards from the geometry shared with the cut list, interpolating the open amount. */
const Fitting: React.FC<FittingData & { isSelected?: boolean }> = (f) => {
  const { id, material, isSelected, locked } = f
  const hovered = useToolStore((s) => !s.isDragging && s.hoverPartId === id)
  // Moving or selecting an assembly does not change its local boards or handles.
  const shape = useMemo(() => f, [f.kind, f.width, f.height, f.depth, f.frame, f.overlay,
    f.hinge, f.hingeType, f.swing, f.meeting, f.stacked, f.drawer, f.handle])
  const parts = useMemo(() => fittingParts(shape), [shape])
  const holes = useMemo(() => parts.boards.map(b => fittingHandleHoles(shape, b.key)), [parts, shape])
  const handle = useMemo(() => fittingHandle(shape), [shape])
  const applied = useRef<{ shape: FittingData; open: number } | null>(null)
  const moving = useRef<THREE.Group>(null)
  /** how far open it looks right now, which chases how far open it is */
  const shown = useRef(f.open ?? 0)

  /** Interpolate the open amount, then derive position and rotation together to keep the hinge fixed. */
  useFrame((_, dt) => {
    const g = moving.current
    if (!g) return
    const want = Math.max(0, Math.min(1, f.open ?? 0))
    if (Math.abs(shown.current - want) < 0.0005) shown.current = want
    else shown.current += (want - shown.current) * (1 - Math.exp(-EASE * dt))
    if (applied.current?.shape === shape && applied.current.open === shown.current) return
    const at = openTransform({ ...shape, open: shown.current }, parts)
    applied.current = { shape, open: shown.current }
    g.position.copy(at.position)
    g.quaternion.copy(at.quaternion)
  })

  const look = LOOK[material] ?? LOOK.ply
  const color = isSelected ? '#3b82f6' : hovered ? '#f5e6c8' : locked ? '#8b9aa6' : look.color
  const quat = useMemo(() => new THREE.Quaternion(...f.quaternion).normalize(), [f.quaternion])

  return (
    <group position={f.position} quaternion={quat} userData={{ fittingId: id }}>
      {/* hinges stay on the carcase edge whatever the door does */}
      {parts.hinges.map((h, i) => (
        <mesh key={`h${i}`} position={h} raycast={() => null}>
          <cylinderGeometry args={[5, 5, f.hingeType === 'continuous' ? f.height : 30, 10]} />
          <meshStandardMaterial color="#94a3b8" metalness={0.35} roughness={0.45} />
        </mesh>
      ))}

      <group ref={moving}>
        {parts.boards.map((b, i) => <BoardView key={b.key} board={b} holes={holes[i]} color={color} look={look} selected={isSelected} />)}
        {/* The pull is mounted on the actual outer face and moves with that front. */}
        <group name="fitting-handle">
          {handle.mounts.map((mount, i) => (
            <mesh key={i} position={mount.position} name="handle-mount" raycast={() => null}>
              <boxGeometry args={mount.size} />
              <meshStandardMaterial color="#64748b" metalness={0.5} roughness={0.35} />
            </mesh>
          ))}
          <mesh position={handle.grip.position} name="handle-grip" raycast={() => null}>
            <boxGeometry args={handle.grip.size} />
            <meshStandardMaterial color="#64748b" metalness={0.5} roughness={0.35} />
          </mesh>
        </group>
      </group>
    </group>
  )
}

// the store keeps every part it did not touch, so identity says whether this one changed
export default React.memo(Fitting)
