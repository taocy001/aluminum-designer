import React, { useMemo, useEffect } from 'react'
import * as THREE from 'three'

const COLORS: Record<string, string> = { endpoint: '#facc15', joint: '#22d3ee', align: '#a78bfa', segment: '#22d3ee', grid: '#94a3b8', start: '#f8fafc' }

/** Screen-size-constant marker (stays visible at any zoom): disc for endpoints, diamond for centerline joints */
const SnapMarker: React.FC<{ position: THREE.Vector3 | [number, number, number]; kind: string; size?: number }> = ({ position, kind, size = 0.032 }) => {
  const texture = useMemo(() => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 64
    const ctx = c.getContext('2d')!
    const color = COLORS[kind] ?? COLORS.grid
    ctx.lineWidth = 6; ctx.strokeStyle = color; ctx.fillStyle = color + 'aa'
    ctx.beginPath()
    if (kind === 'joint' || kind === 'segment') { ctx.moveTo(32, 6); ctx.lineTo(58, 32); ctx.lineTo(32, 58); ctx.lineTo(6, 32); ctx.closePath() }
    else if (kind === 'align') { ctx.rect(10, 10, 44, 44) }
    else { ctx.arc(32, 32, 24, 0, Math.PI * 2) }
    ctx.fill(); ctx.stroke()
    if (kind === 'endpoint' || kind === 'start') { ctx.fillStyle = '#0f172a'; ctx.beginPath(); ctx.arc(32, 32, 7, 0, Math.PI * 2); ctx.fill() }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t
  }, [kind])
  useEffect(() => () => texture.dispose(), [texture])
  const pos = position instanceof THREE.Vector3 ? position : new THREE.Vector3(...position)
  return (
    <sprite position={pos} scale={[size, size, 1]} renderOrder={20} raycast={() => null}>
      <spriteMaterial map={texture} transparent depthTest={false} sizeAttenuation={false} />
    </sprite>
  )
}

export default SnapMarker
