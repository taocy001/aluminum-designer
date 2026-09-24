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

/**
 * A flat corner plate, drawn as the part it is.
 *
 * Both arms lie in one plane — that is what "the two members share a face" buys you — so
 * this is a plate bent nowhere, an L lying against the frame. It was two 4 mm square bars,
 * which at this size read as a staple rather than a bracket, and gave no clue where the
 * bolts go. Now each arm is the width of the face it sits on, and the two holes are drawn,
 * because where those holes land is the whole question the seating answers.
 *
 * The local origin is where the two bolt lines cross, which is what `seatBracket` positions.
 */
const PLATE_W = 20        // across the arm: the width of a 20 face
const PLATE_T = 4         // thickness
const PLATE_REACH = 30    // how far each arm runs past the corner
const PLATE_BACK = 10     // how far it runs the other way, to cover the corner
const HOLE_AT = 18        // bolt centre along each arm from the origin

/**
 * A cast corner bracket: two flanges at ninety degrees, meeting at the inside vertex.
 *
 * Its local origin is that vertex, +X runs along one member and +Y along the other, so both
 * flanges lie in the positive quadrant — which is the inside of the corner, where the part
 * actually goes. It was drawn as a flat L in one plane, which is a joining plate: a different
 * part, bolted to different faces, in a different place.
 */
const ANGLE_T = 4        // flange thickness
const ANGLE_W = 18       // across the flange, just under a 20 face
const ANGLE_REACH = 30   // how far each flange runs from the vertex
const ANGLE_HOLE = 16    // bolt centre along each flange

const AngleBracket: React.FC<{ color: string; glow?: string; opacity: number }> = ({ color, glow, opacity }) => (
  <>
    {/* the flange lying on the member that runs along +X */}
    <MeshPart geom="box" args={[ANGLE_REACH, ANGLE_T, ANGLE_W]} pos={[ANGLE_REACH / 2, ANGLE_T / 2, 0]} color={color} glow={glow} opacity={opacity} />
    {/* ...and the one on the member that runs along +Y */}
    <MeshPart geom="box" args={[ANGLE_T, ANGLE_REACH, ANGLE_W]} pos={[ANGLE_T / 2, ANGLE_REACH / 2, 0]} color={color} glow={glow} opacity={opacity} />
    {/* the web that makes it stiff, which is why a cast bracket beats a plate at a corner */}
    <mesh position={[0, 0, 0]} rotation={[Math.PI / 2, 0, 0]}>
      <cylinderGeometry args={[ANGLE_T * 1.6, ANGLE_T * 1.6, ANGLE_W * 0.55, 3]} />
      <meshStandardMaterial color={color} metalness={0.3} roughness={0.55}
        emissive={glow ?? '#000000'} emissiveIntensity={glow ? 0.9 : 0}
        transparent={opacity < 1} opacity={opacity} />
    </mesh>
    {/* the bolts: each one drops a T-nut into the face its flange is lying on */}
    <MeshPart geom="cylinder" args={[2.6, 2.6, ANGLE_T + 5, 12]} pos={[ANGLE_HOLE, ANGLE_T / 2, 0]} color="#1e293b" opacity={opacity} />
    <MeshPart geom="cylinder" args={[2.6, 2.6, ANGLE_T + 5, 12]} pos={[ANGLE_T / 2, ANGLE_HOLE, 0]} rot={[0, 0, Math.PI / 2]} color="#1e293b" opacity={opacity} />
  </>
)

const CornerPlate: React.FC<{ color: string; glow?: string; opacity: number }> = ({ color, glow, opacity }) => {
  const armLen = PLATE_REACH + PLATE_BACK
  const armMid = (PLATE_REACH - PLATE_BACK) / 2
  return <>
    <MeshPart geom="box" args={[armLen, PLATE_W, PLATE_T]} pos={[armMid, 0, PLATE_T / 2]} color={color} glow={glow} opacity={opacity} />
    <MeshPart geom="box" args={[PLATE_W, armLen, PLATE_T]} pos={[0, armMid, PLATE_T / 2]} color={color} glow={glow} opacity={opacity} />
    {/* the bolts: what the part is for, and the only way to see whether they found a slot */}
    <MeshPart geom="cylinder" args={[3, 3, PLATE_T + 3, 12]} pos={[HOLE_AT, 0, PLATE_T / 2]} rot={[Math.PI / 2, 0, 0]} color="#1e293b" opacity={opacity} />
    <MeshPart geom="cylinder" args={[3, 3, PLATE_T + 3, 12]} pos={[0, HOLE_AT, PLATE_T / 2]} rot={[Math.PI / 2, 0, 0]} color="#1e293b" opacity={opacity} />
  </>
}

