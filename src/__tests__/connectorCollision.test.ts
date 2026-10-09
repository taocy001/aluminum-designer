import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { ConnectorData } from '../store/useStore'
import { connectorOBB } from '../utils/analysis'
import { connectorHitsBody, connectorsCollide } from '../utils/connectorCollision'
import { connectorMeshes, connectorSolidTop } from '../utils/connectorGeometry'
import { connectorScale } from '../utils/connectorCatalog'
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
  it('keeps support height exact through translations, rotations and different series', () => {
    for (const series of [20, 30, 40] as const) {
      for (let turn = 0; turn < 36; turn++) {
        const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(turn / 10, .23, -.41))
        const c: ConnectorData = { ...part('inside-corner'), series, quaternion: quaternion.toArray() }
        let expected = -Infinity
        for (const { geometry } of connectorMeshes(c.type, series)) {
          const vertices = geometry.getAttribute('position')
          for (let i = 0; i < vertices.count; i++) {
            const world = new THREE.Vector3().fromBufferAttribute(vertices, i).multiplyScalar(connectorScale(series)).applyQuaternion(quaternion)
            expected = Math.max(expected, world.y)
          }
        }
        expect(connectorSolidTop(c)).toBeCloseTo(expected, 8)
        expect(connectorSolidTop({ ...c, position: [30, 170, -90] })).toBeCloseTo(expected + 170, 8)
      }
    }
  })

  it('refreshes pair bounds after movement, rotation and panel fastener edits', () => {
    const a = part('flat-plate'), b = { ...part('flat-plate'), id: 'other' }
    expect(connectorsCollide(a, b)).toBe(true)
    b.position[0] = 1000
    expect(connectorsCollide(a, b)).toBe(false)
    b.position[0] = 0
    expect(connectorsCollide(a, b)).toBe(true)
    a.type = 't-nut'
    a.panelMount = { panelId: 'board', profileId: 'rail', spacer: 0, boardThickness: 18, mode: 'direct' }
    const check = () => {
      for (let y = -20; y <= 60; y += 5) {
        b.position[1] = y
        const fresh = structuredClone(a)
        expect(connectorsCollide(a, b)).toBe(connectorsCollide(fresh, structuredClone(b)))
        const body = makeOBB(V(0, y, 0), V(3, 3, 3), Q)
        expect(connectorHitsBody(a, body, 1, false, 'board'))
          .toBe(connectorHitsBody(fresh, body, 1, false, 'board'))
      }
    }
    check()
    a.panelMount.boardThickness = 30; check()
    a.panelMount.panelId = 'other-board'; check()
    a.panelMount.profileId = 'other-rail'; check()
    delete a.panelMount.mode
    a.type = 'joining-plate'; a.panelMount.spacer = 10; check()
    a.series = 30; check()
    a.quaternion = new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), Math.PI / 2).toArray(); check()
    delete a.panelMount; check()
  })

  it('matches vertex SAT for rotated boxes, containment and contact at each tolerance', () => {
    let seed = 48271
    const random = () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 0x100000000 }
    for (let i = 0; i < 180; i++) {
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(random() * 6, random() * 6, random() * 6))
      const position = V(random() * 1000, random() * 1000, random() * 1000)
      const series = ([20, 30, 40] as const)[i % 3]
      const thickness = series === 40 ? 6 : 4, width = series === 20 ? 18 : series === 30 ? 27 : 39.8
      const c: ConnectorData = { ...part('flat-plate'), series, position: position.toArray(), quaternion: rotation.toArray() }
      const centre = V(0, thickness / 2, 0).applyQuaternion(rotation).add(position)
      const reference = makeOBB(centre, V(2 * series, thickness / 2, width / 2), rotation)
      const body = i % 5 === 0 ? makeOBB(position.clone(), V(60, 60, 60), rotation)
        : i % 5 === 1 ? makeOBB(position.clone(), V(1, 1, 1), rotation)
          : i % 5 === 2 ? makeOBB(V(2 * series + 2, thickness / 2, 0).applyQuaternion(rotation).add(position), V(2, 2, 2), rotation)
            : makeOBB(V(random() * 70 - 35, random() * 70 - 35, random() * 20 - 10).applyQuaternion(rotation).add(position),
              V(random() * 8 + 1, random() * 8 + 1, random() * 8 + 1),
              rotation.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(random(), random(), i % 2 ? 0.00001 : random()))))
      for (const tolerance of [0, 1, 3]) expect(connectorHitsBody(c, body, tolerance, false))
        .toBe(vertexOverlap(reference, body, tolerance))
    }
  })

  it.each(['flat-plate', 'joining-plate', 'end-cap', 'cross-bracket', 'hinge', 'pivot', 'caster-mount', 'foot', 't-nut'])(
    'keeps all visible physical %s vertices within the broad-phase envelope', (type) => {
      const envelope = connectorOBB(part(type))
      let maximumOverflow = -Infinity
      for (const mesh of connectorMeshes(type).filter((m) => !m.visualOnly)) {
        const positions = mesh.geometry.getAttribute('position')
        for (let i = 0; i < positions.count; i++) {
          const point = V(positions.getX(i), positions.getY(i), positions.getZ(i)).sub(envelope.center)
          for (let j = 0; j < 3; j++) maximumOverflow = Math.max(maximumOverflow,
            Math.abs(point.dot(envelope.axes[j])) - envelope.half.getComponent(j))
        }
      }
      expect(maximumOverflow).toBeLessThanOrEqual(1e-6)
    },
  )

  it('keeps the cross plate clipped corners and the gaps around the foot clear', () => {
    expect(connectorHitsBody(part('cross-bracket'), makeOBB(V(60, 40, 2), V(1, 1, 1), Q), 0, false)).toBe(false)
    expect(connectorHitsBody(part('cross-bracket'), makeOBB(V(60, 0, 2), V(1, 1, 1), Q), 0, false)).toBe(true)
    expect(connectorHitsBody(part('foot'), makeOBB(V(12, 12, 0), V(2, 2, 2), Q), 0, false)).toBe(false)
    expect(connectorHitsBody(part('foot'), makeOBB(V(0, 5, 0), V(1, 1, 1), Q), 0, false)).toBe(true)
  })

  it('checks the loose nut body without an invented attached bolt', () => {
    const nut = part('t-nut')
    expect(connectorHitsBody(nut, makeOBB(V(4, -3, 0), V(.5, .5, 1), Q), 0, false)).toBe(true)
    expect(connectorHitsBody(nut, makeOBB(V(0, 6, 0), V(2, 2, 2), Q), 0, false)).toBe(false)
    const wrongSlot = makeOBB(V(5, -10, 0), V(10, 10, 100), Q)
    expect(connectorHitsBody(nut, wrongSlot)).toBe(true)
  })

  it.each([[20, .5, .6], [30, 1.2, .7], [40, 3.5, 3]] as const)(
    'fits series %s shoulders behind the real slot lips at a clear cut end', (series, insetX, insetY) => {
    const alongX = makeOBB(V(50, -series / 2, 0), V(series / 2, series / 2, 50),
      new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), Math.PI / 2))
    const c: ConnectorData = { ...part('inside-corner'), series, position: [-insetX, -insetY, 0] }
    expect(connectorHitsBody(c, alongX)).toBe(false)
    const alongY = makeOBB(V(-series / 2, 50, 0), V(series / 2, series / 2, 50),
      new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), -Math.PI / 2))
    expect(connectorHitsBody(c, alongY)).toBe(false)
    expect(connectorHitsBody(c, alongX, .15, false)).toBe(true)
    expect(connectorHitsBody({ ...c, position: [-insetX, -insetY - 1, 0] }, alongX)).toBe(true)
    expect(connectorHitsBody({ ...c, position: [-insetX, -insetY, 2] }, alongX)).toBe(true)
    // Extending this member behind the cut end traps the other insert arm in metal.
    alongX.center.x = 0
    expect(connectorHitsBody(c, alongX)).toBe(true)
  })

  it('uses both 2040 slots and preserves the physical cavity under rigid transforms', () => {
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(V(0, 1, 0), V(0, 0, 1), V(1, 0, 0)))
    for (const z of [-10, 10]) for (let i = 0; i < 5; i++) {
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(i * .19, i * .31, i * .43))
      const shift = V(i * 17, -i * 31, i * 10.2)
      const host = makeOBB(V(50, -10, 0).applyQuaternion(rotation).add(shift), V(10, 20, 50), rotation.clone().multiply(q))
      const c: ConnectorData = { ...part('inside-corner'), position: V(-.6, -.6, z).applyQuaternion(rotation).add(shift).toArray(),
        quaternion: rotation.toArray() }
      expect(connectorHitsBody(c, host)).toBe(false)
      c.position = V(-.6, -.6, 0).applyQuaternion(rotation).add(shift).toArray()
      expect(connectorHitsBody(c, host)).toBe(true)
    }
  })

  it('checks the real negative heel and leaves the open positive quadrant clear', () => {
    const c = part('inside-corner')
    expect(connectorHitsBody(c, makeOBB(V(-2, -2, 0), V(1, 1, 1), Q), 0, false)).toBe(true)
    expect(connectorHitsBody(c, makeOBB(V(3, 3, 0), V(1, 1, 1), Q), 0, false)).toBe(false)
    // Unrelated metal still blocks the heel and either arm.
    for (const centre of [V(-2, -2, 0), V(8, -2, 0), V(-2, 8, 0)])
      expect(connectorHitsBody(c, makeOBB(centre, V(1, 1, 1), Q))).toBe(true)
  })

  it('refreshes cached solids after in-place pose, series and type edits', () => {
    const connector = part('flat-plate'), body = makeOBB(V(35, 2, 0), V(2, 2, 2), Q)
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

  it('refreshes cached profile metal after in-place member and connector edits', () => {
    const c: ConnectorData = { ...part('inside-corner'), position: [-.6, -.6, 0] }
    const q = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), Math.PI / 2)
    const body = makeOBB(V(50, -10, 0), V(10, 10, 50), q)
    const check = (expected?: boolean) => {
      const freshBody = { center: body.center.clone(), half: body.half.clone(), axes: body.axes.map((axis) => axis.clone()) as typeof body.axes }
      const freshPart = { ...c, position: [...c.position], quaternion: [...c.quaternion] } as ConnectorData
      const actual = connectorHitsBody(c, body)
      if (expected !== undefined) expect(actual).toBe(expected)
      expect(actual).toBe(connectorHitsBody(freshPart, freshBody))
    }
    check(false)
    body.center.y += 1; check(true)
    body.center.y -= 1; check(false)
    body.half.y += 1; check(true)
    body.half.y -= 1; check(false)
    body.half.z = 100; check(true)
    body.half.z = 50; check(false)
    body.half.x = 20; check()
    body.half.x = 10; check(false)
    const originalAxes = body.axes.map((axis) => axis.clone())
    body.axes.forEach((axis) => axis.applyQuaternion(q)); check()
    body.axes.forEach((axis, index) => axis.copy(originalAxes[index])); check(false)
    c.position[2] = 2; check(true)
    c.position[2] = 0; check(false)
    c.series = 30; check(true)
    c.series = 20; check(false)
    c.quaternion = q.toArray(); check()
    c.quaternion = [0, 0, 0, 1]; check(false)
  })

  it('preserves contact tolerance under rigid transforms while detecting deeper intersections', () => {
    for (let i = 0; i < 9; i++) {
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(i * 0.19, i * 0.31, i * 0.43))
      const translation = V(i * 17, -i * 31, i * 10.2)
      const connector: ConnectorData = { ...part('joining-plate'), position: V(-3, 0, 0).applyQuaternion(rotation).add(translation).toArray(), quaternion: rotation.toArray() }
      const body = makeOBB(V(-10, 0, 0).applyQuaternion(rotation).add(translation), V(10, 10, 100), rotation)
      expect(connectorHitsBody(connector, body, 3, false)).toBe(false)
      connector.position = V(-3.01, 0, 0).applyQuaternion(rotation).add(translation).toArray()
      expect(connectorHitsBody(connector, body, 3, false)).toBe(true)
    }
  })

  it('keeps cached body hits specific to clearance, material mode and every body pose', () => {
    const plate = part('flat-plate'), block = makeOBB(V(35, 2, 0), V(2, 2, 2), Q)
    for (const tolerance of [0, 5, 0, 5]) {
      expect(connectorHitsBody(plate, block, tolerance, false)).toBe(tolerance === 0)
    }
    const c: ConnectorData = { ...part('inside-corner'), position: [-.6, -.6, 0] }
    const host = makeOBB(V(50, -10, 0), V(10, 10, 50), new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), Math.PI / 2))
    for (const metal of [true, false, true, false]) expect(connectorHitsBody(c, host, .15, metal)).toBe(!metal)
    // Repeated poses can hit the bounded result cache even when callers rebuild OBBs.
    for (const offset of [0, 1, 0, 1]) {
      const freshHost = { center: host.center.clone().add(V(0, offset, 0)), half: host.half.clone(), axes: host.axes.map((a) => a.clone()) as typeof host.axes }
      expect(connectorHitsBody(c, freshHost)).toBe(offset === 1)
    }
  })

  it('keeps cached normals independent of replaced member axes', () => {
    const c = part('flat-plate')
    for (const body of [makeOBB(V(0, 2, 0), V(10, 10, 100), Q), makeOBB(V(30, 2, 0), V(2, 2, 2), Q)]) {
      expect(connectorHitsBody(c, body)).toBe(true)
      const detached = body.axes
      body.axes = detached.map((axis) => axis.clone()) as typeof body.axes
      detached.forEach((axis) => axis.set(0, 0, 0))
      expect(connectorHitsBody(c, body)).toBe(true)
    }
  })

  it('includes the actual foot and caster screw insertion above their mounting faces', () => {
    expect(connectorSolidTop({ ...part('foot'), series: 40 })).toBeCloseTo(10, 4)
    expect(connectorSolidTop(part('caster-mount'))).toBeCloseTo(8.3609, 4)
    const post = makeOBB(V(0, 100, 0), V(20, 20, 100), new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), -Math.PI / 2))
    const foot: ConnectorData = { ...part('foot'), series: 40 }
    expect(connectorHitsBody(foot, post)).toBe(false)
    expect(connectorHitsBody({ ...foot, position: [6, 0, 0] }, post)).toBe(true)
    expect(connectorHitsBody(foot, post, .15, false)).toBe(true)
  })
})
