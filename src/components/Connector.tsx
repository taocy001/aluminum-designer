import React from 'react'
import * as THREE from 'three'
import { connectorScale } from '../utils/connectorCatalog'
import { connectorMeshes } from '../utils/connectorGeometry'
import { useToolStore } from '../store/useToolStore'

interface ConnectorProps {
  id?: string
  type: string
  series?: 20 | 30 | 40
  position: [number, number, number]
  quaternion?: [number, number, number, number]
  isSelected?: boolean
  /** translucent ghost used for the placement preview */
  preview?: boolean
}

const Connector: React.FC<ConnectorProps> = ({
  id, type, series = 20, position, quaternion = [0, 0, 0, 1], isSelected, preview = false,
}) => {
  const hovered = useToolStore((s) => !s.isDragging && s.hoverPartId === id)
  const color = preview ? '#34d399' : isSelected ? '#60a5fa' : hovered ? '#fbbf24' : '#94a3b8'
  const glow = preview ? '#059669' : isSelected ? '#1d4ed8' : hovered ? '#a16207' : undefined
  const opacity = preview ? 0.92 : 1

  return (
    <group position={new THREE.Vector3(...position)} quaternion={new THREE.Quaternion(...quaternion).normalize()}
      scale={connectorScale(series)} userData={{ connectorId: id }} raycast={preview ? () => null : undefined}>
      {connectorMeshes(type, series).map((part, index) => <mesh key={`${type}-${series}-${index}`}>
        {/* Primitives keep cached geometry alive when a preview or instance unmounts. */}
        <primitive object={part.geometry} attach="geometry" />
        <meshStandardMaterial color={part.dark ? '#1e293b' : color}
          metalness={part.polished ? 0.8 : 0.3} roughness={part.polished ? 0.2 : 0.55}
          emissive={!part.dark && !part.polished ? glow ?? '#000000' : '#000000'}
          emissiveIntensity={!part.dark && !part.polished && glow ? 0.9 : 0}
          transparent={opacity < 1} opacity={opacity} depthWrite={part.previewDepthWrite || opacity >= 1} />
      </mesh>)}
    </group>
  )
}

// The store keeps every untouched part, so identity says whether this one changed.
export default React.memo(Connector)
