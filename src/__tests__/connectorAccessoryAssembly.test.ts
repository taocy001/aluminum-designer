import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { connectorMeshes } from '../utils/connectorGeometry'
import { connectorScale } from '../utils/connectorCatalog'
import { accessoryCapReference } from '../utils/connectorAccessoryReferences'
import { connectorHitsBody } from '../utils/connectorCollision'
import { makeOBB } from '../utils/obb'
import cap2020 from '../assets/connectorCad/motedis-cap-2020.json'

describe('physical accessory assemblies', () => {
  it('uses four unchanged B6 caps, with all four pins centred and retention tabs facing outwards', () => {
    const parts = connectorMeshes('end-cap', 20, '4040-B6')
    expect(parts).toHaveLength(4)
    const centres = [[-10, -10], [-10, 10], [10, -10], [10, 10]]
    for (const [i, mesh] of parts.entries()) {
      const [x, y] = centres[i], sign = x < 0 ? 1 : -1
      const positions = mesh.geometry.getAttribute('position')
      expect(positions.count * 3).toBe(cap2020.positions.length)
      for (let n = 0; n < positions.count; n++) {
        expect(positions.getX(n)).toBeCloseTo(sign * cap2020.positions[3 * n] + x, 4)
        expect(positions.getY(n)).toBeCloseTo(sign * cap2020.positions[3 * n + 1] + y, 4)
        expect(positions.getZ(n)).toBeCloseTo(cap2020.positions[3 * n + 2], 4)
      }
      const cover = mesh.collisionParts!.filter((part) => !part.pressFit)
      expect(cover).toEqual([{ centre: [x, y, 1.25], half: [10, 10, 1.25], pressFit: false }])
      expect(mesh.collisionParts!.filter((part) => part.pressFit)).toHaveLength(cap2020.collisionParts.length - 1)
      const retention = mesh.collisionParts![1]
      expect('centre' in retention && Math.abs(retention.centre[0])).toBeCloseTo(18.6, 6)
    }
    expect(accessoryCapReference('4040-B6')).toMatchObject({ sku: 'Motedis PTS6B20x20 ×4', verified: true, supportedSeries: [20] })
  })

  it('keeps every cap cover subject to normal obstacle clearance', () => {
    const cap = { id: 'cap', type: 'end-cap', series: 20 as const, profileSpec: '4040-B6' as const,
      position: [0, 0, 0] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number] }
    for (const x of [-10, 10]) for (const y of [-10, 10]) {
      const obstruction = makeOBB(new THREE.Vector3(x, y, 2.4), new THREE.Vector3(1, 1, .2), new THREE.Quaternion())
      expect(connectorHitsBody(cap, obstruction, .15, false)).toBe(true)
    }
  })

  it.each([30, 40] as const)('preserves the D75 caster and bolt dimensions for series %s', (series) => {
    const parts = connectorMeshes('caster-mount', series), scale = connectorScale(series)
    const bounds = (index: number) => {
      const g = parts[index].geometry
      g.computeBoundingBox()
      return g.boundingBox!.clone().applyMatrix4(new THREE.Matrix4().makeScale(scale, scale, scale))
    }
    const screw = bounds(0), wheel = bounds(parts.length - 1)
    expect(screw.max.y).toBeCloseTo(8.3609, 3)
    expect(screw.max.y - screw.min.y).toBeCloseTo(25, 3)
    expect(Math.abs(wheel.min.y + 99.7)).toBeLessThan(.03)
    const size = wheel.getSize(new THREE.Vector3())
    expect(Math.abs(size.x - 75)).toBeLessThan(.03)
    expect(Math.abs(size.y - 75)).toBeLessThan(.03)
    // The tire is 25 mm wide; the original CAD's central hub protrudes to 26.3 mm.
    expect(size.z).toBeCloseTo(26.3, 3)
    expect(Math.abs(wheel.getCenter(new THREE.Vector3()).x - 29.943856)).toBeLessThan(.03)
    const fork = parts[1], points = fork.geometry.getAttribute('position')
    // No visible fork metal may escape its segmented collision boxes.
    for (let i = 0; i < points.count; i++) {
      const p = [points.getX(i), points.getY(i), points.getZ(i)]
      expect(fork.collisionBoxes!.some((b) => p.every((n, axis) => Math.abs(n - b.centre[axis]) <= b.half[axis] + 2e-5))).toBe(true)
    }
  })
})
