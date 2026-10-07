import * as THREE from 'three'
import { profileSlotDimensions, slotOffsets, specDims } from './specUtils'
import profileSections from '../assets/profileSections.json'

import type { ProfileSpec } from '../store/useStore'
export type { ProfileSpec } from '../store/useStore'

interface ProfileSide { axis: 0 | 1; side: -1 | 1 }
interface OutlineSegment {
  from: [number, number]
  to: [number, number]
  face: ProfileSide
}

const outlines = new Map<ProfileSpec, OutlineSegment[]>()

/** One contour supplies both the rendered section and the owning side of each slot wall. */
function profileOutline(spec: ProfileSpec): OutlineSegment[] {
  const cached = outlines.get(spec)
  if (cached) return cached

  const { w, h } = specDims(spec)

  const hw = w / 2
  const hh = h / 2

  const section = spec === '3040' ? undefined : profileSections[spec]
  if (section) {
    const outerFaces = section.outer.map((from, i): ProfileSide | undefined => {
      const to = section.outer[(i + 1) % section.outer.length]
      for (const axis of [0, 1] as const) for (const side of [-1, 1] as const) {
        const boundary = side * (axis === 0 ? hw : hh)
        if (Math.abs(from[axis] - boundary) < 1e-4 && Math.abs(to[axis] - boundary) < 1e-4) return { axis, side }
      }
    })
    const segments = section.outer.map((from, i): OutlineSegment => {
      const to = section.outer[(i + 1) % section.outer.length]
      let before = i, after = i
      while (!outerFaces[before]) before = (before + section.outer.length - 1) % section.outer.length
      while (!outerFaces[after]) after = (after + 1) % section.outer.length
      const previous = outerFaces[before]!, next = outerFaces[after]!
      // Every retaining lip, undercut and floor between two flats on one side
      // belongs to that side, even when its wall lies closer to a neighbouring side.
      const slotFace = previous.axis === next.axis && previous.side === next.side ? previous : undefined
      const x = (from[0] + to[0]) / 2, y = (from[1] + to[1]) / 2
      const axis = hw - Math.abs(x) < hh - Math.abs(y) ? 0 : 1
      return { from: [from[0], from[1]], to: [to[0], to[1]],
        face: slotFace ?? { axis, side: (axis === 0 ? x : y) < 0 ? -1 : 1 } }
    })
    outlines.set(spec, segments)
    return segments
  }

  // The legacy 3040 section is schematic; no manufacturer drawing is assigned.
  const slot = profileSlotDimensions(w)
  const sw = slot.width / 2
  const sd = slot.depth

  const nx = slotOffsets(w, 30).length
  const ny = slotOffsets(h, 30).length

  // BUILD OUTER PATH (Counter-Clockwise — required by Three.js ExtrudeGeometry)
  // CCW traversal: top-left → down left side → bottom-left → right along bottom
  //                → bottom-right → up right side → top-right → left along top → top-left
  let cursor: [number, number] = [-hw, hh]
  let face: ProfileSide = { axis: 0, side: -1 }
  const segments: OutlineSegment[] = []
  const lineTo = (x: number, y: number) => {
    const to: [number, number] = [x, y]
    segments.push({ from: cursor, to, face })
    cursor = to
  }

  // Left Side (going DOWN)
  for (let i = 0; i < ny; i++) {
    const cy = hh - (i + 0.5) * (h / ny)
    lineTo(-hw, cy + sw)
    lineTo(-hw + sd, cy + sw)
    lineTo(-hw + sd, cy - sw)
    lineTo(-hw, cy - sw)
  }
  lineTo(-hw, -hh) // bottom-left

  // Bottom Side (going RIGHT)
  face = { axis: 1, side: -1 }
  for (let i = 0; i < nx; i++) {
    const cx = -hw + (i + 0.5) * (w / nx)
    lineTo(cx - sw, -hh)
    lineTo(cx - sw, -hh + sd)
    lineTo(cx + sw, -hh + sd)
    lineTo(cx + sw, -hh)
  }
  lineTo(hw, -hh) // bottom-right

  // Right Side (going UP)
  face = { axis: 0, side: 1 }
  for (let i = ny - 1; i >= 0; i--) {
    const cy = hh - (i + 0.5) * (h / ny)
    lineTo(hw, cy - sw)
    lineTo(hw - sd, cy - sw)
    lineTo(hw - sd, cy + sw)
    lineTo(hw, cy + sw)
  }
  lineTo(hw, hh) // top-right

  // Top Side (going LEFT)
  face = { axis: 1, side: 1 }
  for (let i = nx - 1; i >= 0; i--) {
    const cx = -hw + (i + 0.5) * (w / nx)
    lineTo(cx + sw, hh)
    lineTo(cx + sw, hh - sd)
    lineTo(cx - sw, hh - sd)
    lineTo(cx - sw, hh)
  }
  lineTo(-hw, hh) // close path

  outlines.set(spec, segments)
  return segments
}

export const getProfileShape = (spec: ProfileSpec): THREE.Shape => {
  const segments = profileOutline(spec)
  const shape = new THREE.Shape()
  shape.moveTo(...segments[0].from)
  for (const segment of segments) shape.lineTo(...segment.to)
  if (spec !== '3040') for (const points of profileSections[spec].holes) {
    const path = new THREE.Path()
    path.moveTo(points[0][0], points[0][1])
    for (const point of points.slice(1)) path.lineTo(point[0], point[1])
    path.closePath()
    shape.holes.push(path)
  }
  return shape
}

/**
 * The outer reference side owning a hit on the extruded section. A slot's inner wall
 * may face sideways, so its triangle normal is only a tie-breaker at contour corners.
 */
export function profileSideAt(
  spec: ProfileSpec, point: { x: number; y: number }, normal: { x: number; y: number },
): ProfileSide {
  let best: OutlineSegment | null = null
  let bestDistance = Infinity, bestFacing = -Infinity
  for (const segment of profileOutline(spec)) {
    const [ax, ay] = segment.from, [bx, by] = segment.to
    const dx = bx - ax, dy = by - ay
    const lengthSq = dx * dx + dy * dy
    if (lengthSq === 0) continue
    const t = THREE.MathUtils.clamp(((point.x - ax) * dx + (point.y - ay) * dy) / lengthSq, 0, 1)
    const distance = (point.x - ax - dx * t) ** 2 + (point.y - ay - dy * t) ** 2
    // This contour is counter-clockwise, so its material-side outward normal is (dy,-dx).
    const facing = (normal.x * dy - normal.y * dx) / Math.sqrt(lengthSq)
    if (distance < bestDistance - 1e-8 || (Math.abs(distance - bestDistance) <= 1e-8 && facing > bestFacing)) {
      best = segment; bestDistance = distance; bestFacing = facing
    }
  }
  return { ...best!.face }
}
