import React from 'react'
import * as THREE from 'three'
import { connectorScale } from '../utils/connectorCatalog'
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

interface MeshPartProps {
  geom: 'box' | 'cylinder'
  args: number[]
  pos?: [number, number, number]
  rot?: [number, number, number]
  color: string
}

/** built once: the preview re-renders on every pointer move */
const GUSSET_GEOMETRY = (() => {
  const shape = new THREE.Shape()
  shape.moveTo(0, 0); shape.lineTo(24, 0); shape.lineTo(0, 24); shape.closePath()
  return new THREE.ExtrudeGeometry(shape, { depth: 4, bevelEnabled: false })
})()

const MeshPart: React.FC<MeshPartProps & { opacity?: number; glow?: string }> = ({ geom, args, pos = [0, 0, 0], rot = [0, 0, 0], color, opacity = 1, glow }) => (
  <mesh position={pos} rotation={rot}>
    {geom === 'box'
      ? <boxGeometry args={args as [number, number, number]} />
      : <cylinderGeometry args={args as [number, number, number, number]} />
    }
    {/* A bracket is a 20 mm part on a frame metres across. Colour alone does not carry at
        that size, so a selected or hovered one lights up from the inside. */}
    <meshStandardMaterial
      color={color} metalness={0.8} roughness={0.2}
      emissive={glow ?? '#000000'} emissiveIntensity={glow ? 0.9 : 0}
      transparent={opacity < 1} opacity={opacity} depthWrite={opacity >= 1} />
  </mesh>
)

