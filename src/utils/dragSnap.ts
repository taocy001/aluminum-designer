import * as THREE from 'three'
import type { ProfileData } from '../store/useStore'
import { getProfileDir, getProfileEndpoints, round3 } from './geometryCore'
import { specDims } from './specUtils'
import { createTrimResolver, type ProfileTrims } from './jointUtils'
import { toScreen, type ScreenSize } from './pickUtils'

export type Axis3 = 0 | 1 | 2

/** World-space box of a member as it is modelled (before joint trimming) */
export function memberBox(p: ProfileData, position: [number, number, number] = p.position): THREE.Box3 {
  const quat = new THREE.Quaternion(...p.quaternion).normalize()
  const dir = getProfileDir(p)
  const { hw, hh } = specDims(p.spec)
  const lx = new THREE.Vector3(1, 0, 0).applyQuaternion(quat).multiplyScalar(hw)
  const ly = new THREE.Vector3(0, 1, 0).applyQuaternion(quat).multiplyScalar(hh)
  const start = new THREE.Vector3(...position)
  const end = start.clone().addScaledVector(dir, p.length)
  const box = new THREE.Box3()
  for (const c of [start, end]) {
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      box.expandByPoint(c.clone().addScaledVector(lx, sx).addScaledVector(ly, sy))
    }
  }
  return box
}

/** Never pull from further than this, however far the camera is zoomed out (mm) */
export const ALIGN_MAX_MM = 60
/** The pull reaches at least this far on screen, so it feels the same at any zoom */
export const ALIGN_PX = 18

/** Alignment threshold combines profile width with a screen-space distance. */
export function alignThreshold(profiles: ProfileData[], screenWorld = 0): number {
  let t = 20
  for (const p of profiles) {
    const { w, h } = specDims(p.spec)
    t = Math.max(t, Math.max(w, h))
  }
  return Math.min(ALIGN_MAX_MM, Math.max(t, screenWorld))
}

export type AlignKind = 'face' | 'edge' | 'center' | 'end' | 'align'

export interface SnapGuide {
  axis: Axis3
  kind: AlignKind | 'endpoint'
  /** the coordinate both parts share on that axis, for drawing the alignment line */
  coord: number
  refId: string
  /** Actual member contributing this face, including when a group is moving. */
  movingId?: string
  /** Low/high world-axis face; independent of the member's drawing direction. */
  movingSide?: -1 | 1
  refSide?: -1 | 1
}

export interface SnapResult {
  /** correction to add to the proposed positions, per world axis */
  offset: THREE.Vector3
  /** members the snap locked onto, for highlighting */
  refIds: string[]
  /** which axes actually snapped */
  axes: Axis3[]
  /** what engaged, for the alignment lines and the HUD */
  guides: SnapGuide[]
}

const AXIS_KEYS = ['x', 'y', 'z'] as const

/** Nearby parallel rails may share end planes without touching sideways. */
const REFERENCE_REACH_MM = 250
const END_PREFERENCE_MM = 4
/** Deliberate centering is still available, but a vague near-center pull must not steal an end. */
const CENTER_INTENT_MM = 0.5
const HOLD_MARGIN_MM = 4
const FACE_EPS = 0.001

const axisOf = (p: ProfileData): Axis3 | null => {
  const d = getProfileDir(p)
  const i = AXIS_KEYS.findIndex((key) => Math.abs(d[key]) > 1 - 1e-7)
  return i < 0 ? null : i as Axis3
}

/** An AABB extreme of an oblique or rolled section is not necessarily an actual face. */
function hasAxisFace(p: ProfileData, axis: Axis3): boolean {
  const q = new THREE.Quaternion(...p.quaternion).normalize()
  const key = AXIS_KEYS[axis]
  return [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]
    .some((normal) => Math.abs(normal.applyQuaternion(q)[key]) > 1 - 1e-7)
}

