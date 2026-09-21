import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { rotateSelected, selectionPivot, type RotAxis } from '../utils/editOps'

/**
 * Where the rotate buttons are right now, so PointerRouter can leave presses on them alone.
 * They are sprites, so there is no DOM element to hit-test against.
 */
export const gizmoState = {
  busy: false,
  buttons: [] as Array<{ axis: RotAxis; position: THREE.Vector3; radius: number }>,
}

/** true when the ray passes through one of the rotate buttons */
export function gizmoOwnsRay(ray: THREE.Ray): boolean {
  for (const b of gizmoState.buttons) {
    // the sprite is square, so its corners reach a little past the inscribed circle
    if (ray.distanceSqToPoint(b.position) <= (b.radius * 1.42) ** 2) return true
  }
  return false
}

const AXES: RotAxis[] = ['x', 'y', 'z']
const AXIS_COLOR: Record<RotAxis, string> = { x: '#ef4444', y: '#22c55e', z: '#3b82f6' }
/** on-screen size of a button, as a fraction of the viewport height */
const BUTTON_SCREEN = 0.055
const BUTTON_GAP = 1.35

/** A circular arrow drawn into a canvas texture, so it stays crisp and camera-facing */
function arrowTexture(color: string, reverse: boolean): THREE.CanvasTexture {
  const size = 128
  const c = document.createElement('canvas')
  c.width = size; c.height = size
  const ctx = c.getContext('2d')!
  ctx.fillStyle = 'rgba(15,23,42,0.88)'
  ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2); ctx.fill()
  ctx.strokeStyle = color; ctx.lineWidth = 9; ctx.lineCap = 'round'
  const r = size * 0.28
  const from = Math.PI * 1.35
  const to = Math.PI * 0.75
  ctx.beginPath(); ctx.arc(size / 2, size / 2, r, from, to, reverse); ctx.stroke()
  // the head sits at the end the arc stops at, which swaps when the sweep is reversed
  const head = reverse ? from : to
  const hx = size / 2 + Math.cos(head) * r
  const hy = size / 2 + Math.sin(head) * r
  const tangent = head + (reverse ? -Math.PI / 2 : Math.PI / 2)
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(hx + Math.cos(tangent) * 16, hy + Math.sin(tangent) * 16)
  ctx.lineTo(hx + Math.cos(tangent + 2.4) * 14, hy + Math.sin(tangent + 2.4) * 14)
  ctx.lineTo(hx + Math.cos(tangent - 2.4) * 14, hy + Math.sin(tangent - 2.4) * 14)
  ctx.closePath(); ctx.fill()
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/**
 * Rotation buttons floating next to the selection: one click turns it 90° about that world
 * axis, four clicks come back to where it started; Shift reverses. Frames are built on right
 * angles, so a free-rotation gizmo only got in the way of picking the model.
 */
const RotateGizmo: React.FC = () => {
  const { camera } = useThree()
  const selectedIds = useStore((s) => s.selectedIds)
  const profiles = useStore((s) => s.profiles)
  const connectors = useStore((s) => s.connectors)
  const viewMode = useToolStore((s) => s.viewMode)
  const selectMode = useToolStore((s) => s.selectMode)
  const isDragging = useToolStore((s) => s.isDragging)
  const showGizmo = useToolStore((s) => s.showGizmo)

  const group = useRef<THREE.Group>(null)
  const sprites = useRef<Array<THREE.Sprite | null>>([])
  const pressedOn = useRef<RotAxis | null>(null)
  const [shiftHeld, setShiftHeld] = React.useState(false)

  const textures = useMemo(() => {
    const map = {} as Record<RotAxis, { cw: THREE.CanvasTexture; ccw: THREE.CanvasTexture }>
    for (const a of AXES) map[a] = { cw: arrowTexture(AXIS_COLOR[a], false), ccw: arrowTexture(AXIS_COLOR[a], true) }
    return map
  }, [])
  useEffect(() => () => {
    for (const a of AXES) { textures[a].cw.dispose(); textures[a].ccw.dispose() }
  }, [textures])

  const selection = useMemo(() => {
    const ids = new Set(selectedIds)
    return {
      profiles: profiles.filter((p) => ids.has(p.id)),
      connectors: connectors.filter((c) => ids.has(c.id)),
    }
  }, [selectedIds, profiles, connectors])

  const anchor = useMemo(() => selectionPivot(selection.profiles, selection.connectors), [selection])
  const active = showGizmo && viewMode === 'navigate' && !selectMode && !isDragging && selectedIds.length > 0

  // Shift shows the reversed arrows, so the modifier is visible before the click
  useEffect(() => {
    const sync = (e: KeyboardEvent) => setShiftHeld(e.shiftKey)
    window.addEventListener('keydown', sync)
    window.addEventListener('keyup', sync)
    return () => { window.removeEventListener('keydown', sync); window.removeEventListener('keyup', sync) }
  }, [])

  // the gizmo can disappear mid-press (Escape, Delete, mode switch): never leave `busy` latched
  useEffect(() => {
    if (active) return
    gizmoState.busy = false
    gizmoState.buttons = []
    pressedOn.current = null
  }, [active])
  useEffect(() => () => { gizmoState.busy = false; gizmoState.buttons = [] }, [])

  // Positions follow the camera every frame: orbiting or zooming must not leave the buttons
  // (or their hit regions) behind, and React does not re-render on camera motion.
  useFrame(() => {
    if (!active || !group.current) return
    const persp = camera as THREE.PerspectiveCamera
    const dist = anchor.distanceTo(camera.position)
    const viewHeight = 2 * Math.tan(THREE.MathUtils.degToRad(persp.fov ?? 45) / 2) * dist
    const worldSize = viewHeight * BUTTON_SCREEN
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize()
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize()
    const base = anchor.clone().addScaledVector(up, worldSize * 2.1)

    gizmoState.buttons = AXES.map((axis, i) => {
      const pos = base.clone().addScaledVector(right, (i - 1) * worldSize * BUTTON_GAP)
      const sprite = sprites.current[i]
      if (sprite) {
        sprite.position.copy(pos)
        sprite.scale.set(worldSize, worldSize, 1)
      }
      return { axis, position: pos, radius: worldSize * 0.5 }
    })
  })

  const onRelease = useCallback((axis: RotAxis, e: any) => {
    gizmoState.busy = false
    if (pressedOn.current !== axis) return   // the press started somewhere else: not our click
    pressedOn.current = null
    e.stopPropagation()
    e.nativeEvent?.stopPropagation?.()
    rotateSelected(axis, e.nativeEvent?.shiftKey ? -90 : 90)
  }, [])

  if (!active) return null

  return (
    <group ref={group} renderOrder={30}>
      {AXES.map((axis, i) => (
        <sprite
          key={axis}
          ref={(s) => { sprites.current[i] = s }}
          renderOrder={30}
          onPointerDown={(e) => {
            gizmoState.busy = true
            pressedOn.current = axis
            e.stopPropagation()
            e.nativeEvent?.stopPropagation?.()
          }}
          onPointerUp={(e) => onRelease(axis, e)}
          onPointerOut={() => { gizmoState.busy = false; pressedOn.current = null }}
        >
          <spriteMaterial map={shiftHeld ? textures[axis].ccw : textures[axis].cw} transparent depthTest={false} sizeAttenuation />
        </sprite>
      ))}
    </group>
  )
}

export default RotateGizmo
