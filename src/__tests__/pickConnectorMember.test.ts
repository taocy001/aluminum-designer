import { afterEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import desk from '../../examples/desk-with-pedestal.json'
import connectorDemo from '../../examples/connector-demo.json'
import type { ProfileData } from '../store/useStore'
import { pickConnectorMember } from '../utils/pickConnectorMember'
import { modelPointFromHit, pickPoint, toScreen } from '../utils/pickUtils'
import { connectorSeatsAt } from '../utils/bracketSeat'
import { resolveConnectorPlacement } from '../utils/connectorPlacement'
import { computeAllTrims, getThroughRule, setThroughRule } from '../utils/jointUtils'
import { getProfileShape } from '../utils/profileShapes'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
function profile(id = 'post', position: [number, number, number] = [0, 0, 0]): ProfileData {
  return { id, position, spec: '4040-B6', length: 100, quaternion: [0, 0, 0, 1], miterCuts: [], holes: [], fixedTrims: { start: 20, end: 30 } }
}

const originalThroughRule = getThroughRule()
afterEach(() => setThroughRule(originalThroughRule))

function pointerRay(at: THREE.Vector3, offset: THREE.Vector3) {
  const camera = new THREE.PerspectiveCamera(50, 4 / 3, .1, 5000)
  camera.position.copy(at).add(offset)
  camera.lookAt(at)
  camera.updateMatrixWorld()
  const ray = new THREE.Ray(camera.position.clone(), at.clone().sub(camera.position).normalize())
  const size = { width: 800, height: 600 }
  return { camera, ray, size, cursor: toScreen(at, camera, size) }
}

function demoProfilesAt(type: string, at: THREE.Vector3): ProfileData[] {
  const reference = connectorDemo.connectors.find((part) => part.type === type)!
  return (connectorDemo.profiles as unknown as ProfileData[])
    .filter((p) => p.id.startsWith(`${type}-profile-`)).map((p) => ({
      ...p, position: p.position.map((n, axis) => n - reference.position[axis] + at.getComponent(axis)) as ProfileData['position'],
    }))
}

/** The same extruded source section and trim transform as the visible Profile mesh. */
function renderedMemberHit(ray: THREE.Ray, profiles: ProfileData[]) {
  const trims = computeAllTrims(profiles)
  const material = new THREE.MeshBasicMaterial()
  const meshes = profiles.map((p) => {
    const cut = trims.get(p.id)!
    const mesh = new THREE.Mesh(new THREE.ExtrudeGeometry(getProfileShape(p.spec), { depth: 1, bevelEnabled: false }), material)
    mesh.quaternion.fromArray(p.quaternion).normalize()
    mesh.position.fromArray(p.position).addScaledVector(V(0, 0, 1).applyQuaternion(mesh.quaternion), cut.start.trim)
    mesh.scale.set(1, 1, cut.cutLength)
    mesh.userData.profileId = p.id
    mesh.updateMatrixWorld()
    return mesh
  })
  const hit = new THREE.Raycaster(ray.origin, ray.direction).intersectObjects(meshes, false)[0]
  const result = hit?.face ? {
    profileId: hit.object.userData.profileId as string, point: hit.point.clone(),
    normal: hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize(),
  } : null
  for (const mesh of meshes) mesh.geometry.dispose()
  material.dispose()
  return result
}

describe('connector member picking', () => {
  it.each([
    ['cross-bracket', [100, 80, 380], [0, 0, 1]],
    ['joining-plate', [380, 60, 80], [1, 0, 0]],
    ['t-nut', [100, 380, 100], [0, 1, 0]],
  ] as const)('installs %s through an obliquely viewed slot using its outside mounting face', (type, offset, outward) => {
    setThroughRule('rails')
    const reference = connectorDemo.connectors.find((part) => part.type === type)!
    const at = V(300, 250, 0)
    const profiles = demoProfilesAt(type, at)
    const { ray, camera, cursor, size } = pointerRay(at, new THREE.Vector3(...offset))
    const hit = pickConnectorMember(ray, profiles)!
    expect(hit).not.toBeNull()
    expect(hit.normal.distanceTo(new THREE.Vector3(...outward))).toBeLessThan(1e-6)
    const placement = resolveConnectorPlacement(type, hit.point, profiles, [], hit.normal)
    expect(placement.count).toBeGreaterThan(0)
    expect(placement.allowed).toBe(true)
    expect(placement.seat.series).toBe(reference.series)
    expect(new THREE.Vector3(...placement.seat.position).distanceTo(at)).toBeLessThan(1e-6)

    if (type !== 't-nut') {
      // Joining hits a slot wall; cross hits the recessed floor but the drawing
      // picker moves its target along the centreline by the viewing-depth offset.
      const wall = renderedMemberHit(ray, profiles)!
      expect(wall).not.toBeNull()
      if (type === 'joining-plate') expect(wall.normal.dot(hit.normal)).toBeLessThan(.9)
      const oldPick = pickPoint(ray, cursor, camera, size, profiles, wall)
      expect(resolveConnectorPlacement(type, oldPick.point, profiles, [], oldPick.normal).allowed).toBe(false)
    }
  })

  it.each(['foot', 'caster-mount'])('snaps %s to its actual bottom end from an oblique surface pick', (type) => {
    setThroughRule('rails')
    const reference = connectorDemo.connectors.find((part) => part.type === type)!
    const at = V(300, 250, 0)
    const profiles = demoProfilesAt(type, at)
    const { ray } = pointerRay(at.clone().add(V(2, 0, 2)), V(220, -260, 260))
    const hit = pickConnectorMember(ray, profiles)!
    expect(hit.normal.distanceTo(V(0, -1, 0))).toBeLessThan(1e-6)
    const placement = resolveConnectorPlacement(type, hit.point, profiles, [], hit.normal)
    expect(placement.allowed).toBe(true)
    expect(placement.seat.series).toBe(reference.series)
    expect(new THREE.Vector3(...placement.seat.position).distanceTo(at)).toBeLessThan(1e-6)
    expect(Math.abs(new THREE.Quaternion(...placement.seat.quaternion).dot(new THREE.Quaternion(...reference.quaternion as [number, number, number, number])))).toBeCloseTo(1, 6)
  })

  it('finds the desk joint when the sight line passes its hollow section edge', () => {
    const profiles = desk.profiles as unknown as ProfileData[]
    const at = V(40, 700, 560), view = V(-225, 170, 265).normalize()
    const ray = new THREE.Ray(at.clone().addScaledVector(view, 1000), view.negate())
    const hit = pickConnectorMember(ray, profiles)!
    expect(hit).not.toBeNull()
    expect(hit.point.distanceTo(at)).toBeLessThan(1e-5)
    const search = modelPointFromHit(hit, profiles, ray)!
    expect(connectorSeatsAt('inside-corner', hit.point, profiles, hit.normal, search.point)).toHaveLength(10)
  })

  it('picks the outside end through a core hole and leaves the trimmed portion empty', () => {
    const p = profile()
    const hit = pickConnectorMember(new THREE.Ray(V(10, 10, 200), V(0, 0, -1)), [p])!
    expect(hit.point.distanceTo(V(10, 10, 70))).toBeLessThan(1e-6)
    expect(hit.normal.toArray()).toEqual([0, 0, 1])
    expect(pickConnectorMember(new THREE.Ray(V(100, 0, 10), V(-1, 0, 0)), [p])).toBeNull()
  })

  it('picks the nearest member even when its core is in front of another member', () => {
    const near = profile('near', [0, 0, 100]), far = profile('far')
    const ray = new THREE.Ray(V(10, 10, 300), V(0, 0, -1))
    for (const profiles of [[near, far], [far, near]]) expect(pickConnectorMember(ray, profiles)?.profileId).toBe('near')
  })

  it('keeps end-cap placement on the visible end when a core hole looks through toward another member', () => {
    const near = { ...profile('near', [0, 0, 100]), spec: '2020' as const }, far = profile('far')
    const profiles = [near, far]
    const { ray } = pointerRay(V(0, 0, 170), V(0, 0, 300))
    const hit = pickConnectorMember(ray, profiles)!
    expect(hit.profileId).toBe('near')
    const placement = resolveConnectorPlacement('end-cap', hit.point, profiles, [], hit.normal)
    expect(placement.allowed).toBe(true)
    expect(placement.seat.profileSpec).toBe('2020')
    expect(placement.seat.position).toEqual([0, 0, 170])
  })

  it('transforms the hit and outward face with the full member rotation', () => {
    const p = profile()
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.6, 0.2))
    p.quaternion = q.toArray()
    p.position = [30, 80, 50]
    const origin = new THREE.Vector3(...p.position)
    const ray = new THREE.Ray(V(100, 0, 40).applyQuaternion(q).add(origin), V(-1, 0, 0).applyQuaternion(q))
    const hit = pickConnectorMember(ray, [p])!
    expect(hit.point.distanceTo(V(20, 0, 40).applyQuaternion(q).add(origin))).toBeLessThan(1e-6)
    expect(hit.normal.distanceTo(V(1, 0, 0).applyQuaternion(q))).toBeLessThan(1e-6)
  })

  it('uses the remaining outside surface when a section removes the front surface', () => {
    const p = profile()
    const ray = new THREE.Ray(V(100, 0, 40), V(-1, 0, 0))
    const hit = pickConnectorMember(ray, [p], undefined, (point) => point.x > 0)!
    expect(hit.point.toArray()).toEqual([-20, 0, 40])
    expect(hit.normal.toArray()).toEqual([-1, 0, 0])
    expect(pickConnectorMember(ray, [p], undefined, (point) => point.x > -30)).toBeNull()
  })
})
