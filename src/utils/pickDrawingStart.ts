import * as THREE from 'three'
import type { ProfileData } from '../store/useStore'
import { getProfileDir } from './geometryCore'
import { createTrimResolver } from './jointUtils'
import { profileBodyEndpoints, profileFace, type ProfileFace, type ProfileFaceRef } from './profileFaces'
import { pickPoint, referenceFaceFromHit, toScreen, type MeshHit, type PickResult, type ScreenSize } from './pickUtils'
import { roundToGrid } from './specUtils'

export interface DrawingStartPick extends PickResult {
  /** A second plane: an end cap or the supporting member's side at a real T joint. */
  alignmentFace?: ProfileFaceRef
}

const EDGE_PX = 12
const EDGE_MM = 20
const PLANE_TOL = 0.5
const FACE_EPS = 0.001

function distanceToEdge(cursor: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2): number {
  const edge = b.clone().sub(a)
  const t = edge.lengthSq() > 1e-9 ? THREE.MathUtils.clamp(cursor.clone().sub(a).dot(edge) / edge.lengthSq(), 0, 1) : 0
  return cursor.distanceTo(a.clone().addScaledVector(edge, t))
}

function interval(face: ProfileFace, axis: THREE.Vector3): [number, number] {
  const coordinates = face.corners.map((point) => new THREE.Vector3(...point).dot(axis))
  return [Math.min(...coordinates), Math.max(...coordinates)]
}

type TrimResolver = ReturnType<typeof createTrimResolver>
interface TInterface {
  target: ProfileData
  sideFace: ProfileFace
  cap: ProfileFace
  lo: number
  hi: number
  bottom: number
  top: number
}

const axisHorizontal = (dir: THREE.Vector3) => Math.abs(dir.y) <= 1e-6
  && Math.max(Math.abs(dir.x), Math.abs(dir.z)) >= 1 - 1e-6

/** Real, finite cap-to-side contacts, shared by direct top picks and seam recovery. */
function tInterfaces(target: ProfileData, others: ProfileData[], resolveTrims: TrimResolver): TInterface[] {
  const dir = getProfileDir(target)
  if (!axisHorizontal(dir)) return []
  const up = new THREE.Vector3(0, 1, 0)
  const sides = ([0, 1] as const).flatMap((axis) => ([-1, 1] as const)
    .map((side) => profileFace(target, { profileId: target.id, axis, side }, resolveTrims(target))))
    .filter((face) => Math.abs(face.normal[1]) <= 1e-6)
  const contacts: TInterface[] = []
  for (const other of others) {
    if (other.id === target.id) continue
    const otherDir = getProfileDir(other)
    if (!axisHorizontal(otherDir) || Math.abs(otherDir.dot(dir)) > 1e-6) continue
    for (const capSide of [-1, 1] as const) {
      const cap = profileFace(other, { profileId: other.id, axis: 2, side: capSide }, resolveTrims(other))
      const capNormal = new THREE.Vector3(...cap.normal)
      // Interval overlap is exact for these rectangular, axis-aligned sections.
      // Do not turn a rolled cap's bounding rectangle into a false contact edge.
      const capEdges = [1, 3].map((i) => new THREE.Vector3(...cap.corners[i]).sub(new THREE.Vector3(...cap.corners[0])).normalize())
      if (capEdges.some((edge) => Math.max(Math.abs(edge.dot(dir)), Math.abs(edge.y)) < 1 - 1e-6)) continue
      for (const sideFace of sides) {
        const normal = new THREE.Vector3(...sideFace.normal)
        if (normal.dot(capNormal) > -1 + 1e-6) continue
        if (Math.abs(new THREE.Vector3(...cap.center).sub(new THREE.Vector3(...sideFace.center)).dot(normal)) > FACE_EPS) continue
        const [capLo, capHi] = interval(cap, dir), [sideLo, sideHi] = interval(sideFace, dir)
        const lo = Math.max(capLo, sideLo), hi = Math.min(capHi, sideHi)
        const [capBottom, capTop] = interval(cap, up), [sideBottom, sideTop] = interval(sideFace, up)
        const bottom = Math.max(capBottom, sideBottom), top = Math.min(capTop, sideTop)
        if (hi - lo <= FACE_EPS || top - bottom <= FACE_EPS) continue
        contacts.push({ target, sideFace, cap, lo, hi, bottom, top })
      }
    }
  }
  return contacts
}

