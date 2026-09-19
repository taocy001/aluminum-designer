import React, { useEffect, useRef } from 'react'
import { Canvas, useThree, useFrame } from '@react-three/fiber'
import { OrbitControls, Grid, Text, Billboard } from '@react-three/drei'
import * as THREE from 'three'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { getProfileEndpoints } from '../utils/snapUtils'
import Profile from './Profile'
import Connector from './Connector'
import DrawingHandler from './DrawingHandler'
import DragHandler from './DragHandler'

// Resets camera position and orbit target when triggered
const CameraController: React.FC = () => {
  const { camera, controls } = useThree()
  const { cameraResetTrigger } = useToolStore()
  const prevTrigger = useRef(0)

  useEffect(() => {
    if (cameraResetTrigger > 0 && cameraResetTrigger !== prevTrigger.current) {
      prevTrigger.current = cameraResetTrigger
      camera.position.set(300, 300, 300)
      if (controls) {
        const orbit = controls as any
        orbit.target.set(0, 0, 0)
        orbit.update()
      }
    }
  }, [cameraResetTrigger, camera, controls])

  return null
}

// Resolves frame selection rect → profile IDs
const FrameSelector: React.FC = () => {
  const { camera, size } = useThree()
  const profiles = useStore((s) => s.profiles)
  const selectItems = useStore((s) => s.selectItems)
  const frameSelectRect = useToolStore((s) => s.frameSelectRect)
  const clearFrameSelectRect = useToolStore((s) => s.clearFrameSelectRect)

  useEffect(() => {
    if (!frameSelectRect) return
    const { x1, y1, x2, y2 } = frameSelectRect
    if (x2 - x1 < 5 || y2 - y1 < 5) {
      clearFrameSelectRect()
      return
    }

    const selected: string[] = []
    for (const profile of profiles) {
      const pos = new THREE.Vector3(...profile.position)
      const quat = new THREE.Quaternion(...profile.quaternion)
      const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(quat)
      const mid = pos.clone().addScaledVector(dir, profile.length / 2)

      mid.project(camera)
      const sx = (mid.x + 1) / 2 * size.width
      const sy = (1 - mid.y) / 2 * size.height

      if (sx >= x1 && sx <= x2 && sy >= y1 && sy <= y2) {
        selected.push(profile.id)
      }
    }

    selectItems(selected)
    clearFrameSelectRect()
  }, [frameSelectRect, camera, size, profiles, selectItems, clearFrameSelectRect])

  return null
}

// Dimension labels — always positioned outside the profile cross-section
const DimensionLabels: React.FC = () => {
  const profiles = useStore((s) => s.profiles)

  return (
    <>
      {profiles.map((p) => {
        const { start, end } = getProfileEndpoints(p)
        const mid = start.clone().lerp(end, 0.5)
        const dir = end.clone().sub(start).normalize()

        // Offset away from the profile body based on orientation
        if (Math.abs(dir.y) > 0.7) {
          // Vertical profile → offset sideways
          mid.x += 30
          mid.z += 10
        } else {
          // Horizontal profile → offset upward past the cross-section
          // Tallest spec is 40mm, so top surface is 20mm above center; use 28mm
          mid.y += 28
        }

        return (
          <Billboard key={p.id} position={mid.toArray() as [number, number, number]}>
            <Text
              fontSize={9}
              color="#e2e8f0"
              anchorX="center"
              anchorY="middle"
              outlineWidth={0.8}
              outlineColor="#0f172a"
              depthOffset={-5}
            >
              {Math.round(p.length)}mm
            </Text>
          </Billboard>
        )
      })}
    </>
  )
}

const Viewport: React.FC = () => {
  const { profiles, connectors, selectedIds, selectItem, clearSelection } = useStore()
  const { isDrawing, viewMode, isDragging, showDimensionLabels, selectMode } = useToolStore()

  const orbitEnabled = !isDragging && !selectMode && (viewMode === 'navigate' || !isDrawing)

  return (
    <Canvas
      camera={{ position: [300, 300, 300], fov: 45 }}
      shadows={false}
    >
      <color attach="background" args={['#1e293b']} />

      <ambientLight intensity={0.6} />
      <directionalLight position={[300, 500, 300]} intensity={1.2} />
      <directionalLight position={[-200, 300, -200]} intensity={0.4} color="#cce4ff" />

      <Grid
        infiniteGrid
        cellSize={10}
        sectionSize={100}
        fadeDistance={1500}
        cellColor="#334155"
        sectionColor="#475569"
      />

      {profiles.map((p) => (
        <Profile
          key={p.id}
          {...p}
          isSelected={selectedIds.includes(p.id)}
          onClick={(multi) => selectItem(p.id, multi)}
        />
      ))}

      {connectors.map((c) => (
        <Connector
          key={c.id}
          {...c}
          isSelected={selectedIds.includes(c.id)}
          onClick={() => selectItem(c.id, false)}
        />
      ))}

      {showDimensionLabels && <DimensionLabels />}

      <DrawingHandler />
      <DragHandler />
      <FrameSelector />

      <OrbitControls makeDefault enabled={orbitEnabled} />
      <CameraController />
    </Canvas>
  )
}

export default Viewport
