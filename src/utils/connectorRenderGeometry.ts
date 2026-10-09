import * as THREE from 'three'
import type { ConnectorMesh } from './connectorSolidPrimitives'

type RenderMesh = Pick<ConnectorMesh, 'geometry' | 'dark' | 'polished' | 'previewDepthWrite'>
const cache = new WeakMap<readonly ConnectorMesh[], readonly RenderMesh[]>()

/** Batch equal materials within one connector. CAD solids and collision shapes stay separate. */
export function connectorRenderMeshes(parts: readonly ConnectorMesh[]): readonly RenderMesh[] {
  const cached = cache.get(parts)
  if (cached) return cached
  const groups = new Map<string, ConnectorMesh[]>()
  for (const part of parts) {
    const key = `${!!part.dark}:${!!part.polished}:${!!part.previewDepthWrite}`
    const group = groups.get(key) ?? []
    group.push(part)
    groups.set(key, group)
  }
  const result = [...groups.values()].map(group => {
    const { dark, polished, previewDepthWrite } = group[0]
    if (group.length === 1) return { geometry: group[0].geometry, dark, polished, previewDepthWrite }
    const vertexCount = group.reduce((n, p) => n + p.geometry.getAttribute('position').count, 0)
    const indexCount = group.reduce((n, p) => n + (p.geometry.index?.count ?? p.geometry.getAttribute('position').count), 0)
    const positions = new Float32Array(vertexCount * 3), normals = new Float32Array(vertexCount * 3)
    const indices = new Uint32Array(indexCount)
    let vertexOffset = 0, indexOffset = 0
    for (const { geometry } of group) {
      const position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal')
      for (let i = 0; i < position.count; i++) {
        const offset = (vertexOffset + i) * 3
        positions[offset] = position.getX(i); positions[offset + 1] = position.getY(i); positions[offset + 2] = position.getZ(i)
        normals[offset] = normal.getX(i); normals[offset + 1] = normal.getY(i); normals[offset + 2] = normal.getZ(i)
      }
      const count = geometry.index?.count ?? position.count
      for (let i = 0; i < count; i++) indices[indexOffset++] = vertexOffset + (geometry.index?.getX(i) ?? i)
      vertexOffset += position.count
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
    geometry.setIndex(new THREE.BufferAttribute(indices, 1))
    return { geometry, dark, polished, previewDepthWrite }
  })
  cache.set(parts, result)
  return result
}
