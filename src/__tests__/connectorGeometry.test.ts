import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { connectorMeshes } from '../utils/connectorGeometry'
import { connectorScale } from '../utils/connectorCatalog'

describe('inner corner body', () => {
  it.each([20, 30, 40] as const)('joins both inserts through a solid heel in series %s', (series) => {
    const k = connectorScale(series)
    const parts = connectorMeshes('inside-corner', series).filter((part) => !part.dark)
    expect(parts).toHaveLength(1)
    const mesh = new THREE.Mesh(parts[0].geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
    mesh.scale.setScalar(k)
    mesh.updateMatrixWorld()
    // Section probes across both arms and their heel must pass through the matching slot width.
    for (const [x, y] of [[16, -3], [-3, 16], [2, 2], [-0.5, 2], [2, -0.5]]) {
      const hits = new THREE.Raycaster(new THREE.Vector3(x * k, y * k, 10 * k), new THREE.Vector3(0, 0, -1))
        .intersectObject(mesh)
      const depths = [...new Set(hits.map((hit) => Math.round(hit.point.z * 1e6) / 1e6))]
      expect(depths, `section at ${x},${y}`).toEqual(series === 20 ? [3, -3] : [4, -4])
    }
    // The frame-end quadrant stays empty; the bridge projects into the open inner corner.
    expect(new THREE.Raycaster(new THREE.Vector3(-k, -k, 10 * k), new THREE.Vector3(0, 0, -1))
      .intersectObject(mesh)).toEqual([])
    mesh.material.dispose()
  })

  it.each([20, 30, 40] as const)('has one connected closed boundary in series %s', (series) => {
    const geometry = connectorMeshes('inside-corner', series)[0].geometry
    const positions = geometry.getAttribute('position'), index = geometry.getIndex()
    let volume = 0
    for (let i = 0; i < (index?.count ?? positions.count); i += 3) {
      const triangle = [0, 1, 2].map((j) => new THREE.Vector3().fromBufferAttribute(positions, index ? index.getX(i + j) : i + j))
      volume += triangle[0].dot(triangle[1].cross(triangle[2])) / 6
    }
    expect(Math.abs(volume) * connectorScale(series) ** 3).toBeCloseTo({ 20: 1656, 30: 4968, 40: 6408 }[series], 2)
    const edges = new Map<string, { faces: number[]; directions: number[] }>()
    const adjacency = new Map<number, Set<number>>()
    const vertex = (i: number) => {
      const v = index ? index.getX(i) : i
      return [positions.getX(v), positions.getY(v), positions.getZ(v)].join(',')
    }
    for (let i = 0; i < (index?.count ?? positions.count); i += 3) {
      const face = i / 3, triangle = [vertex(i), vertex(i + 1), vertex(i + 2)]
      adjacency.set(face, new Set())
      for (let j = 0; j < 3; j++) {
        const a = triangle[j], b = triangle[(j + 1) % 3]
        const key = [a, b].sort().join('/')
        const edge = edges.get(key) ?? { faces: [], directions: [] }
        edge.faces.push(face); edge.directions.push(a < b ? 1 : -1); edges.set(key, edge)
      }
    }
    for (const edge of edges.values()) {
      expect(edge.directions.sort()).toEqual([-1, 1])
      const [a, b] = edge.faces
      adjacency.get(a)!.add(b); adjacency.get(b)!.add(a)
    }
    const visited = new Set<number>(), pending = [0]
    while (pending.length) {
      const face = pending.pop()!
      if (visited.has(face)) continue
      visited.add(face); pending.push(...adjacency.get(face)!)
    }
    expect(visited.size).toBe(adjacency.size)
  })
})
