import React, { useMemo, useEffect } from 'react'
import * as THREE from 'three'

interface Props {
  text: string
  position: [number, number, number]
  /** world height of the label in mm */
  height?: number
  color?: string
  background?: string
}

/**
 * Camera-facing text label drawn into a 2D canvas texture.
 * No external fonts, no suspense — safe for offline / firewalled deployments.
 */
const TextSprite: React.FC<Props> = ({ text, position, height = 26, color = '#e2e8f0', background = 'rgba(15,23,42,0.85)' }) => {
  const { texture, aspect } = useMemo(() => {
    const scale = 4
    const fontPx = 16 * scale
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!
    ctx.font = `bold ${fontPx}px ui-monospace, Menlo, Consolas, monospace`
    const padX = 8 * scale, padY = 4 * scale
    const w = Math.ceil(ctx.measureText(text).width + padX * 2)
    const h = Math.ceil(fontPx + padY * 2)
    canvas.width = w; canvas.height = h
    ctx.font = `bold ${fontPx}px ui-monospace, Menlo, Consolas, monospace`
    ctx.fillStyle = background
    const r = 6 * scale
    ctx.beginPath()
    ctx.moveTo(r, 0); ctx.lineTo(w - r, 0); ctx.quadraticCurveTo(w, 0, w, r)
    ctx.lineTo(w, h - r); ctx.quadraticCurveTo(w, h, w - r, h)
    ctx.lineTo(r, h); ctx.quadraticCurveTo(0, h, 0, h - r)
    ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0)
    ctx.fill()
    ctx.fillStyle = color
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    ctx.fillText(text, w / 2, h / 2)
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.minFilter = THREE.LinearFilter
    tex.needsUpdate = true
    return { texture: tex, aspect: w / h }
  }, [text, color, background])

  useEffect(() => () => texture.dispose(), [texture])

  return (
    <sprite position={position} scale={[height * aspect, height, 1]} renderOrder={10} raycast={() => null}>
      <spriteMaterial map={texture} transparent depthTest={false} sizeAttenuation />
    </sprite>
  )
}

export default TextSprite
