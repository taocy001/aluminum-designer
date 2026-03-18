import * as THREE from 'three'

export type ProfileSpec = '2020' | '2040' | '3030' | '3040' | '4040'

export const getProfileShape = (spec: ProfileSpec): THREE.Shape => {
  const shape = new THREE.Shape()

  const w = Number(spec.substring(0, 2))
  const h = Number(spec.substring(2)) || w

  const hw = w / 2
  const hh = h / 2

  // T-Slot dimensions
  const sw = w >= 30 ? 4.0 : 3.0 // half-width of opening
  const sd = w >= 30 ? 9.0 : 6.0 // depth of slot

  const nx = Math.floor(w / 20)
  const ny = Math.floor(h / 20)

  // BUILD OUTER PATH (Counter-Clockwise — required by Three.js ExtrudeGeometry)
  // CCW traversal: top-left → down left side → bottom-left → right along bottom
  //                → bottom-right → up right side → top-right → left along top → top-left
  shape.moveTo(-hw, hh) // top-left

  // Left Side (going DOWN)
  for (let i = 0; i < ny; i++) {
    const cy = hh - (i + 0.5) * (h / ny)
    shape.lineTo(-hw, cy + sw)
    shape.lineTo(-hw + sd, cy + sw)
    shape.lineTo(-hw + sd, cy - sw)
    shape.lineTo(-hw, cy - sw)
  }
  shape.lineTo(-hw, -hh) // bottom-left

  // Bottom Side (going RIGHT)
  for (let i = 0; i < nx; i++) {
    const cx = -hw + (i + 0.5) * (w / nx)
    shape.lineTo(cx - sw, -hh)
    shape.lineTo(cx - sw, -hh + sd)
    shape.lineTo(cx + sw, -hh + sd)
    shape.lineTo(cx + sw, -hh)
  }
  shape.lineTo(hw, -hh) // bottom-right

  // Right Side (going UP)
  for (let i = ny - 1; i >= 0; i--) {
    const cy = hh - (i + 0.5) * (h / ny)
    shape.lineTo(hw, cy - sw)
    shape.lineTo(hw - sd, cy - sw)
    shape.lineTo(hw - sd, cy + sw)
    shape.lineTo(hw, cy + sw)
  }
  shape.lineTo(hw, hh) // top-right

  // Top Side (going LEFT)
  for (let i = nx - 1; i >= 0; i--) {
    const cx = -hw + (i + 0.5) * (w / nx)
    shape.lineTo(cx + sw, hh)
    shape.lineTo(cx + sw, hh - sd)
    shape.lineTo(cx - sw, hh - sd)
    shape.lineTo(cx - sw, hh)
  }
  shape.lineTo(-hw, hh) // close path

  return shape
}
