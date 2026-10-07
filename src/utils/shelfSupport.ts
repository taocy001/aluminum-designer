import * as THREE from 'three'
import type { ConnectorData, EquipmentData, FittingData, PanelData, ProfileData } from '../store/useStore'
import { computeAllTrims, trimmedBox, type ProfileTrims } from './jointUtils'
import { panelOBB, trimmedOBB } from './analysis'
import { bodiesTouch } from './assembly'
import { panelMountFrame } from './panelMounts'
import { createConnectorPlacementValidator } from './connectorPlacement'

/** a board thinner than this, measured upright, is lying down: a shelf, a top, a base (mm) */
const LYING_MAX = 40
/** a carrier's top face and the board's underside may differ by this much and still touch (mm) */
const LEVEL_TOL = 0.1
/** how far from the edge line a carrier may run and still be the one holding that edge (mm) */
const EDGE_REACH = 25

export type ShelfEdge = 'x-' | 'x+' | 'z-' | 'z+'

export interface ShelfEdgeState {
  panelId: string
  edge: ShelfEdge
  carried: boolean
  /** Two valid fasteners near this edge span at least half its length. Not a load rating. */
  fixed: boolean
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

type Point2 = [number, number]

function hull(points: Point2[]): Point2[] {
  const sorted = points.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (a: Point2, b: Point2, c: Point2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  const half = (list: Point2[]) => {
    const out: Point2[] = []
    for (const p of list) { while (out.length > 1 && cross(out[out.length - 2], out[out.length - 1], p) <= 1e-8) out.pop(); out.push(p) }
    return out
  }
  return [...half(sorted).slice(0, -1), ...half([...sorted].reverse()).slice(0, -1)]
}

/** Clip an actual projected face to one half-plane in board coordinates. */
function clip(points: Point2[], axis: 0 | 1, at: number, keepAbove: boolean): Point2[] {
  const out: Point2[] = []
  const inside = (p: Point2) => keepAbove ? p[axis] >= at : p[axis] <= at
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length]
    const ia = inside(a), ib = inside(b)
    if (ia) out.push(a)
    if (ia !== ib) {
      const t = (at - a[axis]) / (b[axis] - a[axis])
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
    }
  }
  return out
}

/**
 * Check the board's actual four edges, including a shelf rotated in the horizontal plane.
 * A bearing face must touch its underside and cover at least 70% of an edge's length within
 * its inner 25 mm strip. A world AABB only touching the shelf near a corner carries no edge.
 * Tilted boards are not assigned support by this horizontal-bearing heuristic.
 */
