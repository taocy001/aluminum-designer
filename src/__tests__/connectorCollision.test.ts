import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { ConnectorData } from '../store/useStore'
import { connectorSeatAt } from '../utils/bracketSeat'
import { connectorOBB } from '../utils/analysis'
import { connectorHitsBody } from '../utils/connectorCollision'
import { connectorMeshes, connectorSolidTop } from '../utils/connectorGeometry'
import { buildProfile } from '../utils/profileFactory'
import { makeOBB, obbCorners, type OBB } from '../utils/obb'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const Q = new THREE.Quaternion()
const part = (type: string): ConnectorData => ({ id: type, type, position: [0, 0, 0], quaternion: [0, 0, 0, 1], series: 20 })

function vertexOverlap(a: OBB, b: OBB, tolerance: number): boolean {
  const av = obbCorners(a), bv = obbCorners(b)
  const axes = [...a.axes, ...b.axes,
    ...a.axes.flatMap((u) => b.axes.map((v) => u.clone().cross(v)).filter((axis) => axis.lengthSq() > 1e-8))]
  return axes.every((axis) => {
    const ap = av.map((point) => point.dot(axis)), bp = bv.map((point) => point.dot(axis))
    return Math.min(Math.max(...ap) - Math.min(...bp), Math.max(...bp) - Math.min(...ap)) > (tolerance + 1e-8) * axis.length()
  })
}

