import React from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, Grid, Environment, ContactShadows } from '@react-three/drei'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import Profile from './Profile'
import Connector from './Connector'
import DrawingHandler from './DrawingHandler'

const Viewport: React.FC = () => {
  const { profiles, connectors, selectedId, selectProfile } = useStore()
  const { isDrawing } = useToolStore()

  return (
    <Canvas 
      camera={{ position: [300, 300, 300], fov: 45 }}
      // Disable shadows for now to ensure stability
      shadows={false}
    >
      <color attach="background" args={['#1e293b']} />
      
      <ambientLight intensity={1.0} />
      <pointLight position={[500, 500, 500]} intensity={1.5} />
      <pointLight position={[-500, -500, -500]} intensity={0.5} color="#60a5fa" />
      
      <Grid 
        infiniteGrid 
        followCursor 
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
      
      <OrbitControls makeDefault enabled={!isDrawing} />
      <Environment preset="city" />
    </Canvas>
  )
}

export default Viewport
