import React, { useMemo } from 'react'
import * as THREE from 'three'
import { connectorScale } from '../utils/connectorCatalog'
import { connectorRenderMeshes } from '../utils/connectorRenderGeometry'
import { connectorMeshes } from '../utils/connectorGeometry'
import { useToolStore } from '../store/useToolStore'
import type { ConnectorData, ProfileSpec } from '../store/useStore'

interface ConnectorProps {
  panelMount?: ConnectorData['panelMount']
  id?: string
  type: string
  series?: 20 | 30 | 40
  profileSpec?: ProfileSpec
  mountSeries?: [20 | 30 | 40, 20 | 30 | 40]
  position: [number, number, number]
  quaternion?: [number, number, number, number]
  isSelected?: boolean
  /** translucent ghost used for the placement preview */
  preview?: boolean
  previewState?: 'free' | 'valid' | 'blocked'
}

const Connector: React.FC<ConnectorProps> = ({
  id, type, series = 20, profileSpec, mountSeries, panelMount, position, quaternion = [0, 0, 0, 1], isSelected, preview = false, previewState = 'valid',
}) => {
  const hovered = useToolStore((s) => !s.isDragging && s.hoverPartId === id)
  const previewColor = previewState === 'free' ? '#cbd5e1' : previewState === 'blocked' ? '#fbbf24' : '#34d399'
  const color = preview ? previewColor : isSelected ? '#60a5fa' : hovered ? '#fbbf24' : '#94a3b8'
  const glow = preview ? previewColor : isSelected ? '#1d4ed8' : hovered ? '#a16207' : undefined
  const opacity = preview ? 0.92 : 1
  const highlighted = preview || isSelected || hovered

  const meshes = useMemo(() => connectorRenderMeshes(connectorMeshes(type, series, profileSpec, mountSeries, panelMount)).map((part, index) => <mesh key={`${type}-${series}-${index}`}>
    {/* Primitives keep cached geometry alive when a preview or instance unmounts. */}
    <primitive object={part.geometry} attach="geometry" />
    <meshStandardMaterial color={part.dark && !highlighted ? '#1e293b' : color}
      metalness={part.polished ? 0.8 : 0.3} roughness={part.polished ? 0.2 : 0.55}
      emissive={glow ?? '#000000'} emissiveIntensity={glow ? 0.9 : 0}
      transparent={opacity < 1} opacity={opacity} depthWrite={part.previewDepthWrite || opacity >= 1} />
  </mesh>), [type, series, profileSpec, mountSeries, panelMount, highlighted, color, glow, opacity])

  return (
    <group position={new THREE.Vector3(...position)} quaternion={new THREE.Quaternion(...quaternion).normalize()}
      scale={connectorScale(series)} userData={{ connectorId: id }} raycast={preview ? () => null : undefined}>
      {meshes}
    </group>
  )
}

// The store keeps every untouched part, so identity says whether this one changed.
export default React.memo(Connector)
