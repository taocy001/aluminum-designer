import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js'
import type { ConnectorData, ProfileSpec } from '../store/useStore'
import { buildProfile } from '../utils/profileFactory'
import { connectorPlacementCandidates, validateConnectorPlacement } from '../utils/connectorPlacement'
import { connectorSeatAt } from '../utils/bracketSeat'
import { nonCornerSupports } from '../utils/connectorMounting'
import { hardwareReference } from '../utils/connectorHardware'
import { computeAllTrims, setThroughRule } from '../utils/jointUtils'
import { connectorHitsBody } from '../utils/connectorCollision'
import { trimmedOBB } from '../utils/analysis'
import { specDims, slotOffsets } from '../utils/specUtils'
import { seriesOf } from '../utils/connectorCatalog'
import { connectorMeshes } from '../utils/connectorGeometry'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const P = (id: string, a: [number, number, number], b: [number, number, number]) => buildProfile(V(...a), V(...b), '4040-B6', id)!
const C = (type: string, position: [number, number, number] = [0, 0, 0]): ConnectorData => ({ id: type, type, series: 20, position, quaternion: [0, 0, 0, 1] })

describe('verified B6 hardware on the 4040 double-slot section', () => {
  it.each(['inside-corner', 'bracket', 't-bracket'])('finds usable %s seats on both slot lines', (type) => {
    setThroughRule('rails')
    const frame = [P('rail', [-100, 100, 0], [150, 100, 0]), P('post', [0, 100, 0], [0, 250, 0])]
    const choices = connectorPlacementCandidates(type, V(0, 100, 0), frame, [])
    const usable = choices.filter((c) => c.allowed)
    expect(usable).toHaveLength(4)
    const slotAxis = type === 't-bracket' ? 0 : 2
    expect(new Set(usable.map(({ seat }) => Math.round(seat.position[slotAxis])))).toEqual(new Set([-10, 10]))
  })

  it.each(['flat-plate', 'joining-plate', 'hinge', 'pivot', 't-nut'])('seats %s on B6 slot lines and rejects the face centre', (type) => {
    const frame = type === 'flat-plate' ? [P('a', [-100, -20, -10], [0, -20, -10]), P('b', [0, -20, -10], [100, -20, -10])]
      : type === 'joining-plate' ? [P('a', [-20, -10, -100], [-20, -10, 0]), P('b', [-20, -10, 0], [-20, -10, 100])]
        : type === 'hinge' ? [P('a', [-20, -20.5, -100], [-20, -20.5, 100]), P('b', [-20, 20.5, -100], [-20, 20.5, 100])]
          : type === 'pivot' ? [P('a', [-100, -20, -10], [100, -20, -10])]
            : [P('a', [-10, -20, -100], [-10, -20, 100])]
    const part = C(type)
    expect(nonCornerSupports(part, frame), type).not.toBeNull()
    expect(validateConnectorPlacement(part, frame, []), type).toEqual({ allowed: true, occupied: false })
    const normal = V(type === 'joining-plate' || type === 'hinge' ? 1 : 0, type === 'joining-plate' || type === 'hinge' ? 0 : 1, 0)
    const snapped = connectorSeatAt(type, V(0, 0, 0).addScaledVector(normal, 2), frame, normal)
    expect(snapped.seated, type).toBe(true)
    expect(validateConnectorPlacement({ ...part, ...snapped }, frame, []), type).toEqual({ allowed: true, occupied: false })
    const wrong = type === 't-nut' ? [10, 0, 0] : type === 'joining-plate' || type === 'hinge' ? [0, 10, 0] : [0, 0, 10]
    expect(nonCornerSupports({ ...part, position: wrong as [number, number, number] }, frame), type).toBeNull()
  })

  it('retains verified hardware families instead of sizing I8 fittings to B6', () => {
    for (const type of ['gusset', 'corner-3way', 'cross-bracket']) expect(hardwareReference(type, 20)?.verified).toBe(false)
  })
})

describe('factory slot hardware across profile sections', () => {
  it.each([['bracket', 20], ['t-nut', 20], ['t-nut', 30], ['t-nut', 40]] as const)('%s %s collision pieces enclose complete CAD faces', (type, series) => {
    for (const mesh of connectorMeshes(type, series)) {
      const pieces = mesh.collisionParts ?? mesh.collisionBoxes!
      const contains = pieces.map((piece) => {
        if ('vertices' in piece) {
          const hull = new ConvexHull().setFromPoints(piece.vertices.map((v) => V(...v)))
          hull.tolerance = 3e-5
          return (v: THREE.Vector3) => hull.containsPoint(v)
        }
        const box = new THREE.Box3(V(...piece.centre).sub(V(...piece.half)), V(...piece.centre).add(V(...piece.half))).expandByScalar(3e-5)
        return (v: THREE.Vector3) => box.containsPoint(v)
      })
      const positions = mesh.geometry.getAttribute('position'), index = mesh.geometry.getIndex(), missing: number[][] = []
      for (let i = 0; i < (index?.count ?? positions.count); i += 3) {
        const p = [0, 1, 2].map((j) => new THREE.Vector3().fromBufferAttribute(positions, index ? index.getX(i + j) : i + j))
        // A triangle can cross two pieces even when each original vertex is covered.
        const samples = [...p, ...p.map((v, j) => v.clone().add(p[(j + 1) % 3]).multiplyScalar(.5)), p[0].clone().add(p[1]).add(p[2]).multiplyScalar(1 / 3)]
        for (const v of samples) if (!contains.some((test) => test(v)) && missing.length < 10) missing.push(v.toArray())
      }
      expect(missing).toEqual([])
    }
  })

  it.each<ProfileSpec>(['2020', '2040', '3030', '4040', '4040-B6'])('%s retains valid angles and nuts while rejecting displaced nuts', (spec) => {
    setThroughRule('rails')
    const make = (id: string, a: [number, number, number], b: [number, number, number]) => buildProfile(V(...a), V(...b), spec, id)!
    const frame = [make('rail', [-100, 100, 0], [150, 100, 0]), make('post', [0, 100, 0], [0, 250, 0])]
    // Both 2040 members expose their 40 mm faces at the perpendicular joint.
    if (spec === '2040') frame[0].quaternion = [.5, .5, .5, .5]
    const angles = connectorPlacementCandidates('bracket', V(0, 100, 0), frame, []).filter((c) => c.allowed)
    expect(angles).toHaveLength(spec === '2040' || spec === '4040-B6' ? 4 : 2)
    const d = specDims(spec), series = seriesOf(spec)
    for (const slot of slotOffsets(d.w, series)) {
      const host = make('nut-host', [-slot, -d.h / 2, -100], [-slot, -d.h / 2, 100])
      const nut: ConnectorData = { ...C('t-nut'), series }
      expect(validateConnectorPlacement(nut, [host], []).allowed).toBe(true)
      const body = trimmedOBB(host, computeAllTrims([host]).get(host.id)!)
      expect(connectorHitsBody({ ...nut, position: [2, 0, 0] }, body)).toBe(true)
      expect(connectorHitsBody({ ...nut, position: [0, -2, 0] }, body)).toBe(true)
    }
  })
})
