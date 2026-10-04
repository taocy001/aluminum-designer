import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { getProfileShape, profileSideAt } from '../utils/profileShapes'
import { profileSlotDimensions, slotOffsets, specDims } from '../utils/specUtils'

const sections = [
  ['2020', 162.0393092325699, 1],
  ['2040', 286.6642416764325, 3],
  ['3030', 313.9299381783353, 5],
  ['4040', 657.0971709806104, 5],
] as const

describe('manufacturer profile sections', () => {
  it.each(sections)('%s retains its CAD boundary, voids and section area', (spec, cadArea, holeCount) => {
    const shape = getProfileShape(spec)
    const { shape: boundary, holes } = shape.extractPoints(12)
    const { w, h } = specDims(spec)
    expect(Math.max(...boundary.map((point) => point.x))).toBeCloseTo(w / 2, 4)
    expect(Math.min(...boundary.map((point) => point.x))).toBeCloseTo(-w / 2, 4)
    expect(Math.max(...boundary.map((point) => point.y))).toBeCloseTo(h / 2, 4)
    expect(Math.min(...boundary.map((point) => point.y))).toBeCloseTo(-h / 2, 4)
    expect(holes).toHaveLength(holeCount)
    const area = Math.abs(THREE.ShapeUtils.area(boundary)) - holes.reduce((sum, hole) => sum + Math.abs(THREE.ShapeUtils.area(hole)), 0)
    // STEP planar-face area, allowing the documented 0.05 mm chord approximation.
    expect(Math.abs(area - cadArea) / cadArea).toBeLessThan(.004)
  })

  it.each(sections)('%s renders an open slot, retaining lips, an expanded cavity and a core hole', (spec) => {
    const dimensions = profileSlotDimensions(specDims(spec).w)
    const geometry = new THREE.ExtrudeGeometry(getProfileShape(spec), { depth: 40, bevelEnabled: false })
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.updateMatrixWorld()
    const metalAt = (x: number, y: number) => new THREE.Raycaster(new THREE.Vector3(x, y, -5), new THREE.Vector3(0, 0, 1))
      .intersectObject(mesh, false).length > 0
    const top = specDims(spec).hh
    try {
      expect(metalAt(0, top - .8)).toBe(false)
      expect(metalAt(dimensions.width / 2 + .4, top - .8)).toBe(true)
      expect(metalAt(dimensions.width / 2 + 1, top - dimensions.lipDepth - 1.4)).toBe(false)
      expect(metalAt(2, top - dimensions.depth - .7)).toBe(true)
      expect(metalAt(0, 0)).toBe(false)
    } finally { geometry.dispose(); material.dispose() }
  })

  it('uses B6 double slots on the 2040 wide side and one I8 slot on each 4040 face', () => {
    expect(slotOffsets(40, 20)).toEqual([-10, 10])
    expect(slotOffsets(20, 20)).toEqual([0])
    expect(slotOffsets(30, 30)).toEqual([0])
    expect(slotOffsets(40, 40)).toEqual([0])
  })

  it('associates a 2040 retaining lip and deep cavity wall with the side containing their slot mouth', () => {
    for (const [x, y, nx, ny] of [[8.5, 14, -1, 0], [7.5, 16, 0, -1], [4.5, 10, 1, 0]]) {
      expect(profileSideAt('2040', { x, y }, { x: nx, y: ny })).toEqual({ axis: 0, side: 1 })
    }
  })

  it('returns independently editable shapes without changing the CAD template', () => {
    const shape = getProfileShape('2020')
    shape.holes.length = 0
    expect(getProfileShape('2020').holes).toHaveLength(1)
  })
})
