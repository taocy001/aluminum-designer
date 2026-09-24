import React, { useMemo } from 'react'
import * as THREE from 'three'
import { Line } from '@react-three/drei'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { analyzeFrame } from '../utils/analysis'
import { computeFrameBounds } from '../utils/jointUtils'
import TextSprite from './TextSprite'

/** how far outside the frame the dimension lines stand off, as a fraction of the frame */
const OFFSET_RATIO = 0.06
const MIN_OFFSET = 60

const AXIS_COLOR = { x: '#ef4444', y: '#22c55e', z: '#3b82f6' } as const

/** A dimension line with ticks at both ends and the measurement in the middle */
const Dim: React.FC<{ from: THREE.Vector3; to: THREE.Vector3; tick: THREE.Vector3; color: string; label: number }> =
  ({ from, to, tick, color, label }) => {
    const mid = from.clone().lerp(to, 0.5)
    const value = Math.round(from.distanceTo(to))
    const t = tick.clone().multiplyScalar(0.5)
    return (
      <group raycast={() => null}>
        <Line points={[from, to]} color={color} lineWidth={2} />
        <Line points={[from.clone().sub(t), from.clone().add(t)]} color={color} lineWidth={2} />
        <Line points={[to.clone().sub(t), to.clone().add(t)]} color={color} lineWidth={2} />
        <TextSprite text={`${value}`} priority={3} position={mid.toArray() as [number, number, number]}
          height={label} color="#f8fafc" background="rgba(15,23,42,0.92)" />
      </group>
    )
  }

/**
 * The frame's overall width, depth and height, drawn just outside it.
 *
 * A drawing that does not say how big the thing is cannot be handed to anybody. It shares
 * the switch with the per-member cut lengths: both are measurements on the drawing, and two
 * buttons for the same idea is one more than anybody wants to reason about.
 */
const FrameDimensions: React.FC = () => {
  const profiles = useStore((s) => s.profiles)
  const panels = useStore((s) => s.panels)
  const show = useToolStore((s) => s.showDimensionLabels)
  const { trims } = useMemo(() => analyzeFrame(profiles), [profiles])

  const bounds = useMemo(() => {
    const b = computeFrameBounds(profiles, trims)
    if (!b) return null
    // boards stick out past the frame they hang on, and they are part of the thing
    for (const p of panels) {
      const half = new THREE.Vector3(p.width / 2, p.height / 2, p.thickness / 2)
      const q = new THREE.Quaternion(...p.quaternion).normalize()
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        b.expandByPoint(new THREE.Vector3(half.x * sx, half.y * sy, half.z * sz)
          .applyQuaternion(q).add(new THREE.Vector3(...p.position)))
      }
    }
    return b
  }, [profiles, trims, panels])

  if (!show || !bounds || profiles.length === 0) return null
  const min = bounds.min, max = bounds.max
  const size = bounds.getSize(new THREE.Vector3())
  const off = Math.max(MIN_OFFSET, Math.max(size.x, size.y, size.z) * OFFSET_RATIO)

  // width along X, in front of the frame and on the floor
  const wFrom = new THREE.Vector3(min.x, min.y, max.z + off)
  const wTo = new THREE.Vector3(max.x, min.y, max.z + off)
  // depth along Z, to the right of the frame
  const dFrom = new THREE.Vector3(max.x + off, min.y, min.z)
  const dTo = new THREE.Vector3(max.x + off, min.y, max.z)
  // height along Y, at the near right corner
  const hFrom = new THREE.Vector3(max.x + off, min.y, max.z + off)
  const hTo = new THREE.Vector3(max.x + off, max.y, max.z + off)

  // the label grows with the frame: 26 mm of text is unreadable across a five-metre kitchen
  const label = Math.max(40, Math.max(size.x, size.y, size.z) * 0.035)

  return (
    <group name="frame-dimensions">
      <Dim from={wFrom} to={wTo} tick={new THREE.Vector3(0, 0, off * 0.4)} color={AXIS_COLOR.x} label={label} />
      <Dim from={dFrom} to={dTo} tick={new THREE.Vector3(off * 0.4, 0, 0)} color={AXIS_COLOR.z} label={label} />
      <Dim from={hFrom} to={hTo} tick={new THREE.Vector3(off * 0.4, 0, 0)} color={AXIS_COLOR.y} label={label} />
    </group>
  )
}

export default FrameDimensions