function capInterfaces(target: ProfileData, side: -1 | 1, profiles: ProfileData[], resolveTrims: TrimResolver): TInterface[] {
  return profiles.filter((profile) => profile.id !== target.id)
    .flatMap((profile) => tInterfaces(profile, [target], resolveTrims))
    .filter((contact) => contact.cap.side === side)
}

function withinContact(contact: TInterface, point: THREE.Vector3): boolean {
  const along = point.dot(getProfileDir(contact.target))
  return along >= contact.lo - FACE_EPS && along <= contact.hi + FACE_EPS
    && point.y >= contact.bottom - FACE_EPS && point.y <= contact.top + FACE_EPS
}

interface Candidate {
  point: THREE.Vector3
  face: ProfileFaceRef
  alignmentFace: ProfileFaceRef
  px: number
  mm: number
}

function surfaceInterfaceCandidate(
  contact: TInterface, surface: ProfileFace, hit: MeshHit, cursor: THREE.Vector2,
  camera: THREE.Camera, size: ScreenSize, resolveTrims: TrimResolver,
): Candidate | null {
  // A shorter neighbouring rail cannot invent an interface on this top/bottom.
  if (surface.center[1] < contact.bottom - FACE_EPS || surface.center[1] > contact.top + FACE_EPS) return null
  const dir = getProfileDir(contact.target)
  const a = new THREE.Vector3(...contact.sideFace.center)
  a.addScaledVector(dir, contact.lo - a.dot(dir)); a.y = surface.center[1]
  const b = a.clone().addScaledVector(dir, contact.hi - contact.lo)
  const center = (contact.lo + contact.hi) / 2
  const ends = profileBodyEndpoints(contact.target, resolveTrims(contact.target))
  const point = ends.start.clone().addScaledVector(dir, center - ends.start.dot(dir))
  const anchor = point.clone(); anchor.y = surface.center[1]
  // The joint center is also an intentional target, especially on wider rails.
  // A hit inside a top slot must not make its depth count as missing that surface.
  const onSurface = hit.point.clone(); onSurface.y = surface.center[1]
  const nearest = new THREE.Line3(a, b).closestPointToPoint(onSurface, true, new THREE.Vector3())
  const mm = Math.max(Math.min(onSurface.distanceTo(nearest), onSurface.distanceTo(anchor)),
    Math.abs(onSurface.dot(dir) - center))
  if (mm > EDGE_MM) return null
  const px = Math.min(distanceToEdge(cursor, toScreen(a, camera, size), toScreen(b, camera, size)),
    cursor.distanceTo(toScreen(anchor, camera, size)))
  if (px > EDGE_PX) return null
  return { point, face: { profileId: surface.profileId, axis: surface.axis, side: surface.side },
    alignmentFace: { profileId: contact.sideFace.profileId, axis: contact.sideFace.axis, side: contact.sideFace.side }, px, mm }
}

/**
 * First-click edge placement has two independent references: the horizontal surface
 * receiving the new end and the physical cap its outer side should align with. Keep
 * this separate from ordinary endpoint picking, which also serves connectors and
 * second-click corner joints and deliberately uses the construction centreline.
 */
