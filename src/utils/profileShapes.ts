import * as THREE from 'three'

export type ProfileSpec = '2020' | '2040' | '3030' | '3040' | '4040'

export const getProfileShape = (spec: ProfileSpec): THREE.Shape => {
  const shape = new THREE.Shape()

  const matches = spec.match(/\d+/g)
  const w = matches ? Number(matches[0]) : 20
  const h = matches ? (matches.length > 1 ? Number(matches[1]) : w) : 20
  
  const hw = w / 2
  const hh = h / 2
  
  // T-Slot dimensions
  const sw = w >= 30 ? 4.0 : 3.0 // half-width of opening
  const sd = w >= 30 ? 9.0 : 6.0 // depth of slot
  const dw = 2.0 // wall thickness

  // BUILD OUTER PATH (Clockwise for stability)
  shape.moveTo(-hw, hh)

  // Top Side
  const nx = Math.floor(w / 20)
  for (let i = 0; i < nx; i++) {
    const cx = -hw + (i + 0.5) * (w / nx)
    shape.lineTo(cx - sw, hh)
    shape.lineTo(cx - sw, hh - sd)
    shape.lineTo(cx + sw, hh - sd)
    shape.lineTo(cx + sw, hh)
  }
  shape.lineTo(hw, hh)

  // Right Side
  const ny = Math.floor(h / 20)
  for (let i = 0; i < ny; i++) {
    const cy = hh - (i + 0.5) * (h / ny)
    shape.lineTo(hw, cy + sw)
    shape.lineTo(hw - sd, cy + sw)
    shape.lineTo(hw - sd, cy - sw)
    shape.lineTo(hw, cy - sw)
  }
  shape.lineTo(hw, -hh)

  // Bottom Side
  for (let i = nx - 1; i >= 0; i--) {
    const cx = -hw + (i + 0.5) * (w / nx)
    shape.lineTo(cx + sw, -hh)
    shape.lineTo(cx + sw, -hh + sd)
    shape.lineTo(cx - sw, -hh + sd)
    shape.lineTo(cx - sw, -hh)
  }
  shape.lineTo(-hw, -hh)

  // Left Side
  for (let i = ny - 1; i >= 0; i--) {
    const cy = -hh + (i + 0.5) * (h / ny)
    shape.lineTo(-hw, cy - sw)
    shape.lineTo(-hw + sd, cy - sw)
    shape.lineTo(-hw + sd, cy + sw)
    shape.lineTo(-hw, cy + sw)
  }
  shape.lineTo(-hw, hh)

  // ADD CENTER HOLE FOR BETTER TRIANGULATION STABILITY
  // This breaks up the large concave face into a ring, which Earcut handles much better.
  const holePath = new THREE.Path()
  const holeR = 2.5
  holePath.absarc(0, 0, holeR, 0, Math.PI * 2, true)
  shape.holes.push(holePath)

  return shape
}
