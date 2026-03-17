import React, { useMemo } from 'react'
import * as THREE from 'three'

interface ConnectorProps {
  id: string
  type: string
  position: [number, number, number]
  quaternion?: [number, number, number, number]
  isSelected?: boolean
  onClick?: () => void
}

const Connector: React.FC<ConnectorProps> = ({
  type,
  position,
  quaternion = [0, 0, 0, 1],
  isSelected,
  onClick
}) => {
  const geometry = useMemo(() => {
    if (type === 'bracket') {
      // Create a L-bracket shape
      const shape = new THREE.Shape()
      shape.moveTo(0, 0)
      shape.lineTo(20, 0)
      shape.lineTo(20, 4)
      shape.lineTo(4, 4)
      shape.lineTo(4, 20)
      shape.lineTo(0, 20)
      shape.closePath()
      
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 18, bevelEnabled: false })
      geo.translate(-2, -2, -9) // Center it
      return geo
    }
    return new THREE.BoxGeometry(10, 10, 10)
  }, [type])

  return (
    <mesh 
      position={position} 
      quaternion={new THREE.Quaternion(...quaternion)}
      geometry={geometry}
      onClick={(e) => {
        e.stopPropagation()
        onClick?.()
      }}
    >
      <meshStandardMaterial 
        color={isSelected ? '#3b82f6' : '#94a3b8'} 
        metalness={0.8} 
        roughness={0.2} 
      />
    </mesh>
  )
}

export default Connector
