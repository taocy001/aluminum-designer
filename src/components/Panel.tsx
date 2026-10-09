import React, { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useStore, type PanelData } from '../store/useStore'
import { panelDrillCenters, panelShapeFromHoles } from '../utils/panelDrilling'
import { useToolStore } from '../store/useToolStore'

const MATERIAL_LOOK: Record<PanelData['material'], { color: string; opacity: number; metalness: number; roughness: number }> = {
  mdf: { color: '#d6bb96', opacity: 1, metalness: 0.02, roughness: 0.85 },
  ply: { color: '#c9a06a', opacity: 1, metalness: 0.02, roughness: 0.8 },
  acrylic: { color: '#bfdbfe', opacity: 0.32, metalness: 0.1, roughness: 0.15 },
  alu: { color: '#c3cbd3', opacity: 1, metalness: 0.65, roughness: 0.35 },
}

/** Render a board with a persistent outline for edge-on views. */
const Panel: React.FC<PanelData & { isSelected?: boolean }> = ({
  id, width, height, thickness, position, quaternion, material, locked = false, isSelected = false,
}) => {
  const isDraggingThis = useToolStore((s) => s.isDragging && (s.dragProfileId === id || id in s.dragGroupOrigins))
  const hovered = useToolStore((s) => !s.isDragging && s.hoverPartId === id)
  const look = MATERIAL_LOOK[material]

  const connectors = useStore((s) => s.connectors)
  // Rigid assembly moves preserve local holes. Ignore sub-micron floating-point noise
  // so moving the group does not rebuild and upload every board's mesh and outline.
  const holesKey = JSON.stringify(panelDrillCenters({ id, width, height, thickness, position, quaternion, material }, connectors)
    .map(({ x, y, diameter }) => ({ x: Math.round(x * 1e6) / 1e6, y: Math.round(y * 1e6) / 1e6, diameter })))
  const geometry = useMemo(() => new THREE.ExtrudeGeometry(panelShapeFromHoles(width, height, JSON.parse(holesKey)),
    { depth: thickness, bevelEnabled: false, curveSegments: 16 }).translate(0, 0, -thickness / 2),
  [width, height, thickness, holesKey])
  const edges = useMemo(() => new THREE.EdgesGeometry(geometry), [geometry])
  useEffect(() => () => { geometry.dispose(); edges.dispose() }, [geometry, edges])
  const quat = useMemo(() => new THREE.Quaternion(...quaternion).normalize(), [quaternion])

  const color = isSelected ? '#3b82f6' : isDraggingThis ? '#f59e0b'
    : hovered ? '#f5e6c8' : locked ? '#8b9aa6' : look.color

  return (
    <group position={position} quaternion={quat} userData={{ panelId: id }}>
      <mesh geometry={geometry}>
        <meshStandardMaterial
          color={color}
          transparent={look.opacity < 1}
          opacity={look.opacity}
          metalness={locked ? 0.5 : look.metalness}
          roughness={look.roughness}
        />
      </mesh>
      <lineSegments geometry={edges} raycast={() => null}>
        <lineBasicMaterial color={isSelected ? '#93c5fd' : '#475569'} transparent opacity={0.8} />
      </lineSegments>
    </group>
  )
}

// the store keeps every part it did not touch, so identity says whether this one changed
export default React.memo(Panel)