const MeshPart: React.FC<MeshPartProps & { opacity?: number; glow?: string }> = ({ geom, args, pos = [0, 0, 0], rot = [0, 0, 0], color, opacity = 1, glow }) => (
  <mesh position={pos} rotation={rot}>
    {geom === 'box'
      ? <boxGeometry args={args as [number, number, number]} />
      : <cylinderGeometry args={args as [number, number, number, number]} />
    }
    {/* A bracket is a 20 mm part on a frame metres across. Colour alone does not carry at
        that size, so a selected or hovered one lights up from the inside.

        Metalness stays where the profiles keep it. There is no environment map in this
        scene, and a metal has no diffuse term — at 0.8 every bracket rendered as a black
        smudge with a highlight on it, which read as a fault rather than a part. */}
    <meshStandardMaterial
      color={color} metalness={0.3} roughness={0.55}
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

      // ── L型角码 ── two flanges at 90°, inside the corner, a bolt into each member
      case 'bracket':
        return <AngleBracket color={c} glow={glow} opacity={opacity} />

      // ── 加强筋 ── a flat triangular plate across the outside face of the corner
      case 'gusset': {
        return <mesh geometry={GUSSET_GEOMETRY} position={[-12, -12, -2]}>
          <meshStandardMaterial color={c} metalness={0.8} roughness={0.2} transparent={opacity < 1} opacity={opacity} />
        </mesh>
      }

      // ── 内角码 ── the same angle, smaller, for tight corners
      case 'inside-corner':
        return <group scale={0.7}><AngleBracket color={c} glow={glow} opacity={opacity} /></group>

      // ── 直连板 ── flat inline joining plate (end-to-end)
      case 'flat-plate':
        return <>
          <MeshPart geom="box" args={[60, 4, 18]} pos={[0, 0, 0]} color={c} glow={glow} opacity={opacity} />
          <MeshPart geom="cylinder" args={[2.5, 2.5, 5, 12]} pos={[-20, 3, 0]} rot={[Math.PI / 2, 0, 0]} color={c} glow={glow} opacity={opacity} />
          <MeshPart geom="cylinder" args={[2.5, 2.5, 5, 12]} pos={[20, 3, 0]} rot={[Math.PI / 2, 0, 0]} color={c} glow={glow} opacity={opacity} />
        </>

      // ── T型角码 ── a flat T plate across the outside face where a member meets a run
      case 't-bracket':
        return <>
          <MeshPart geom="box" args={[70, 20, 4]} pos={[0, 0, 2]} color={c} glow={glow} opacity={opacity} />
          <MeshPart geom="box" args={[20, 40, 4]} pos={[0, 20, 2]} color={c} glow={glow} opacity={opacity} />
          <MeshPart geom="cylinder" args={[3, 3, 7, 12]} pos={[-22, 0, 2]} rot={[Math.PI / 2, 0, 0]} color="#1e293b" opacity={opacity} />
          <MeshPart geom="cylinder" args={[3, 3, 7, 12]} pos={[22, 0, 2]} rot={[Math.PI / 2, 0, 0]} color="#1e293b" opacity={opacity} />
          <MeshPart geom="cylinder" args={[3, 3, 7, 12]} pos={[0, 28, 2]} rot={[Math.PI / 2, 0, 0]} color="#1e293b" opacity={opacity} />
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
      userData={{ connectorId: id }}
      raycast={preview ? () => null : undefined}
    >
      {renderParts()}
    </group>
  )
}

// the store keeps every part it did not touch, so identity says whether this one changed
export default React.memo(Connector)