function transverseGap(a: THREE.Box3, b: THREE.Box3, axis: Axis3): number {
  let gap = 0
  for (let i = 0; i < 3; i++) {
    if (i === axis) continue
    const key = AXIS_KEYS[i]
    gap = Math.max(gap, a.min[key] - b.max[key], b.min[key] - a.max[key])
  }
  return gap
}

/** The same cut/extension and minimum visible length as Profile's rendered mesh. */
function renderedBox(p: ProfileData, trims: ProfileTrims): THREE.Box3 {
  const start = new THREE.Vector3(...p.position).addScaledVector(getProfileDir(p), trims.start.trim)
  const length = Number.isFinite(trims.cutLength) && trims.cutLength > 0.1 ? trims.cutLength : 1
  return memberBox({ ...p, position: start.toArray() as [number, number, number], length })
}

/** All boxes in this lookup share one immutable placement and joint calculation. */
function renderedBoxes(scene: ProfileData[]): (p: ProfileData) => THREE.Box3 {
  let resolve: ReturnType<typeof createTrimResolver> | null = null
  const boxes = new Map<ProfileData, THREE.Box3>()
  return (p) => {
    let box = boxes.get(p)
    if (!box) {
      resolve ??= createTrimResolver(scene)
      box = renderedBox(p, resolve(p))
      boxes.set(p, box)
    }
    return box
  }
}

const sideCoord = (box: THREE.Box3, key: 'x' | 'y' | 'z', side: -1 | 1) => side < 0 ? box.min[key] : box.max[key]
const sameGuide = (a: SnapGuide, b: SnapGuide) => a.axis === b.axis && a.kind === b.kind
  && a.refId === b.refId && a.movingId === b.movingId && a.movingSide === b.movingSide && a.refSide === b.refSide

/** Endpoint joins obey the same locked-axis constraint as the drag itself. */
export function snapProfilePosition(
  p: ProfileData, newStart: THREE.Vector3, others: ProfileData[],
  camera: THREE.Camera, size: ScreenSize, lockedAxis: Axis3 | null = null,
  allowedAxes: readonly Axis3[] = lockedAxis === null ? [0, 1, 2] : [lockedAxis],
): { position: THREE.Vector3; refId: string | null } {
  const tight = lockedAxis !== null
  const maxMm = tight ? 12 : 60, minMm = tight ? 2 : 6, maxPx = tight ? 10 : 24
  const { start, end } = getProfileEndpoints({ ...p, position: newStart.toArray() as [number, number, number] })
  const offset = end.clone().sub(start)
  const dir = getProfileDir(p)
  let best: THREE.Vector3 | null = null, bestRef: string | null = null, bestPx = maxPx
  for (const other of others) {
    if (Math.abs(getProfileDir(other).dot(dir)) > 0.99) continue
    const ends = getProfileEndpoints(other)
    for (const ep of [ends.start, ends.end]) {
      const epPx = toScreen(ep, camera, size)
      for (const [corner, candidate] of [[start, ep], [end, ep.clone().sub(offset)]] as const) {
        const correction = candidate.clone().sub(newStart)
        if (AXIS_KEYS.some((key, i) => !allowedAxes.includes(i as Axis3) && Math.abs(correction[key]) > FACE_EPS)) continue
        const world = ep.distanceTo(corner)
        if (world > maxMm) continue
        const px = epPx.distanceTo(toScreen(corner, camera, size))
        const effective = world <= minMm ? Math.min(px, maxPx - 1) : px
        if (effective < bestPx) {
          bestPx = effective
          best = new THREE.Vector3(...AXIS_KEYS.map((key, i) => allowedAxes.includes(i as Axis3) ? round3(candidate[key]) : newStart[key]) as [number, number, number])
          bestRef = other.id
        }
      }
    }
  }
  return { position: best ?? newStart, refId: best ? bestRef : null }
}

/**
 * Snap a moving group to nearby faces, edges, centrelines or endpoints within the threshold.
 * Holding Shift disables snapping.
 */
