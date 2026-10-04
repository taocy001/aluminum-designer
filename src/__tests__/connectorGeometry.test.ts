import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js'
import { connectorMeshes } from '../utils/connectorGeometry'
import { connectorScale } from '../utils/connectorCatalog'
import { hardwareReference, insideCornerDimensions } from '../utils/connectorHardware'
import { profileSlotDimensions } from '../utils/specUtils'

function physicalBounds(type: string, series: 20 | 30 | 40, metalOnly = false) {
  const bounds = new THREE.Box3()
  for (const part of connectorMeshes(type, series)) {
    if (metalOnly && part.dark) continue
    part.geometry.computeBoundingBox()
    bounds.union(part.geometry.boundingBox!)
  }
  bounds.min.multiplyScalar(connectorScale(series)); bounds.max.multiplyScalar(connectorScale(series))
  return bounds
}
function hits(type: string, series: 20 | 30 | 40, origin: THREE.Vector3, direction: THREE.Vector3, metalOnly = false) {
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
  const meshes = connectorMeshes(type, series).filter((p) => !metalOnly || !p.dark).map((p) => {
    const mesh = new THREE.Mesh(p.geometry, material); mesh.scale.setScalar(connectorScale(series)); mesh.updateMatrixWorld(); return mesh
  })
  const found = new THREE.Raycaster(origin, direction).intersectObjects(meshes)
  material.dispose()
  return found
}

