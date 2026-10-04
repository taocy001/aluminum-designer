import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { ConnectorData } from '../store/useStore'
import { connectorSeatAt } from '../utils/bracketSeat'
import { connectorOBB } from '../utils/analysis'
import { connectorHitsBody } from '../utils/connectorCollision'
import { connectorMeshes, connectorSolidTop } from '../utils/connectorGeometry'
import { buildProfile } from '../utils/profileFactory'
import { makeOBB } from '../utils/obb'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const Q = new THREE.Quaternion()
const part = (type: string): ConnectorData => ({ id: type, type, position: [0, 0, 0], quaternion: [0, 0, 0, 1], series: 20 })

describe('modeled connector collision bodies', () => {
  it.each(['flat-plate', 'joining-plate', 'end-cap', 'cross-bracket', 'hinge', 'pivot', 'caster-mount', 'foot', 't-nut'])(
    'keeps all visible physical %s vertices within the broad-phase envelope', (type) => {
      const envelope = connectorOBB(part(type))
      for (const mesh of connectorMeshes(type).filter((m) => !m.dark)) {
        const positions = mesh.geometry.getAttribute('position')
        for (let i = 0; i < positions.count; i++) {
          const point = V(positions.getX(i), positions.getY(i), positions.getZ(i)).sub(envelope.center)
          for (let j = 0; j < 3; j++) expect(Math.abs(point.dot(envelope.axes[j])))
            .toBeLessThanOrEqual(envelope.half.getComponent(j) + 1e-6)
        }
      }
    },
  )

  it('checks the cross arms without filling the empty quadrants', () => {
    expect(connectorHitsBody(part('cross-bracket'), makeOBB(V(20, 20, 0), V(3, 3, 3), Q), 1, false)).toBe(false)
    expect(connectorHitsBody(part('cross-bracket'), makeOBB(V(22, 0, 0), V(3, 3, 3), Q), 1, false)).toBe(true)
    expect(connectorHitsBody(part('hinge'), makeOBB(V(10, 0, 0), V(2, 2, 2), Q), 1, false)).toBe(false)
    expect(connectorHitsBody(part('foot'), makeOBB(V(12, 12, 0), V(2, 2, 2), Q), 1, false)).toBe(false)
    expect(connectorHitsBody(part('foot'), makeOBB(V(0, 25, 0), V(3, 3, 3), Q), 1, false)).toBe(true)
  })

  it('exempts a nut insert only on its aligned slot and preserves its exposed bolt', () => {
    const nut = part('t-nut'), profile = makeOBB(V(0, -10, 0), V(10, 10, 100), Q)
    expect(connectorHitsBody(nut, profile)).toBe(false)
    expect(connectorHitsBody(nut, profile, 1, false)).toBe(true)
    expect(connectorHitsBody({ ...nut, position: [4, 0, 0] }, profile)).toBe(true)
    expect(connectorHitsBody({ ...nut, quaternion: new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), Math.PI / 2).toArray() }, profile)).toBe(true)
    expect(connectorHitsBody(nut, makeOBB(V(0, 6, 0), V(5, 4, 5), Q))).toBe(true)
    expect(connectorHitsBody(nut, makeOBB(V(5, -10, 0), V(10, 10, 100), Q))).toBe(true)
  })

  it('refreshes cached solids after in-place pose, series and type edits', () => {
    const connector = part('cross-bracket'), body = makeOBB(V(22, 0, 0), V(3, 3, 3), Q)
    const check = () => {
      const fresh = { ...connector, position: [...connector.position], quaternion: [...connector.quaternion] } as ConnectorData
      const collision = connectorHitsBody(connector, body, 1, false)
      expect(collision).toBe(connectorHitsBody(fresh, body, 1, false))
      return collision
    }
    expect(check()).toBe(true)
    connector.position[0] = 100
    expect(check()).toBe(false)
    connector.position[0] = 0
    expect(check()).toBe(true)
    const rotation = new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), Math.PI / 4).toArray()
    rotation.forEach((value, i) => { connector.quaternion[i] = value })
    expect(check()).toBe(false)
    connector.series = 40
    check()
    connector.type = 'foot'
    check()
  })

  it('preserves contact tolerance under rigid transforms while detecting deeper intersections', () => {
    for (let i = 0; i < 9; i++) {
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(i * 0.19, i * 0.31, i * 0.43))
      const translation = V(i * 17, -i * 31, i * 10.2)
      const connector: ConnectorData = { ...part('joining-plate'), position: translation.toArray(), quaternion: rotation.toArray() }
      const body = makeOBB(V(-10, 0, 0).applyQuaternion(rotation).add(translation), V(10, 10, 100), rotation)
      expect(connectorHitsBody(connector, body, 3)).toBe(false)
      connector.position = V(-0.01, 0, 0).applyQuaternion(rotation).add(translation).toArray()
      expect(connectorHitsBody(connector, body, 3)).toBe(true)
    }
  })

  it.each(['2020', '3030', '4040'] as const)('seats foot and caster mounting tops at the %s post end', (spec) => {
    const post = buildProfile(V(0, 0, 0), V(0, 600, 0), spec)!
    for (const type of ['foot', 'caster-mount']) {
      const seat = connectorSeatAt(type, V(0, 0, 0), [post])
      expect(connectorSolidTop({ id: type, type, ...seat })).toBeCloseTo(0, 6)
    }
  })
})