const Connector: React.FC<ConnectorProps> = ({
  id,
  type,
  series = 20,
  position,
  quaternion = [0, 0, 0, 1],
  isSelected,
  preview = false,
}) => {
  const hovered = useToolStore((s) => !s.isDragging && s.hoverPartId === id)
  const c = preview ? '#34d399' : isSelected ? '#60a5fa' : hovered ? '#fbbf24' : '#94a3b8'
  const glow = preview ? '#059669' : isSelected ? '#1d4ed8' : hovered ? '#a16207' : undefined
  const opacity = preview ? 0.92 : 1
  const scale = connectorScale(series)

  const renderParts = () => {
    switch (type) {

      // ── L型角码 ── two arms at 90°, 20mm length, 4mm thick
      case 'bracket':
        return <>
          <MeshPart geom="box" args={[20, 4, 4]} pos={[10, 0, 0]} color={c} glow={glow} opacity={opacity} />
          <MeshPart geom="box" args={[4, 20, 4]} pos={[0, 10, 0]} color={c} glow={glow} opacity={opacity} />
        </>

      // ── 加强筋 ── diagonal gusset triangle
      case 'gusset': {
        return <mesh geometry={GUSSET_GEOMETRY} position={[-12, -12, -2]}>
          <meshStandardMaterial color={c} metalness={0.8} roughness={0.2} transparent={opacity < 1} opacity={opacity} />
        </mesh>
      }

      // ── 内角码 ── smaller inside-corner bracket
      case 'inside-corner':
        return <>
          <MeshPart geom="box" args={[14, 3, 3]} pos={[7, 0, 0]} color={c} glow={glow} opacity={opacity} />
          <MeshPart geom="box" args={[3, 14, 3]} pos={[0, 7, 0]} color={c} glow={glow} opacity={opacity} />
        </>

      // ── 直连板 ── flat inline joining plate (end-to-end)
      case 'flat-plate':
        return <>
          <MeshPart geom="box" args={[60, 4, 18]} pos={[0, 0, 0]} color={c} glow={glow} opacity={opacity} />
          <MeshPart geom="cylinder" args={[2.5, 2.5, 5, 12]} pos={[-20, 3, 0]} rot={[Math.PI / 2, 0, 0]} color={c} glow={glow} opacity={opacity} />
          <MeshPart geom="cylinder" args={[2.5, 2.5, 5, 12]} pos={[20, 3, 0]} rot={[Math.PI / 2, 0, 0]} color={c} glow={glow} opacity={opacity} />
        </>

      // ── T型角码 ── T-bracket connecting 3 profiles
      case 't-bracket':
        return <>
          <MeshPart geom="box" args={[40, 4, 4]} pos={[0, 0, 0]} color={c} glow={glow} opacity={opacity} />
          <MeshPart geom="box" args={[4, 20, 4]} pos={[0, 10, 0]} color={c} glow={glow} opacity={opacity} />
        </>

      // ── 十字连接板 ── 4-way cross plate
      case 'cross-bracket':
        return <>
          <MeshPart geom="box" args={[48, 4, 4]} pos={[0, 0, 0]} color={c} glow={glow} opacity={opacity} />
          <MeshPart geom="box" args={[4, 48, 4]} pos={[0, 0, 0]} color={c} glow={glow} opacity={opacity} />
        </>

      // ── 端盖 ── end cap for profile
      case 'end-cap':
        return <>
          <MeshPart geom="box" args={[20, 20, 3]} pos={[0, 0, 0]} color={c} glow={glow} opacity={opacity} />
          <MeshPart geom="box" args={[10, 10, 6]} pos={[0, 0, 4]} color={c} glow={glow} opacity={opacity} />
        </>

      // ── 合页 ── door hinge
      case 'hinge':
        return <>
          <MeshPart geom="box" args={[3, 30, 18]} pos={[-1.5, 0, 0]} color={c} glow={glow} opacity={opacity} />
          <MeshPart geom="box" args={[3, 30, 18]} pos={[1.5, 0, 0]} color={c} glow={glow} opacity={opacity} />
          <MeshPart geom="cylinder" args={[2.5, 2.5, 32, 12]} pos={[0, 0, 0]} rot={[Math.PI / 2, 0, 0]} color={c} glow={glow} opacity={opacity} />
        </>

      // ── 轴承座 ── pivot / bearing housing
      case 'pivot':
        return <>
          <MeshPart geom="box" args={[30, 6, 20]} pos={[0, -3, 0]} color={c} glow={glow} opacity={opacity} />
          <MeshPart geom="cylinder" args={[8, 8, 10, 16]} pos={[0, 5, 0]} rot={[0, 0, 0]} color={c} glow={glow} opacity={opacity} />
          <MeshPart geom="cylinder" args={[4, 4, 16, 12]} pos={[0, 5, 0]} rot={[0, 0, 0]} color={'#1e293b'} opacity={opacity} />
        </>

      // ── 脚轮座 ── caster wheel mount
      case 'caster-mount':
        return <>
          <MeshPart geom="box" args={[40, 4, 40]} pos={[0, 0, 0]} color={c} glow={glow} opacity={opacity} />
          <MeshPart geom="cylinder" args={[12, 12, 8, 16]} pos={[0, -6, 0]} color={c} glow={glow} opacity={opacity} />
          <MeshPart geom="cylinder" args={[8, 8, 20, 12]} pos={[0, -18, 0]} rot={[Math.PI / 2, 0, 0]} color={c} glow={glow} opacity={opacity} />
        </>

      // ── 调节脚 ── adjustable leveling foot
      case 'foot':
        return <>
          <MeshPart geom="cylinder" args={[18, 18, 3, 16]} pos={[0, -1.5, 0]} color={c} glow={glow} opacity={opacity} />
          <MeshPart geom="cylinder" args={[5, 5, 24, 12]} pos={[0, 12, 0]} color={c} glow={glow} opacity={opacity} />
          <MeshPart geom="box" args={[20, 4, 20]} pos={[0, 26, 0]} color={c} glow={glow} opacity={opacity} />
        </>

      // ── 对接板 ── internal profile joining connector (hidden inside channels)
      case 'joining-plate':
        return <>
          <MeshPart geom="box" args={[4, 16, 50]} pos={[0, 0, 0]} color={c} glow={glow} opacity={opacity} />
          <MeshPart geom="cylinder" args={[3, 3, 6, 12]} pos={[0, 0, -16]} rot={[0, 0, Math.PI / 2]} color={c} glow={glow} opacity={opacity} />
          <MeshPart geom="cylinder" args={[3, 3, 6, 12]} pos={[0, 0, 16]} rot={[0, 0, Math.PI / 2]} color={c} glow={glow} opacity={opacity} />
        </>

      // ── 三维角码 ── 3-way corner connector (XYZ corner)
      case 'corner-3way':
        return <>
          <MeshPart geom="box" args={[20, 4, 4]} pos={[10, 0, 0]} color={c} glow={glow} opacity={opacity} />
          <MeshPart geom="box" args={[4, 20, 4]} pos={[0, 10, 0]} color={c} glow={glow} opacity={opacity} />
          <MeshPart geom="box" args={[4, 4, 20]} pos={[0, 0, 10]} color={c} glow={glow} opacity={opacity} />
          <MeshPart geom="box" args={[8, 8, 8]} pos={[0, 0, 0]} color={c} glow={glow} opacity={opacity} />
        </>

      // ── 滑块螺母 ── T-slot nut (slides in channel)
      case 't-nut':
        return <>
          <MeshPart geom="box" args={[18, 4, 7]} pos={[0, 0, 0]} color={c} glow={glow} opacity={opacity} />
          <MeshPart geom="box" args={[10, 8, 4]} pos={[0, -4, 0]} color={c} glow={glow} opacity={opacity} />
          <MeshPart geom="cylinder" args={[2.5, 2.5, 12, 12]} pos={[0, 4, 0]} color={c} glow={glow} opacity={opacity} />
        </>

      default:
        return <MeshPart geom="box" args={[10, 10, 10]} pos={[0, 0, 0]} color={c} glow={glow} opacity={opacity} />
    }
  }

  return (
    <group
      position={new THREE.Vector3(...position)}
      quaternion={new THREE.Quaternion(...quaternion).normalize()}
      scale={scale}
      raycast={preview ? () => null : undefined}
    >
      {renderParts()}
    </group>
  )
}

export default Connector