describe('modeled connector collision bodies', () => {
  it('matches vertex SAT for rotated boxes, containment and contact at each tolerance', () => {
    let seed = 48271
    const random = () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 0x100000000 }
    for (let i = 0; i < 180; i++) {
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(random() * 6, random() * 6, random() * 6))
      const position = V(random() * 1000, random() * 1000, random() * 1000)
      const series = ([20, 30, 40] as const)[i % 3], scale = series / 20
      const c: ConnectorData = { ...part('cross-bracket'), series, position: position.toArray(), quaternion: rotation.toArray() }
      const reference = [V(24, 2, 2), V(2, 24, 2)].map((half) => makeOBB(position, half.multiplyScalar(scale), rotation))
      const body = i % 5 === 0 ? makeOBB(position.clone(), V(60, 60, 60), rotation)
        : i % 5 === 1 ? makeOBB(position.clone(), V(1, 1, 1), rotation)
          : i % 5 === 2 ? makeOBB(V(24 * scale + 2, 0, 0).applyQuaternion(rotation).add(position), V(2, 2, 2), rotation)
            : makeOBB(V(random() * 70 - 35, random() * 70 - 35, random() * 20 - 10).applyQuaternion(rotation).add(position),
              V(random() * 8 + 1, random() * 8 + 1, random() * 8 + 1),
              rotation.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(random(), random(), i % 2 ? 0.00001 : random()))))
      for (const tolerance of [0, 1, 3]) expect(connectorHitsBody(c, body, tolerance, false))
        .toBe(reference.some((box) => vertexOverlap(box, body, tolerance)))
    }
  })

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

  it.each([20, 30, 40] as const)('fits the %s inside corner arms within the mounting slot', (series) => {
    const q = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), Math.PI / 2)
    const alongX = makeOBB(V(0, -series / 2, 0), V(series / 2, series / 2, 100), q)
    const c: ConnectorData = { ...part('inside-corner'), series, position: [0, 0, series === 40 ? 10 : 0] }
    expect(connectorHitsBody(c, alongX)).toBe(false)
    const alongY = makeOBB(V(-series / 2, 0, 0), V(series / 2, series / 2, 100),
      new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), -Math.PI / 2))
    expect(connectorHitsBody(c, alongY)).toBe(false)
    expect(connectorHitsBody(c, alongX, 1, false)).toBe(true)
    // Even a submillimetre intrusion into a slot wall or floor is real metal overlap.
    expect(connectorHitsBody({ ...c, position: [0, -0.2, c.position[2]] }, alongX)).toBe(true)
    expect(connectorHitsBody({ ...c, position: [0, 0, c.position[2] + 0.2] }, alongX)).toBe(true)
  })

  it('uses both 2040 slots and the same cavity under rigid transforms', () => {
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(V(0, 1, 0), V(0, 0, 1), V(1, 0, 0)))
    for (const z of [-10, 10]) for (let i = 0; i < 5; i++) {
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(i * 0.19, i * 0.31, i * 0.43))
      const shift = V(i * 17, -i * 31, i * 10.2)
      const host = makeOBB(V(0, -10, 0).applyQuaternion(rotation).add(shift), V(10, 20, 100), rotation.clone().multiply(q))
      const c: ConnectorData = { ...part('inside-corner'), position: V(0, 0, z).applyQuaternion(rotation).add(shift).toArray(),
        quaternion: rotation.toArray() }
      expect(connectorHitsBody(c, host)).toBe(false)
    }
  })

  it('checks the exposed root and rejects unrelated metal while leaving the negative quadrant empty', () => {
    const c = part('inside-corner')
    expect(connectorHitsBody(c, makeOBB(V(3, 3, 0), V(2, 2, 2), Q), 1, false)).toBe(true)
    expect(connectorHitsBody(c, makeOBB(V(-3, -3, 0), V(2, 2, 2), Q), 0, false)).toBe(false)
    expect(connectorHitsBody(c, makeOBB(V(3, 3, 0), V(2, 2, 2), Q), 1)).toBe(true)
    const alongX = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), Math.PI / 2)
    expect(connectorHitsBody(c, makeOBB(V(0, -10, 0), V(10, 10, 10), alongX))).toBe(true)
    expect(connectorHitsBody(c, makeOBB(V(10, -10, 0), V(10, 10, 10), Q))).toBe(true)
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

  it('refreshes cached slot walls after in-place member and connector edits', () => {
    const c = part('inside-corner'), q = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), Math.PI / 2)
    const body = makeOBB(V(0, -10, 0), V(10, 10, 100), q)
    const check = (expected: boolean) => {
      const freshBody = { center: body.center.clone(), half: body.half.clone(), axes: body.axes.map((axis) => axis.clone()) as typeof body.axes }
      const freshPart = { ...c, position: [...c.position], quaternion: [...c.quaternion] } as ConnectorData
      expect(connectorHitsBody(c, body)).toBe(expected)
      expect(connectorHitsBody(c, body)).toBe(connectorHitsBody(freshPart, freshBody))
    }
    check(false)
    body.center.y = -9.8
    check(true)
    body.center.y = -10
    check(false)
    body.half.y = 10.2
    check(true)
    body.half.y = 10
    body.half.z = 10
    check(true)
    body.half.z = 100
    body.half.x = 20
    check(true)
    body.half.x = 10
    check(false)
    const originalAxes = body.axes.map((axis) => axis.clone())
    body.axes.forEach((axis) => axis.applyQuaternion(q))
    check(true)
    body.axes.forEach((axis, index) => axis.copy(originalAxes[index]))
    check(false)
    c.position[2] = 0.2
    check(true)
    c.position[2] = 0
    check(false)
    c.series = 30
    check(true)
    c.series = 20
    check(false)
    c.quaternion = q.toArray()
    check(true)
    c.quaternion = [0, 0, 0, 1]
    check(false)
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

  it('keeps cached normals independent of replaced member axes', () => {
    const c = part('inside-corner'), alongX = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), Math.PI / 2)
    for (const body of [makeOBB(V(0, -9.8, 0), V(10, 10, 100), alongX), makeOBB(V(3, 3, 0), V(2, 2, 2), Q)]) {
      expect(connectorHitsBody(c, body)).toBe(true)
      const detached = body.axes
      body.axes = detached.map((axis) => axis.clone()) as typeof body.axes
      detached.forEach((axis) => axis.set(0, 0, 0))
      expect(connectorHitsBody(c, body)).toBe(true)
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
