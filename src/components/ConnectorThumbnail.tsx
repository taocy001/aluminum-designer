import React, { useMemo } from 'react'
import * as THREE from 'three'
import { connectorMeshes } from '../utils/connectorGeometry'
import type { ConnectorSeries } from '../utils/connectorCatalog'

/** Orthographic view of the same mesh parts used on the canvas. */
function project(type: string, series: ConnectorSeries) {
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
      const shade = part.dark ? 0.13 : 0.47 + Math.max(0, normal.dot(light)) * 0.46
      const fill = new THREE.Color('#cbd5e1').multiplyScalar(shade).getStyle()
      triangles.push({ points, depth: vertices.reduce((sum, v) => sum + v.dot(view), 0) / 3, fill })
    }
  }
  const size = bounds.getSize(new THREE.Vector2()), centre = bounds.getCenter(new THREE.Vector2())
  const scale = 68 / Math.max(size.x, size.y, 1)
  return triangles.sort((a, b) => a.depth - b.depth).map((triangle) => ({
    fill: triangle.fill,
    path: `${triangle.points.map(([x, y], i) => `${i ? 'L' : 'M'}${((x - centre.x) * scale + 42).toFixed(2)},${((y - centre.y) * scale + 42).toFixed(2)}`).join('')}Z`,
  }))
}

const images = new Map<string, string>()
function thumbnail(type: string, series: ConnectorSeries): string {
  const key = `${type}:${series}`
  if (!images.has(key)) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 168
    const context = canvas.getContext('2d')!
    context.scale(2, 2)
    context.lineWidth = .3
    context.lineJoin = 'round'
    for (const { path, fill } of project(type, series)) {
      context.fillStyle = context.strokeStyle = fill
      const triangle = new Path2D(path)
      context.fill(triangle)
      context.stroke(triangle)
    }
    images.set(key, canvas.toDataURL())
  }
  return images.get(key)!
}

const ConnectorThumbnail: React.FC<{ type: string; series?: ConnectorSeries }> = ({ type, series = 20 }) => {
  const source = useMemo(() => thumbnail(type, series), [type, series])
  return <img src={source} alt="" aria-hidden="true" data-connector-model={type}
    className="h-full w-full drop-shadow-md" draggable={false} />
}

export default React.memo(ConnectorThumbnail)
