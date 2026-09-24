import * as THREE from 'three'
import type { PanelData, ProfileData } from '../store/useStore'
import { computeAllTrims, trimmedBox, type ProfileTrims } from './jointUtils'

/** a board thinner than this, measured upright, is lying down: a shelf, a top, a base (mm) */
const LYING_MAX = 40

export type ShelfEdge = 'x-' | 'x+' | 'z-' | 'z+'

export interface ShelfEdgeState {
  panelId: string
  edge: ShelfEdge
  carried: boolean
  /** the edge's two ends at the underside of the board */
  a: THREE.Vector3
  b: THREE.Vector3
  /** height of the board's underside */
  underY: number
  /** the member that carries it, when one does */
  by: string | null
}

/** The world box a board takes up */
export function panelBox(b: PanelData): THREE.Box3 {
  const q = new THREE.Quaternion(...b.quaternion).normalize()
  const box = new THREE.Box3()
  const c = new THREE.Vector3(...b.position)
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    box.expandByPoint(new THREE.Vector3(sx * b.width / 2, sy * b.height / 2, sz * b.thickness / 2).applyQuaternion(q).add(c))
  }
  return box
}

/**
 * The four edges of every board lying flat, and whether each is carried by metal.
 *
 * A shelf hung between two rails is held along two edges; the other two sag under a row of
 * books and the board can tip off. An edge is carried when a member runs under or beside it
 * for most of its length (70 %), within 25 mm of the edge line and level with the board to
 * within 2 mm — the same test the example drawings are held to.
 */
export function shelfEdges(panels: PanelData[], profiles: ProfileData[], trims?: Map<string, ProfileTrims>): ShelfEdgeState[] {
  const t = trims ?? computeAllTrims(profiles)
  const metal = profiles.map((p) => ({ id: p.id, box: trimmedBox(p, t.get(p.id)!) }))
  const out: ShelfEdgeState[] = []
  for (const b of panels) {
    const box = panelBox(b)
    const size = box.getSize(new THREE.Vector3())
    if (size.y > LYING_MAX) continue
    const carrier = (axis: 'x' | 'z', at: number): string | null => {
      const other = axis === 'x' ? 'z' : 'x'
      for (const m of metal) {
        const run = Math.min(m.box.max[axis], box.max[axis]) - Math.max(m.box.min[axis], box.min[axis])
        if (run >= size[axis] * 0.7 && m.box.max.y >= box.min.y - 2 && m.box.min.y <= box.max.y + 2
          && m.box.min[other] - 25 <= at && at <= m.box.max[other] + 25) return m.id
      }
      return null
    }
    const y = box.min.y
    const edges: Array<[ShelfEdge, 'x' | 'z', number, THREE.Vector3, THREE.Vector3]> = [
      ['x-', 'z', box.min.x, new THREE.Vector3(box.min.x, y, box.min.z), new THREE.Vector3(box.min.x, y, box.max.z)],
      ['x+', 'z', box.max.x, new THREE.Vector3(box.max.x, y, box.min.z), new THREE.Vector3(box.max.x, y, box.max.z)],
      ['z-', 'x', box.min.z, new THREE.Vector3(box.min.x, y, box.min.z), new THREE.Vector3(box.max.x, y, box.min.z)],
      ['z+', 'x', box.max.z, new THREE.Vector3(box.min.x, y, box.max.z), new THREE.Vector3(box.max.x, y, box.max.z)],
    ]
    for (const [edge, axis, at, a, bb] of edges) {
      const by = carrier(axis, at)
      out.push({ panelId: b.id, edge, carried: by !== null, a, b: bb, underY: y, by })
    }
  }
  return out
}

/** the edge across the board from this one */
export function oppositeEdge(e: ShelfEdge): ShelfEdge {
  return ({ 'x-': 'x+', 'x+': 'x-', 'z-': 'z+', 'z+': 'z-' } as const)[e]
}