export function computeDragSnap(
  moving: ProfileData[],
  proposed: Map<string, [number, number, number]>,
  others: ProfileData[],
  threshold = alignThreshold(moving),
  previous: SnapGuide[] = [],
  allowedAxes: readonly Axis3[] = [0, 1, 2],
): SnapResult {
  const offset = new THREE.Vector3()
  const refIds = new Set<string>()
  const axes: Axis3[] = []
  const guides: SnapGuide[] = []
  if (moving.length === 0 || others.length === 0) return { offset, refIds: [], axes, guides }

  const proposedMoving = moving.map((p) => ({ ...p, position: proposed.get(p.id) ?? p.position }))
  const scene = [...others, ...proposedMoving]
  const movingBoxes = proposedMoving.map((p) => memberBox(p))
  const group = new THREE.Box3()
  for (const b of movingBoxes) group.union(b)
  const staticBoxes = others.map((p) => ({ profile: p, box: memberBox(p), axis: axisOf(p) }))
  const actualBox = renderedBoxes(scene)
  const release = Math.min(ALIGN_MAX_MM, threshold * 1.4)
  const rank = { end: 0, face: 1, edge: 2, center: 3 }
  interface Candidate { delta: number; guide: SnapGuide; intent: keyof typeof rank }

  for (let axis = 0; axis < 3; axis++) {
    if (!allowedAxes.includes(axis as Axis3)) continue
    const key = AXIS_KEYS[axis]
    const mMid = (group.min[key] + group.max[key]) / 2

    const endAxis = proposedMoving.every((p) => axisOf(p) === axis)
    const boxes = endAxis ? proposedMoving.map(actualBox) : movingBoxes
    const physicalGroup = new THREE.Box3()
    for (const box of boxes) physicalGroup.union(box)
    const support = (side: -1 | 1) => proposedMoving[boxes.findIndex((box) =>
      Math.abs(sideCoord(box, key, side) - sideCoord(physicalGroup, key, side)) <= FACE_EPS)]
    const candidates: Candidate[] = []
    for (const s of staticBoxes) {
      const gap = transverseGap(group, s.box, axis as Axis3)
      if (gap > REFERENCE_REACH_MM) continue
      const endPair = endAxis && s.axis === axis
      const refBox = endPair ? actualBox(s.profile) : s.box
      const moveBox = endPair ? physicalGroup : group
      for (const [movingSide, refSide, kind] of [[1, -1, 'face'], [-1, 1, 'face'], [-1, -1, 'edge'], [1, 1, 'edge']] as const) {
        // Contact planes must belong to nearby bodies; remote alignment remains possible.
        if (kind === 'face' && gap > threshold) continue
        const coord = sideCoord(refBox, key, refSide)
        const delta = coord - sideCoord(moveBox, key, movingSide)
        if (Math.abs(delta) > release) continue
        const contributor = endPair ? support(movingSide) : moving[movingBoxes.findIndex((box) =>
          Math.abs(sideCoord(box, key, movingSide) - sideCoord(group, key, movingSide)) <= FACE_EPS)]
        const intent = endPair ? 'end' : kind
        const faceKind = intent !== 'end' && (!contributor || !hasAxisFace(contributor, axis as Axis3)
          || !hasAxisFace(s.profile, axis as Axis3)) ? 'align' : intent
        candidates.push({ delta, intent, guide: { axis: axis as Axis3, kind: faceKind,
          coord: round3(coord), refId: s.profile.id, movingId: contributor?.id, movingSide, refSide } })
      }
      const delta = (s.box.min[key] + s.box.max[key]) / 2 - mMid
      if (Math.abs(delta) <= release) candidates.push({ delta, intent: 'center',
        guide: { axis: axis as Axis3, kind: 'center', coord: (s.box.min[key] + s.box.max[key]) / 2, refId: s.profile.id } })
    }
    const compare = (a: Candidate, b: Candidate) => Math.abs(a.delta) - Math.abs(b.delta)
      || rank[a.intent] - rank[b.intent]
    const captured = candidates.filter((c) => Math.abs(c.delta) <= threshold).sort(compare)
    let best = captured[0]
    const end = captured.find((c) => c.guide.kind === 'end')
    const deliberateCenter = best?.guide.kind === 'center' && Math.abs(best.delta) <= CENTER_INTENT_MM
    if (best && end && ((best.intent === 'center' && !deliberateCenter)
      || (best.intent === 'edge' && Math.abs(end.delta) <= Math.abs(best.delta) + END_PREFERENCE_MM + FACE_EPS))) best = end
    const held = candidates.filter((c) => previous.some((g) => sameGuide(g, c.guide))).sort(compare)[0]
    if (!deliberateCenter && held && (!best || Math.abs(held.delta) <= Math.abs(best.delta) + HOLD_MARGIN_MM + FACE_EPS)) best = held
    if (best) {
      // Keep an engaged face visible at exact alignment, without announcing every floor face.
      if (Math.abs(best.delta) <= 1e-6 && !previous.some((g) => sameGuide(g, best.guide))) continue
      offset[key] = Math.round(best.delta * 1000) / 1000
      guides.push(best.guide)
    }
  }

  // Any surface snap can form/dissolve a joint and change its cut, including an end
  // against a perpendicular member's side. Solve all chosen planes together against
  // the final rendered geometry, so one axis cannot silently invalidate another.
  let finalGeometry: { offset: THREE.Vector3; placed: ProfileData[]; boxFor: ReturnType<typeof renderedBoxes> } | null = null
  const residuals = () => {
    if (!finalGeometry || !finalGeometry.offset.equals(offset)) {
      const placed = proposedMoving.map((p) => ({ ...p,
        position: new THREE.Vector3(...p.position).add(offset).toArray() as [number, number, number] }))
      finalGeometry = { offset: offset.clone(), placed, boxFor: renderedBoxes([...others, ...placed]) }
    }
    const { placed, boxFor } = finalGeometry
    return guides.filter((g) => g.movingSide && g.refSide).map((guide) => {
      const key = AXIS_KEYS[guide.axis]
      const ref = others.find((p) => p.id === guide.refId)!
      const coord = sideCoord(boxFor(ref), key, guide.refSide!)
      const faces = placed.map((p) => ({ id: p.id, coord: sideCoord(boxFor(p), key, guide.movingSide!) }))
      const face = faces.reduce((a, b) => guide.movingSide! < 0 ? (a.coord <= b.coord ? a : b) : (a.coord >= b.coord ? a : b))
      guide.coord = round3(coord); guide.movingId = face.id
      return { guide, residual: coord - face.coord }
    })
  }
  const discard = (guide: SnapGuide) => {
    offset[AXIS_KEYS[guide.axis]] = 0
    guides.splice(guides.indexOf(guide), 1)
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const unsettled = residuals().filter(({ residual }) => Math.abs(residual) > FACE_EPS)
    if (unsettled.length === 0) break
    for (const { guide, residual } of unsettled) {
      const key = AXIS_KEYS[guide.axis]
      const next = round3(offset[key] + residual)
      const limit = previous.some((g) => sameGuide(g, guide)) ? release : threshold
      if (Math.abs(next) > limit) discard(guide)
      else offset[key] = next
    }
  }
  // Removing one correction may change a joint used by another plane. At most three
  // axes can be discarded, and the surviving guides must all describe real alignment.
  for (let pass = 0; pass < 3; pass++) {
    const invalid = residuals().filter(({ residual }) => Math.abs(residual) > FACE_EPS)
    if (invalid.length === 0) break
    for (const { guide } of invalid) discard(guide)
  }
  for (const guide of guides) {
    if (guide.kind === 'face' || guide.kind === 'edge') {
      const contributor = moving.find((p) => p.id === guide.movingId)
      const ref = others.find((p) => p.id === guide.refId)!
      if (!contributor || !hasAxisFace(contributor, guide.axis) || !hasAxisFace(ref, guide.axis)) guide.kind = 'align'
    }
    refIds.add(guide.refId); axes.push(guide.axis)
  }

  return { offset, refIds: [...refIds], axes, guides }
}
