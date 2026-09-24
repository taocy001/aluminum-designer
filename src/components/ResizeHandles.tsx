import React, { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { getProfileEndpoints, getProfileDir } from '../utils/geometryCore'
import { specDims } from '../utils/specUtils'
import TextSprite from './TextSprite'

/** Pixels from an end face that count as "reaching for the end" */
export const END_GRAB_PX = 26

/** World distance that corresponds to `px` screen pixels at `dist` from a perspective camera */
export function pixelsToWorld(px: number, dist: number, camera: THREE.Camera, viewportHeight: number): number {
  const fov = (camera as THREE.PerspectiveCamera).fov ?? 45
  const viewHeight = 2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2) * dist
  return (px / Math.max(1, viewportHeight)) * viewHeight
}

/** How close to an end face a press has to be to start a stretch, in world units */
export function endGrabRadius(profileLength: number, dist: number, camera: THREE.Camera, viewportHeight: number): number {
  return Math.min(pixelsToWorld(END_GRAB_PX, dist, camera, viewportHeight), profileLength / 3)
}

/** A flat arrow head drawn into a texture: a sprite never skews with the viewing angle */
function arrowTexture(): THREE.CanvasTexture {
  const size = 128
  const c = document.createElement('canvas')
  c.width = size; c.height = size
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fbbf24'
  ctx.strokeStyle = '#0f172a'
  ctx.lineWidth = 6
  ctx.beginPath()
  ctx.moveTo(size * 0.92, size * 0.5)
  ctx.lineTo(size * 0.32, size * 0.14)
  ctx.lineTo(size * 0.46, size * 0.5)
  ctx.lineTo(size * 0.32, size * 0.86)
  ctx.closePath()
  ctx.fill(); ctx.stroke()
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/**
 * The stretch affordance for the single selected member: nothing at all until the pointer
 * reaches for an end, then a flat arrow just outside that end face, plus the live length
 * while a stretch is running. The arrow is a sprite, so it reads the same from any angle —
 * a cone skews into an unrecognisable shape when seen along its own axis.
 */
const ResizeHandles: React.FC = () => {
  const selectedIds = useStore((s) => s.selectedIds)
  const profiles = useStore((s) => s.profiles)
  const held = useToolStore((s) => s.held)
  const resize = useToolStore((s) => s.resize)
  const hoverEnd = useToolStore((s) => s.hoverEnd)
  const { camera, size } = useThree()

  const texture = useMemo(() => arrowTexture(), [])
  useEffect(() => () => texture.dispose(), [texture])

  const target = selectedIds.length === 1 ? profiles.find((p) => p.id === selectedIds[0]) : undefined
  const live = resize?.id === target?.id ? resize : null
  const shownEnd = live ? live.end : hoverEnd

  const geometry = useMemo(() => {
    if (!target) return null
    const { start, end } = getProfileEndpoints(target)
    const { w, h } = specDims(target.spec)
    return { start, end, dir: getProfileDir(target), section: Math.max(w, h) }
  }, [target])

  const sprite = useRef<THREE.Sprite | null>(null)
  useFrame(() => {
    if (!sprite.current || !geometry) return
    // constant on-screen size, so the arrow is as big as the zone that reacts to it
    const world = pixelsToWorld(END_GRAB_PX * 1.6, sprite.current.position.distanceTo(camera.position), camera, size.height)
    sprite.current.scale.set(world, world, 1)
  })

  if (!target || !geometry || held !== null || target.locked || !shownEnd) return null
  const { start, end, dir, section } = geometry
  const at = shownEnd === 'start' ? start : end
  const out = shownEnd === 'start' ? dir.clone().negate() : dir.clone()
  const pos = at.clone().addScaledVector(out, section * 0.9)

  return (
    <>
      <sprite ref={sprite} position={pos} renderOrder={12}>
        <spriteMaterial map={texture} transparent depthTest={false} sizeAttenuation />
      </sprite>
      {live && (
        <TextSprite
          text={`${Math.round(target.length)} mm`}
          priority={4}
          position={at.clone().addScaledVector(out, section * 2.6).toArray() as [number, number, number]}
          height={section * 1.6}
          color="#fde68a"
        />
      )}
    </>
  )
}

export default ResizeHandles