describe('manufacturer connector geometry', () => {
  it.each([20, 30, 40] as const)('uses the dimensioned negative heel and shouldered insert in series %s', (series) => {
    const d = insideCornerDimensions(series), b = physicalBounds('inside-corner', series, true)
    expect(b.min.x).toBeCloseTo(-d.xDepth); expect(b.min.y).toBeCloseTo(-d.depth)
    expect(b.max.x).toBeCloseTo(d.xLength - d.xDepth); expect(b.max.y).toBeCloseTo(d.yLength - d.depth)
    expect(b.max.z - b.min.z).toBeCloseTo(Math.max(d.shoulderWidth, d.verticalShoulderWidth))
    // The real heel is the negative-negative corner. There is no invented positive-positive bridge.
    expect(hits('inside-corner', series, new THREE.Vector3(-d.depth / 2, -d.depth / 2, 20), new THREE.Vector3(0, 0, -1), true).length).toBeGreaterThan(0)
    expect(hits('inside-corner', series, new THREE.Vector3(1, 1, 20), new THREE.Vector3(0, 0, -1), true)).toEqual([])
    // At the exposed neck the width is smaller than the buried T shoulder.
    const neckHits = hits('inside-corner', series, new THREE.Vector3(3, -d.neckProjection / 2, 20), new THREE.Vector3(0, 0, -1), true)
    expect(neckHits[0].point.z).toBeCloseTo(d.neckWidth / 2)
    const shoulderHits = hits('inside-corner', series, new THREE.Vector3(d.shoulderStart + 2, -d.depth / 2, 20), new THREE.Vector3(0, 0, -1), true)
    expect(shoulderHits[0].point.z).toBeCloseTo(d.shoulderWidth / 2)
    // The horizontal shoulder has a real relief at the heel; it is not a continuous wide L.
    const relieved = hits('inside-corner', series, new THREE.Vector3(2, -d.depth / 2, 20), new THREE.Vector3(0, 0, -1), true)
    expect(relieved[0].point.z).toBeCloseTo(d.neckWidth / 2)
  })

  it('uses one physical inner-bracket SKU for 30 B8 and 40 I8, without stretching the casting', () => {
    expect(hardwareReference('inside-corner', 30)!.sku).toBe(hardwareReference('inside-corner', 40)!.sku)
    const a = physicalBounds('inside-corner', 30, true), b = physicalBounds('inside-corner', 40, true)
    expect(a.min.distanceTo(b.min)).toBeLessThan(1e-5); expect(a.max.distanceTo(b.max)).toBeLessThan(1e-5)
  })

  it('keeps the same casting but independently seats both screws in a mixed B8 / I8 installation', () => {
    const a = connectorMeshes('inside-corner', 30, undefined, [30, 40])
    const b = connectorMeshes('inside-corner', 30, undefined, [40, 30])
    expect(a).not.toBe(b)
    expect(a[0].geometry.getAttribute('position').array).toEqual(b[0].geometry.getAttribute('position').array)
    for (const [parts, hosts] of [[a, [30, 40]], [b, [40, 30]]] as const) {
      const dims = insideCornerDimensions(30), scale = connectorScale(30)
      for (const [i, axis, neck] of [[1, 'y', dims.neckProjection], [2, 'x', dims.verticalNeckProjection]] as const) {
        const slot = profileSlotDimensions(hosts[i - 1])
        parts[i].geometry.computeBoundingBox()
        expect(parts[i].geometry.boundingBox!.min[axis] * scale - (slot.lipDepth - neck)).toBeCloseTo(-slot.depth)
      }
    }
  })

  it.each([20, 30, 40] as const)('encloses every actual casting vertex without filling its open corner in series %s', (series) => {
    for (const type of ['inside-corner', 'bracket', 'gusset', 'corner-3way']) for (const mesh of connectorMeshes(type, series)) {
      const pieces = mesh.collisionParts ?? (mesh.collisionVertices ? [{ vertices: mesh.collisionVertices }] : mesh.collisionBoxes!)
      const includes = pieces.map((piece) => {
        if ('vertices' in piece) {
          const hull = new ConvexHull().setFromPoints(piece.vertices.map((v) => new THREE.Vector3(...v)))
          hull.tolerance = 1e-4
          return (p: THREE.Vector3) => hull.containsPoint(p)
        }
        const box = new THREE.Box3(new THREE.Vector3(...piece.centre).sub(new THREE.Vector3(...piece.half)),
          new THREE.Vector3(...piece.centre).add(new THREE.Vector3(...piece.half))).expandByScalar(1e-4)
        return (p: THREE.Vector3) => box.containsPoint(p)
      })
      const positions = mesh.geometry.getAttribute('position'), point = new THREE.Vector3()
      for (let i = 0; i < positions.count; i++) {
        point.fromBufferAttribute(positions, i)
        expect(includes.some((contains) => contains(point)), `${type}:${series} vertex ${point.toArray()}`).toBe(true)
      }
    }
  })

  it.each([20, 30, 40] as const)('has two real screw holes and the documented screw length in series %s', (series) => {
    const d = insideCornerDimensions(series), slot = profileSlotDimensions(series)
    expect(hits('inside-corner', series, new THREE.Vector3(d.xScrew, 5, 0), new THREE.Vector3(0, -1, 0), true)).toEqual([])
    expect(hits('inside-corner', series, new THREE.Vector3(5, d.yScrew, 0), new THREE.Vector3(-1, 0, 0), true)).toEqual([])
    const screws = connectorMeshes('inside-corner', series).filter((p) => p.dark)
    expect(screws).toHaveLength(2)
    screws[0].geometry.computeBoundingBox()
    const b = screws[0].geometry.boundingBox!.clone(), k = connectorScale(series)
    expect((b.max.y - b.min.y) * k).toBeCloseTo(series === 20 ? 6 : 8)
    expect(b.min.y * k - (slot.lipDepth - d.neckProjection)).toBeCloseTo(-slot.depth)
    expect(hardwareReference('inside-corner', series)!.fasteners.some((f) => f.kind === 't-nut')).toBe(false)
  })

  it.each([[20, 18, 18], [30, 27, 28], [40, 36, 38]] as const)('retains the manufacturer CAD envelope and open middle of bracket %s', (series, length, width) => {
    const b = physicalBounds('bracket', series)
    expect(b.max.x).toBeCloseTo(length); expect(b.max.y).toBeCloseTo(length)
    expect(b.max.z - b.min.z).toBeCloseTo(width)
    expect(b.min.x).toBeLessThan(0); expect(b.min.y).toBeLessThan(0)
    expect(connectorMeshes('bracket', series)[0].collisionParts).toHaveLength(8)
    // This passes through the open mouth between the two thin side webs.
    const start = new THREE.Vector3(length * 0.4, length * 0.4, 0)
    expect(hits('bracket', series, start, new THREE.Vector3(1, 1, 0).normalize())).toEqual([])
    expect(hardwareReference('bracket', series)!.verified).toBe(true)
  })

  it('keeps unknown gusset and three-way series at the referenced actual size and unverified', () => {
    for (const type of ['gusset', 'corner-3way']) {
      expect(hardwareReference(type, 40)!.verified).toBe(true)
      for (const series of [20, 30] as const) {
        expect(hardwareReference(type, series)!.verified).toBe(false)
        const a = physicalBounds(type, series), b = physicalBounds(type, 40)
        expect(a.min.distanceTo(b.min)).toBeLessThan(1e-5); expect(a.max.distanceTo(b.max)).toBeLessThan(1e-5)
      }
    }
    expect(hardwareReference('corner-3way', 40)!.mounting).toBe('end-tapped')
    expect(hardwareReference('gusset', 40)!.mounting).toBe('slot-face')
  })
})
