import React, { useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

/**
 * Which labels are shown, decided once for all of them.
 *
 * Each label used to decide for itself, with the depth buffer: a label half behind a board
 * was drawn half, cut on the diagonal where the board crossed it, and read as a black
 * triangle over the joint underneath. Two labels in the same place were both drawn, one
 * over the other, and neither could be read.
 *
 * So a label is now shown whole or not at all. It is hidden when something other than the
 * part it belongs to stands between it and the eye, and when a label that matters more —
 * or, among equals, one nearer — already has that bit of the screen.
 */
export interface LabelEntry {
  sprite: THREE.Sprite
  /** higher wins a patch of screen: overall size, then a member's length, then a part's */
  priority: number
  /** the part the label is on, which is not in the way of its own label */
  owner?: string
}

const entries = new Set<LabelEntry>()
let dirty = true

export function registerLabel(e: LabelEntry): () => void {
  entries.add(e)
  dirty = true
  return () => { entries.delete(e); dirty = true }
}

/** the part a mesh belongs to, found the way picking finds it */
function partOf(o: THREE.Object3D | null): string | null {
  while (o) {
    const d = o.userData as Record<string, string>
    const id = d.profileId ?? d.panelId ?? d.connectorId ?? d.fittingId
    if (id) return id
    o = o.parent
  }
  return null
}

/** a little air between two labels, in pixels */
const GAP = 3
/** how often the layout is redone while nothing is moving — doors open, parts are added (ms) */
const IDLE_MS = 600
/** and at most this often while the view is moving (ms) */
const BUSY_MS = 90

const LabelLayout: React.FC = () => {
  const { camera, scene, size } = useThree()
  const raycaster = useMemo(() => new THREE.Raycaster(), [])
  const last = useRef({ at: 0, view: new THREE.Matrix4() })

  useFrame(() => {
    const now = performance.now()
    const moved = !last.current.view.equals(camera.matrixWorld)
    const wait = moved || dirty ? BUSY_MS : IDLE_MS
    if (now - last.current.at < wait) return
    last.current.at = now
    last.current.view.copy(camera.matrixWorld)
    dirty = false

    // what can stand in front of a label: the parts themselves, as drawn
    const solids: THREE.Object3D[] = []
    scene.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh && partOf(o)) solids.push(o) })

    const eye = camera.position
    const cam = camera as THREE.PerspectiveCamera
    const pxPerUnit = size.height / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov ?? 45) / 2))
    const forward = new THREE.Vector3()
    camera.getWorldDirection(forward)

    const placed: Array<{ l: number; r: number; t: number; b: number }> = []
    const list = [...entries].map((e) => {
      const at = e.sprite.getWorldPosition(new THREE.Vector3())
      return { e, at, depth: at.clone().sub(eye).dot(forward) }
    }).sort((a, b) => b.e.priority - a.e.priority || a.depth - b.depth)

    for (const { e, at, depth } of list) {
      const show = (() => {
        if (depth <= cam.near) return false
        const ndc = at.clone().project(camera)
        if (Math.abs(ndc.x) > 1.1 || Math.abs(ndc.y) > 1.1) return false
        const x = (ndc.x + 1) / 2 * size.width, y = (1 - ndc.y) / 2 * size.height
        const h = e.sprite.scale.y * pxPerUnit / depth, w = e.sprite.scale.x * pxPerUnit / depth
        const box = { l: x - w / 2 - GAP, r: x + w / 2 + GAP, t: y - h / 2 - GAP, b: y + h / 2 + GAP }
        if (placed.some((p) => box.l < p.r && box.r > p.l && box.t < p.b && box.b > p.t)) return false
        // cheapest first: only a label that would get its patch of screen is asked about walls
        const toward = at.clone().sub(eye)
        const dist = toward.length()
        raycaster.set(eye, toward.normalize())
        raycaster.far = dist
        const blocked = raycaster.intersectObjects(solids, false).some((hit) => partOf(hit.object) !== e.owner)
        if (blocked) return false
        placed.push(box)
        return true
      })()
      e.sprite.visible = show
    }
  })

  return null
}

export default LabelLayout
