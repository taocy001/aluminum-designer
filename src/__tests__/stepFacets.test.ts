import { describe, expect, it } from 'vitest'
import { Vector3 } from 'three'
import { planarMeshFaces } from '../utils/stepFacets'

const points = [[0,0,0], [4,0,0], [4,4,0], [0,4,0], [1,1,0], [3,1,0], [3,3,0], [1,3,0]].map(p => new Vector3(...p))
const ringTriangles = [[0,1,5], [0,5,4], [1,2,6], [1,6,5], [2,3,7], [2,7,6], [3,0,4], [3,4,7]]

describe('STEP planar face merging', () => {
  it('keeps the outer boundary and reverse-wound through hole without filling it', () => {
    const shells = planarMeshFaces(points, ringTriangles)
    expect(shells).toHaveLength(1)
    expect(shells[0]).toHaveLength(1)
    const [outer, hole] = shells[0][0].rings
    expect(new Set(outer)).toEqual(new Set([0,1,2,3]))
    expect(new Set(hole)).toEqual(new Set([4,5,6,7]))
    const area = (r: number[]) => r.reduce((s, a, i) => s + points[a].clone().cross(points[r[(i+1)%r.length]]).z, 0) / 2
    expect(area(outer)).toBe(16)
    expect(area(hole)).toBe(-4)
  })
  it('keeps edge-disconnected surfaces separate and retains shared-edge vertices', () => {
    const p = [...points, new Vector3(10,0,0), new Vector3(11,0,0), new Vector3(10,1,0)]
    const shells = planarMeshFaces(p, [...ringTriangles, [8,9,10]])
    expect(shells).toHaveLength(2)
    expect(shells[1][0].rings).toEqual([[8,9,10]])
  })
  it('does not flatten a shallow bend outside the exported coordinate tolerance', () => {
    const p = [new Vector3(0,0,0), new Vector3(100,0,0), new Vector3(100,100,0), new Vector3(0,100,.001)]
    expect(planarMeshFaces(p, [[0,1,2], [0,2,3]])[0]).toHaveLength(2)
  })
  it('retains original facets when an edge has more than two owners', () => {
    const p = [new Vector3(0,0,0), new Vector3(1,0,0), new Vector3(0,1,0), new Vector3(0,-1,0), new Vector3(2,1,0)]
    const triangles = [[0,1,2], [1,0,3], [0,1,4]]
    expect(planarMeshFaces(p, triangles)[0].map(f => f.rings)).toEqual(triangles.map(t => [t]))
  })
})
