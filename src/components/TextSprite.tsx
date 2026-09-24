import React, { useMemo, useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { registerLabel } from './LabelLayout'

interface Props {
  text: string
  position: [number, number, number]
  /** world height of the label in mm */
  height?: number
  color?: string
  background?: string
  /**
   * Whether the label is hidden by what is in front of it.
   *
   * On by default: a drawing where every dimension floats over everything, including the
   * dimensions of parts on the far side, is unreadable at the first glance that matters. A
   * marker that has to be findable through the metal — a snap point, a fault — turns it off.
   */
  throughWalls?: boolean
  /** which label keeps a patch of screen two of them want (see LabelLayout) */
  priority?: number
  /** the part this label is on, which does not hide its own label */
  owner?: string
}

/**
 * Camera-facing text label drawn into a 2D canvas texture.
 * No external fonts, no suspense — safe for offline / firewalled deployments.
 */
/** how far a label leans out of the surface it is on, towards the camera (mm) */
const LEAN = 40

const TextSprite: React.FC<Props> = ({ text, position, height = 26, color = '#e2e8f0', background = 'rgba(15,23,42,0.85)', throughWalls = false, priority = 1, owner }) => {
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

  /**
   * Stand the label off its anchor towards whoever is reading it.
   *
   * A sprite is a quad that turns to face the camera, so at anything but a head-on view it
   * reaches sideways through whatever it is sitting on — and a label placed a millimetre off
   * a board came out sliced in half by that board. Leaning it towards the camera clears the
   * surface from every angle, and because the lean is along the sight line it changes nothing
   * about where the label appears to be.
   */
  const ref = useRef<THREE.Sprite>(null)
  // A marker that has to be found through the metal is always drawn; every other label is
  // shown whole or not at all, by the layout, rather than cut by whatever crosses it.
  useEffect(() => {
    if (throughWalls || !ref.current) return
    return registerLabel({ sprite: ref.current, priority, owner })
  }, [throughWalls, priority, owner])
  useFrame(({ camera }) => {
    const sp = ref.current
    if (!sp || throughWalls) return
    const anchor = Array.isArray(position) ? new THREE.Vector3(...position) : position
    const lean = camera.position.clone().sub(anchor)
    const d = lean.length()
    if (d < 1e-6) return
    sp.position.copy(anchor).addScaledVector(lean, Math.min(LEAN, d * 0.25) / d)
  })

  return (
    <sprite ref={ref} position={position} scale={[height * aspect, height, 1]} renderOrder={10} raycast={() => null}>
      <spriteMaterial map={texture} transparent depthTest={false} depthWrite={false} sizeAttenuation />
    </sprite>
  )
}

export default TextSprite
