import * as THREE from 'three'
import { CONNECTOR_CATALOG, type ConnectorSeries } from '../src/utils/connectorCatalog'
import { connectorMeshes } from '../src/utils/connectorGeometry'

export const thumbnailTypes = CONNECTOR_CATALOG.map(({ type }) => type)
export const thumbnailSeries = [20, 30, 40] as const

/** The picker uses an orthographic projection of the complete canvas meshes. */
export function projectThumbnail(type: string, series: ConnectorSeries) {
  const view = new THREE.Vector3(4, 3, 5).normalize()
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), view).normalize()
  const up = new THREE.Vector3().crossVectors(view, right)
  const light = new THREE.Vector3(-1, 3, 5).normalize()
  const triangles: { points: number[][]; depth: number; fill: string }[] = []
  const bounds = new THREE.Box2()
  for (const part of connectorMeshes(type, series)) {
    const positions = part.geometry.getAttribute('position'), indices = part.geometry.index
    const count = indices?.count ?? positions.count
    for (let i = 0; i < count; i += 3) {
      const vertices = [0, 1, 2].map((n) => new THREE.Vector3().fromBufferAttribute(positions, indices ? indices.getX(i + n) : i + n))
      const normal = vertices[1].clone().sub(vertices[0]).cross(vertices[2].clone().sub(vertices[0])).normalize()
      if (normal.dot(view) <= 1e-6) continue
      const points = vertices.map((v) => [v.dot(right), -v.dot(up)])
      for (const point of points) bounds.expandByPoint(new THREE.Vector2(...point))
      const shade = part.dark ? .13 : .47 + Math.max(0, normal.dot(light)) * .46
      const fill = new THREE.Color('#cbd5e1').multiplyScalar(shade).getStyle()
      triangles.push({ points, depth: vertices.reduce((sum, v) => sum + v.dot(view), 0) / 3, fill })
    }
  }
  if (!triangles.length) throw new Error(`No visible geometry for ${type}:${series}`)
  const size = bounds.getSize(new THREE.Vector2()), centre = bounds.getCenter(new THREE.Vector2())
  const scale = 68 / Math.max(size.x, size.y, 1)
  return triangles.sort((a, b) => a.depth - b.depth).map((triangle) => ({
    fill: triangle.fill,
    path: `${triangle.points.map(([x, y], i) => `${i ? 'L' : 'M'}${((x - centre.x) * scale + 42).toFixed(2)},${((y - centre.y) * scale + 42).toFixed(2)}`).join('')}Z`,
  }))
}
