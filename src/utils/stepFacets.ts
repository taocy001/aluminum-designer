import { Vector3 } from 'three'

export interface PlanarMeshFace { rings: number[][]; normal: Vector3 }
const edgeKey = (a: number, b: number) => a < b ? `${a}/${b}` : `${b}/${a}`

/** Merge only adjacent coplanar facets. Keep every boundary vertex so neighbouring
 * curved faces share the same edges. Separate connected shells remain separate. */
export function planarMeshFaces(points: Vector3[], triangles: number[][]): PlanarMeshFace[][] {
  const normals = triangles.map(([a, b, c]) => points[b].clone().sub(points[a])
    .cross(points[c].clone().sub(points[a])).normalize())
  const edges = new Map<string, number[]>()
  triangles.forEach((t, i) => t.forEach((a, j) => {
    const key = edgeKey(a, t[(j + 1) % 3])
    const owners = edges.get(key)
    if (owners) owners.push(i)
    else edges.set(key, [i])
  }))
  const neighbours = triangles.map(() => new Set<number>())
  for (const owners of edges.values()) for (const a of owners) for (const b of owners) {
    if (a !== b) neighbours[a].add(b)
  }
  const visited = new Set<number>(), shells: number[][] = []
  for (let start = 0; start < triangles.length; start++) {
    if (visited.has(start)) continue
    const shell = [start]
    visited.add(start)
    for (let i = 0; i < shell.length; i++) for (const next of neighbours[shell[i]]) {
      if (!visited.has(next)) { visited.add(next); shell.push(next) }
    }
    shells.push(shell)
  }
  visited.clear()
  return shells.map(shell => {
    const faces: PlanarMeshFace[] = []
    for (const start of shell) {
      if (visited.has(start)) continue
      const normal = normals[start], at = points[triangles[start][0]]
      const group = [start]
      visited.add(start)
      for (let i = 0; i < group.length; i++) for (const next of neighbours[group[i]]) {
        if (visited.has(next) || normals[next].dot(normal) < 1 - 1e-10) continue
        // The input has already been rounded to the exported 1e-6 mm coordinate grid.
        // Use the seed plane, not a chain of progressively tilted neighbours.
        if (triangles[next].some(v => Math.abs(points[v].clone().sub(at).dot(normal)) > 2e-6)) continue
        visited.add(next)
        group.push(next)
      }
      const rings = boundaryRings(group.map(i => triangles[i]), points, normal)
      if (rings) faces.push({ rings, normal })
      else for (const i of group) faces.push({ rings: [triangles[i]], normal: normals[i] })
    }
    return faces
  })
}

function boundaryRings(triangles: number[][], points: Vector3[], normal: Vector3): number[][] | null {
  const edges = new Map<string, [number, number][]>()
  for (const t of triangles) t.forEach((a, i) => {
    const b = t[(i + 1) % 3], key = edgeKey(a, b)
    const uses = edges.get(key)
    if (uses) uses.push([a, b])
    else edges.set(key, [[a, b]])
  })
  const outgoing = new Map<number, number>(), incoming = new Set<number>()
  for (const uses of edges.values()) {
    if (uses.length === 2 && uses[0][0] === uses[1][1] && uses[0][1] === uses[1][0]) continue
    if (uses.length !== 1) return null
    const [a, b] = uses[0]
    if (outgoing.has(a) || incoming.has(b)) return null
    outgoing.set(a, b); incoming.add(b)
  }
  const rings: number[][] = []
  while (outgoing.size) {
    const first = outgoing.keys().next().value!, ring = [first]
    let current = first
    do {
      const next = outgoing.get(current)
      if (next === undefined) return null
      outgoing.delete(current)
      current = next
      if (current !== first) ring.push(current)
    } while (current !== first)
    if (ring.length < 3) return null
    rings.push(ring)
  }
  const signedArea = (ring: number[]) => {
    const at = points[ring[0]], sum = new Vector3()
    for (let i = 1; i + 1 < ring.length; i++) sum.add(points[ring[i]].clone().sub(at)
      .cross(points[ring[i + 1]].clone().sub(at)))
    return sum.dot(normal)
  }
  const areas = rings.map(signedArea)
  const outer = areas.flatMap((area, i) => area > 1e-12 ? [i] : [])
  if (outer.length !== 1 || areas.some(area => Math.abs(area) < 1e-12)) return null
  return [rings[outer[0]], ...rings.filter((_, i) => i !== outer[0])]
}