export function pickDrawingStart(
  ray: THREE.Ray, cursor: THREE.Vector2, camera: THREE.Camera, size: ScreenSize, profiles: ProfileData[],
  meshHit?: MeshHit | null, planeY = 0, previousFace?: ProfileFaceRef | null,
): DrawingStartPick {
  const fallback = () => pickPoint(ray, cursor, camera, size, profiles, meshHit, planeY, previousFace)
  const target = meshHit && profiles.find((profile) => profile.id === meshHit.profileId)
  if (!target || !meshHit) return fallback()
  const dir = getProfileDir(target)
  // Drawing remains world-axis constrained. A vertical member cannot put one of its
  // side faces flush against an oblique cap without changing its section rotation.
  if (!axisHorizontal(dir)) return fallback()

  // A groove wall can face sideways while belonging to the top. Classify its owning
  // outer face before checking its world normal, and retain the actual triangle normal.
  const face = referenceFaceFromHit(target, meshHit)
  const resolveTrims = createTrimResolver(profiles)
  const trims = resolveTrims(target)
  const surface = profileFace(target, face, trims)
  const ends = profileBodyEndpoints(target, trims)
  if (planeY !== 0 && Math.abs(ends.start.y - planeY) > PLANE_TOL) return fallback()

  let best: Candidate | null = null
  const consider = (candidate: Candidate) => {
    if (!best || candidate.px < best.px - 1e-6
      || (Math.abs(candidate.px - best.px) <= 1e-6 && candidate.mm < best.mm)) best = candidate
  }
  if (face.axis !== 2 && Math.abs(surface.normal[1]) > 1 - 1e-6) {
    for (const [point, side] of [[ends.start, -1], [ends.end, 1]] as const) {
      const mm = Math.abs(meshHit.point.clone().sub(point).dot(dir))
      if (mm > EDGE_MM) continue
      const edge = surface.corners.map((corner) => new THREE.Vector3(...corner))
        .filter((corner) => Math.abs(corner.clone().sub(point).dot(dir)) < 0.001)
      if (edge.length !== 2) continue
      const px = distanceToEdge(cursor, toScreen(edge[0], camera, size), toScreen(edge[1], camera, size))
      if (px > EDGE_PX) continue
      consider({ point, face, alignmentFace: { profileId: target.id, axis: 2, side }, px, mm })
    }
    for (const contact of tInterfaces(target, profiles, resolveTrims)) {
      const candidate = surfaceInterfaceCandidate(contact, surface, meshHit, cursor, camera, size, resolveTrims)
      if (candidate) consider(candidate)
    }
    if (!best) {
      const ordinary = fallback()
      const capTarget = ordinary.face?.axis === 2 && profiles.find((profile) => profile.id === ordinary.face!.profileId)
      const covered = capTarget && capInterfaces(capTarget, ordinary.face!.side, profiles, resolveTrims)
        .some((contact) => (contact.target.id === target.id || contact.cap.profileId === target.id)
          && surface.center[1] >= contact.bottom - FACE_EPS && surface.center[1] <= contact.top + FACE_EPS
          && withinContact(contact, new THREE.Vector3(...contact.cap.center)))
      if (covered) {
        // The broad legacy endpoint target can win after the real top hit misses
        // the narrower edge bounds. An occupied cap is not a usable starting face:
        // retain the surface actually hit without pretending its edge was snapped.
        const origin = new THREE.Vector3(...target.position)
        const along = THREE.MathUtils.clamp(roundToGrid(meshHit.point.clone().sub(origin).dot(dir)),
          ends.start.clone().sub(origin).dot(dir), ends.end.clone().sub(origin).dot(dir))
        return { point: origin.addScaledVector(dir, along), kind: 'segment', profileId: target.id,
          normal: meshHit.normal.clone(), face }
      }
      return ordinary
    }
  } else {
    // At an exact seam a ray can enter a groove and hit the occupied cap or side
    // below the upper surface. Recover only that finite contact, never a free cap
    // or an exposed part of a partially covered cap, and only toward a nearby face
    // facing this ray. The same interfaces and pixel bounds govern ordinary picks.
    const contacts = face.axis === 2
      ? capInterfaces(target, face.side, profiles, resolveTrims)
      : tInterfaces(target, profiles, resolveTrims)
        .filter((contact) => contact.sideFace.axis === face.axis && contact.sideFace.side === face.side)
    for (const contact of contacts) {
      if (!withinContact(contact, meshHit.point)) continue
      if (planeY !== 0 && Math.abs(contact.target.position[1] - planeY) > PLANE_TOL) continue
      const surfaces = ([0, 1] as const).flatMap((axis) => ([-1, 1] as const)
        .map((side) => profileFace(contact.target, { profileId: contact.target.id, axis, side }, resolveTrims(contact.target))))
      for (const outer of surfaces) {
        if (Math.abs(outer.normal[1]) < 1 - 1e-6 || new THREE.Vector3(...outer.normal).dot(ray.direction) >= -1e-6) continue
        if (Math.abs(outer.center[1] - meshHit.point.y) > EDGE_MM + FACE_EPS) continue
        const candidate = surfaceInterfaceCandidate(contact, outer, meshHit, cursor, camera, size, resolveTrims)
        if (candidate) consider(candidate)
      }
    }
  }
  if (!best) return fallback()
  const chosen = best as Candidate
  return {
    point: chosen.point.clone(), kind: 'endpoint', profileId: chosen.face.profileId, normal: meshHit.normal.clone(), face: chosen.face,
    alignmentFace: chosen.alignmentFace,
  }
}
