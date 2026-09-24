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
/**
 * How long the view has to have been still before the labels are laid out again (ms).
 *
 * Laying out hundreds of labels means a ray per label through every part, and doing it while
 * the view was moving took a flat of twelve cabinets from 55 ms a frame to 276. While the
 * view moves the labels keep what they had; they are sorted out once it stops.
 */
const SETTLE_MS = 120

const LabelLayout: React.FC = () => {
  const { camera, scene, size } = useThree()
  const raycaster = useMemo(() => new THREE.Raycaster(), [])
  const last = useRef({ at: 0, view: new THREE.Matrix4(), movedAt: 0, pending: true })

  useFrame(() => {
    const now = performance.now()
    const st = last.current
    if (!st.view.equals(camera.matrixWorld)) {
      st.view.copy(camera.matrixWorld); st.movedAt = now; st.pending = true
      return
    }
    if (dirty) { dirty = false; st.pending = true }
    if (st.pending ? now - st.movedAt < SETTLE_MS : now - st.at < IDLE_MS) return
    st.at = now
    st.pending = false

    // what can stand in front of a label: the parts themselves, as drawn, each with its
    // bounding sphere in the world worked out once here rather than once per ray
    // Each part as its own box, in its own frame: whether a label is behind a member is a
    // question about the member's outline, not about the triangles of its T-slots, and
    // asking the triangles made the layout after every stop take a third of a second.
    const solids: Array<{ id: string; sphere: THREE.Sphere; box: THREE.Box3; toLocal: THREE.Matrix4 }> = []
    scene.traverseVisible((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      const id = partOf(o)
      if (!id) return
      const g = m.geometry
      if (!g.boundingSphere) g.computeBoundingSphere()
      if (!g.boundingBox) g.computeBoundingBox()
      solids.push({ id, sphere: g.boundingSphere!.clone().applyMatrix4(m.matrixWorld), box: g.boundingBox!, toLocal: m.matrixWorld.clone().invert() })
    })
    const local = new THREE.Ray()
    const hitAt = new THREE.Vector3()

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
        let blocked = false
        for (const s of solids) {
          if (s.id === e.owner || !raycaster.ray.intersectsSphere(s.sphere)) continue
          const near = raycaster.ray.origin.distanceTo(s.sphere.center) - s.sphere.radius
          if (near > dist) continue
          local.copy(raycaster.ray).applyMatrix4(s.toLocal)
          if (!local.intersectBox(s.box, hitAt)) continue
          // back in the world, is the box struck before the label is reached?
          if (hitAt.applyMatrix4(s.toLocal.clone().invert()).distanceTo(eye) < dist) { blocked = true; break }
        }
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