export function shelfEdges(panels: PanelData[], profiles: ProfileData[], trims?: Map<string, ProfileTrims>,
  connectors: ConnectorData[] = [], obstructions: { fittings?: FittingData[]; equipment?: EquipmentData[] } = {}): ShelfEdgeState[] {
  const t = trims ?? computeAllTrims(profiles)
  const metal = profiles.map((p) => ({ id: p.id, box: trimmedBox(p, t.get(p.id)!), body: trimmedOBB(p, t.get(p.id)!) }))
  const mounts = connectors.filter((c) => c.panelMount)
  const validate = mounts.length ? createConnectorPlacementValidator(profiles, { panels, ...obstructions }, t) : null
  const validMounts = mounts.filter((c) => validate!(c, connectors.filter((other) => other.id !== c.id)).allowed)
  const out: ShelfEdgeState[] = []
  for (const b of panels) {
    const box = panelBox(b)
    if (box.getSize(new THREE.Vector3()).y > LYING_MAX) continue
    const board = panelOBB(b), q = new THREE.Quaternion(...b.quaternion).normalize()
    const u = new THREE.Vector3(1, 0, 0).applyQuaternion(q)
    const v = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(q)
    const centre = new THREE.Vector3(...b.position)
    const under = centre.clone().addScaledVector(normal, -Math.sign(normal.y) * b.thickness / 2)
    const half = [b.width / 2, b.height / 2] as const
    const holes = validMounts.filter((c) => c.panelMount!.panelId === b.id).map((c) => {
      const delta = panelMountFrame(c).boardHole.sub(centre)
      return [delta.dot(u), delta.dot(v)] as Point2
    })
    const world = (x: number, y: number) => under.clone().addScaledVector(u, x).addScaledVector(v, y)
    const uAxis = Math.abs(u.x) >= Math.abs(u.z) ? 'x' : 'z'
    const vAxis = uAxis === 'x' ? 'z' : 'x'
    // All four edge checks use the same actual top faces clipped to this board.
    // Keep member order so the first carrier is unchanged, and clip each edge from
    // the read-only board polygon rather than rebuilding its geometry four times.
    const bearing: { id: string; polygon: Point2[] }[] = []
    if (!(Math.abs(normal.y) < 1 - 1e-6)) for (const m of metal) {
      if (Math.abs(m.box.max.y - under.y) > LEVEL_TOL || !bodiesTouch(board, m.body, LEVEL_TOL)) continue
      // Only a real horizontal top face can bear the board over its projected length.
      // Projecting the whole body would credit a rising rail whose tip alone touches it.
      const topAxis = m.body.axes.findIndex((direction) => Math.abs(direction.y) > 1 - 1e-6)
      if (topAxis < 0) continue
      const top = m.body.center.clone().addScaledVector(m.body.axes[topAxis],
        Math.sign(m.body.axes[topAxis].y) * m.body.half.getComponent(topAxis))
      const sides = [0, 1, 2].filter((i) => i !== topAxis)
      const face = [-1, 1].flatMap((a) => [-1, 1].map((bb) => top.clone()
        .addScaledVector(m.body.axes[sides[0]], a * m.body.half.getComponent(sides[0]))
        .addScaledVector(m.body.axes[sides[1]], bb * m.body.half.getComponent(sides[1]))))
      let polygon = hull(face.map((p) => { const d = p.sub(centre); return [d.dot(u), d.dot(v)] }))
      for (const i of [0, 1] as const) {
        polygon = clip(polygon, i, -half[i], true)
        polygon = clip(polygon, i, half[i], false)
      }
      bearing.push({ id: m.id, polygon })
    }
    const carrier = (axis: 0 | 1, sign: number): string | null => {
      const other = axis === 0 ? 1 : 0
      for (const m of bearing) {
        const polygon = clip(m.polygon, axis, sign * (half[axis] - EDGE_REACH), sign > 0)
        if (polygon.length < 3) continue
        const span = (i: 0 | 1) => Math.max(...polygon.map((p) => p[i])) - Math.min(...polygon.map((p) => p[i]))
        if (span(other) >= half[other] * 2 * 0.7 && span(axis) > 0.1) return m.id
      }
      return null
    }
    for (const axis of [0, 1] as const) for (const sign of [-1, 1]) {
      const direction = axis === 0 ? u : v, label = axis === 0 ? uAxis : vAxis
      const edge = `${label}${sign * direction[label] < 0 ? '-' : '+'}` as ShelfEdge
      const a = axis === 0 ? world(sign * half[0], -half[1]) : world(-half[0], sign * half[1])
      const bb = axis === 0 ? world(sign * half[0], half[1]) : world(half[0], sign * half[1])
      const by = carrier(axis, sign)
      const along = holes.filter((p) => Math.abs(p[axis] - sign * half[axis]) <= EDGE_REACH)
        .map((p) => p[axis === 0 ? 1 : 0])
      const fixed = along.length >= 2 && Math.max(...along) - Math.min(...along) >= half[axis === 0 ? 1 : 0] - LEVEL_TOL
      out.push({ panelId: b.id, edge, carried: by !== null, fixed, a, b: bb, underY: under.y, by })
    }
  }
  return out
}

/** the edge across the board from this one */
export function oppositeEdge(e: ShelfEdge): ShelfEdge {
  return ({ 'x-': 'x+', 'x+': 'x-', 'z-': 'z+', 'z+': 'z-' } as const)[e]
}
