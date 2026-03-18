import React, { useEffect, useRef } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { OrbitControls, Grid } from '@react-three/drei'
import * as THREE from 'three'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import Profile from './Profile'
import Connector from './Connector'
import DrawingHandler from './DrawingHandler'

// Resets camera position and orbit target when triggerred
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

const Viewport: React.FC = () => {
  const { profiles, connectors, selectedId, selectProfile } = useStore()
  const { isDrawing, viewMode } = useToolStore()

  const orbitEnabled = viewMode === 'navigate' || !isDrawing

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
          isSelected={selectedId === p.id}
          onClick={() => selectProfile(p.id)}
        />
      ))}

      {connectors.map((c) => (
        <Connector
          key={c.id}
          {...c}
          isSelected={selectedId === c.id}
          onClick={() => selectProfile(c.id)}
        />
      ))}

      <DrawingHandler />

      <OrbitControls makeDefault enabled={orbitEnabled} />
      <CameraController />
    </Canvas>
  )
}

export default Viewport
