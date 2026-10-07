import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { ConnectorData, ProfileSpec } from '../store/useStore'
import { buildProfile } from '../utils/profileFactory'
import { parseProjectDocument, serializeProjectDocument } from '../utils/document'
import { decodeShare, encodeShareLink } from '../utils/shareLink'
import { specDims, slotOffsets } from '../utils/specUtils'
import { seriesOf } from '../utils/connectorCatalog'
import { connectorHitsBody } from '../utils/connectorCollision'
import { validateConnectorPlacement } from '../utils/connectorPlacement'
import { connectorSeatAt } from '../utils/bracketSeat'
import { trimmedOBB } from '../utils/analysis'
import { computeAllTrims } from '../utils/jointUtils'
import { buildBom } from '../utils/bom'
import { connectorMeshes } from '../utils/connectorGeometry'
import { hardwareReference } from '../utils/connectorHardware'
import { sectionProps, massPerMetre } from '../utils/deflection'
import { getProfileShape } from '../utils/profileShapes'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const post = (spec: ProfileSpec = '4040-B6') => buildProfile(V(0, 0, 0), V(0, 180, 0), spec, 'post')!
const foot = (): ConnectorData => ({ id: 'foot', type: 'foot', series: 20, profileSpec: '4040-B6', position: [0, 0, 0], quaternion: [0, 0, 0, 1] })
const bodyOf = (p: ReturnType<typeof post>) => trimmedOBB(p, computeAllTrims([p]).get(p.id)!)

describe('4040 B6 section and accessories', () => {
  it('preserves the actual family through file and share round trips', async () => {
    const doc = parseProjectDocument({ profiles: [post()], connectors: [foot()], panels: [], fittings: [], throughRule: 'posts' })
    expect(parseProjectDocument(serializeProjectDocument(doc))).toEqual(doc)
    const link = await encodeShareLink(doc, 'https://example.com/')
    const shared = await decodeShare(new URL(link).hash.slice(3))
    expect(shared.profiles[0].spec).toBe('4040-B6')
    expect(shared.connectors[0].profileSpec).toBe('4040-B6')
    expect(specDims(shared.profiles[0].spec)).toEqual({ w: 40, h: 40, hw: 20, hh: 20 })
    expect(seriesOf(shared.profiles[0].spec)).toBe(20)
    expect(slotOffsets(40, seriesOf(shared.profiles[0].spec))).toEqual([-10, 10])
  })

  it('uses the sourced section including four cores and the central void', () => {
    const { shape, holes } = getProfileShape('4040-B6').extractPoints(12)
    expect(holes).toHaveLength(5)
    const area = Math.abs(THREE.ShapeUtils.area(shape)) - holes.reduce((sum, h) => sum + Math.abs(THREE.ShapeUtils.area(h)), 0)
    expect(Math.abs(area - 461.8499278731) / area).toBeLessThan(.004)
    expect(sectionProps('4040-B6')).toEqual({ area: 461.85, strong: 80986.67, weak: 80986.67 })
    expect(massPerMetre('4040-B6')).toBeCloseTo(1.246995)
  })

  it('attaches the foot through four tapped cores with a separate adapter', () => {
    const p = post(), c = foot()
    expect(validateConnectorPlacement(c, [p], []).allowed).toBe(true)
    expect(connectorHitsBody(c, bodyOf(p), .15, false)).toBe(true)
    expect(connectorHitsBody({ ...c, position: [2, 0, 0] }, bodyOf(p))).toBe(true)
    expect(validateConnectorPlacement({ ...c, quaternion: new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), Math.PI / 4).toArray() }, [p], []).allowed).toBe(false)
    expect(validateConnectorPlacement({ ...c, position: [0, 180, 0] }, [p], []).allowed).toBe(false)
    expect(validateConnectorPlacement(c, [post('4040')], []).allowed).toBe(false)
    expect(validateConnectorPlacement({ ...c, series: 40, profileSpec: '4040' }, [p], []).allowed).toBe(false)
    const seat = connectorSeatAt('foot', V(3, -2, 3), [p])
    expect(seat).toMatchObject({ seated: true, series: 20, profileSpec: '4040-B6', position: [0, 0, 0] })
    expect(validateConnectorPlacement({ ...c, ...seat }, [p], []).allowed).toBe(true)
  })

  it('keeps B6 and I8 metal distinct when reusing or rebuilding equal-sized bodies', () => {
    const p = post(), body = bodyOf(p), c = foot()
    for (const spec of ['4040-B6', '4040', '4040-B6', '4040'] as const) {
      body.profileSpec = spec
      expect(connectorHitsBody(c, body)).toBe(spec === '4040')
      expect(connectorHitsBody(c, bodyOf(post(spec)))).toBe(spec === '4040')
    }
  })

  it('aligns all four mounting screws with a rotated host end', () => {
    const p = post(), rotation = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), Math.PI / 7)
    p.quaternion = rotation.clone().multiply(new THREE.Quaternion(...p.quaternion)).toArray()
    const seat = connectorSeatAt('foot', V(0, -1, 0), [p])
    expect(seat.seated).toBe(true)
    expect(validateConnectorPlacement({ ...foot(), ...seat }, [p], []).allowed).toBe(true)
    expect(validateConnectorPlacement(foot(), [p], []).allowed).toBe(false)
  })

  it('lists one machined plate and four M6 screws per foot, without reclassifying legacy feet', () => {
    const result = buildBom([], [foot()], new Map(), 'en')
    expect(result.connectors[0].spec).toContain('AP-4040B6-M8')
    expect(result.fasteners).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: expect.stringContaining('M6×20 DIN 7991'), qty: 4 }),
      expect.objectContaining({ label: expect.stringContaining('40×40×8'), qty: 1 }),
      expect.objectContaining({ label: expect.stringContaining('M8 nut'), qty: 1 }),
    ]))
    const legacy = { ...foot(), profileSpec: undefined }
    expect(hardwareReference('foot', 20)?.verified).toBe(false)
    expect(validateConnectorPlacement(legacy, [post()], []).allowed).toBe(false)
    const old = buildBom([], [legacy], new Map(), 'en')
    expect(old.connectors[0].spec).not.toContain('AP-4040B6-M8')
    expect(old.fasteners).toEqual([])
  })

  it('preserves the M6 hex drives and the installed height in the exported geometry', () => {
    const meshes = connectorMeshes('foot', 20, '4040-B6')
    const bounds = new THREE.Box3()
    for (const part of meshes) {
      part.geometry.computeBoundingBox()
      bounds.union(part.geometry.boundingBox!)
    }
    expect(bounds.min.y).toBeCloseTo(-76.24, 3)
    expect(bounds.max.y).toBeCloseTo(12.1, 3)
    const mesh = new THREE.Mesh(meshes[0].geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
    mesh.updateMatrixWorld()
    const hits = new THREE.Raycaster(V(-10, -9, -10), V(0, 1, 0)).intersectObject(mesh)
    expect(hits[0].point.y).toBeCloseTo(-5.6, 3)
    const rim = new THREE.Raycaster(V(-5, -9, -10), V(0, 1, 0)).intersectObject(mesh)
    expect(rim[0].point.y).toBeCloseTo(-7.9, 3)
    mesh.material.dispose()
  })
})
