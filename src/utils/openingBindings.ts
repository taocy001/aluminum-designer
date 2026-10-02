import * as THREE from 'three'
import type { ConnectorData, EquipmentData, FittingData, PanelData, ProfileData } from '../store/useStore'
import { computeAllTrims, type ProfileTrims, type ThroughRule } from './jointUtils'
import { profileBodyEndpoints, profileFace, type ProfileFace, type ProfileFaceRef } from './profileFaces'
import { drawerLayout } from './drawerLayout'
import { validFitting } from './fittingValidation'
import { specDims } from './specUtils'

export type OpeningRole = 'left' | 'right' | 'bottom' | 'top' | 'front' | 'back'
export interface OpeningRef {
  left: ProfileFaceRef
  right: ProfileFaceRef
  bottom: ProfileFaceRef
  top: ProfileFaceRef
  front: ProfileFaceRef
  /** Exactly one of a physical rear face and a fixed depth is required. */
  back?: ProfileFaceRef
  fixedDepth?: number
}
export type FittingOpeningBinding =
  | { opening: OpeningRef; mode: 'door'; start: number; end: number }
  | { opening: OpeningRef; mode: 'drawer'; bottomOffset: number }
export type PanelOpeningMode = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom'
export interface PanelOpeningBinding {
  opening: OpeningRef
  mode: PanelOpeningMode
  margins: { left: number; right: number; bottom: number; top: number }
  normalOffset: number
}
export interface RunnerBinding {
  fittingId: string
  side: 'left' | 'right'
  backOffset: number
  frontOffset: number
}
export interface SupportBinding {
  profileId: string
  end: 'start' | 'end'
  localPosition: [number, number, number]
  localQuaternion: [number, number, number, number]
}
export type EditRejection = 'locked-dependent' | 'driven-part' | 'invalid-opening' | 'invalid-fitting' | 'invalid-profile' | 'invalid-equipment'
export type EditResult =
  | { status: 'applied'; changedIds: string[]; orphanedIds: string[] }
  | { status: 'noop' }
  | { status: 'rejected'; reason: EditRejection; partIds: string[] }
export interface ResolvedOpening {
  position: [number, number, number]
  quaternion: [number, number, number, number]
  width: number
  height: number
  depth: number
  frame: number
  faces: Partial<Record<OpeningRole, ProfileFace>>
}
export type OpeningResult =
  | { status: 'resolved'; opening: ResolvedOpening }
  | { status: 'missing-source'; sourceIds: string[] }
  | { status: 'invalid'; reason: 'axes' | 'dimensions' | 'derived-source' | 'definition'; sourceIds: string[] }
export interface OpeningFaceOption { key: string; ref: ProfileFaceRef; face: ProfileFace; coordinate: number }

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim()
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every((k) => allowed.includes(k))
const tuple = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every(finite)
const quaternion = (v: unknown) => tuple(v, 4) && finite(v.reduce((sum, n) => sum + n * n, 0)) && Math.hypot(...v) >= 1e-6
const faceRef = (v: unknown): v is ProfileFaceRef => record(v) && keys(v, ['profileId', 'axis', 'side'])
  && id(v.profileId) && [0, 1, 2].includes(v.axis as number) && [-1, 1].includes(v.side as number)
const roles: OpeningRole[] = ['left', 'right', 'bottom', 'top', 'front', 'back']

/** Structural validation deliberately accepts absent source IDs, which represent lost links. */
export function validOpeningRef(v: unknown): v is OpeningRef {
  return record(v) && keys(v, [...roles, 'fixedDepth'])
    && roles.slice(0, 5).every((k) => faceRef(v[k]))
    && (v.back === undefined ? finite(v.fixedDepth) && v.fixedDepth > 0 : faceRef(v.back) && v.fixedDepth === undefined)
}
export function validFittingOpeningBinding(v: unknown): v is FittingOpeningBinding {
  return record(v) && validOpeningRef(v.opening) && (v.mode === 'door'
    ? keys(v, ['opening', 'mode', 'start', 'end']) && finite(v.start) && finite(v.end) && v.start >= 0 && v.start < v.end && v.end <= 1
    : v.mode === 'drawer' && keys(v, ['opening', 'mode', 'bottomOffset']) && finite(v.bottomOffset) && v.bottomOffset >= 0)
}
export function validPanelOpeningBinding(v: unknown): v is PanelOpeningBinding {
  return record(v) && keys(v, ['opening', 'mode', 'margins', 'normalOffset']) && validOpeningRef(v.opening)
    && roles.includes(v.mode as OpeningRole) && finite(v.normalOffset) && record(v.margins)
    && keys(v.margins, ['left', 'right', 'bottom', 'top']) && ['left', 'right', 'bottom', 'top'].every((k) => finite((v.margins as Record<string, unknown>)[k]))
}
export function validRunnerBinding(v: unknown): v is RunnerBinding {
  return record(v) && keys(v, ['fittingId', 'side', 'backOffset', 'frontOffset']) && id(v.fittingId)
    && ['left', 'right'].includes(v.side as string) && finite(v.backOffset) && finite(v.frontOffset)
}
export function validSupportBinding(v: unknown): v is SupportBinding {
  return record(v) && keys(v, ['profileId', 'end', 'localPosition', 'localQuaternion']) && id(v.profileId)
    && ['start', 'end'].includes(v.end as string) && tuple(v.localPosition, 3) && quaternion(v.localQuaternion)
}
export const openingSourceIds = (ref: OpeningRef): string[] => [...new Set(roles.flatMap((role) => ref[role] ? [ref[role]!.profileId] : []))]
const v3 = (v: readonly number[]) => new THREE.Vector3(v[0], v[1], v[2])
const round = (n: number) => {
  const value = Math.round(n * 1e6) / 1e6
  return Object.is(value, -0) ? 0 : value
}
const point = (v: THREE.Vector3) => v.toArray().map(round) as [number, number, number]

/** Resolve only the explicitly named physical planes, under the supplied manufacturing rule. */
export function resolveOpening(ref: OpeningRef, profiles: ProfileData[], throughRule: ThroughRule, resolvedTrims?: Map<string, ProfileTrims>): OpeningResult {
  if (!validOpeningRef(ref)) return { status: 'invalid', reason: 'definition', sourceIds: [] }
  const sourceIds = openingSourceIds(ref)
  const byId = new Map(profiles.map((p) => [p.id, p]))
  const missing = sourceIds.filter((key) => !byId.has(key))
  if (missing.length) return { status: 'missing-source', sourceIds: missing }
  if (sourceIds.some((key) => byId.get(key)!.runnerBinding)) return { status: 'invalid', reason: 'derived-source', sourceIds }
  const trims = resolvedTrims ?? computeAllTrims(profiles, throughRule)
  const faces: Partial<Record<OpeningRole, ProfileFace>> = {}
  for (const role of roles) if (ref[role]) {
    const r = ref[role]!
    faces[role] = profileFace(byId.get(r.profileId)!, r, trims.get(r.profileId))
  }
  const x = v3(faces.left!.normal).normalize(), y = v3(faces.bottom!.normal).normalize()
  const z = x.clone().cross(y).normalize()
  const aligned = (role: OpeningRole, axis: THREE.Vector3, sign: number) => !faces[role]
    || v3(faces[role]!.normal).dot(axis) * sign > 1 - 1e-6
  if (Math.abs(x.dot(y)) > 1e-6 || !aligned('right', x, -1) || !aligned('top', y, -1)
    || !aligned('front', z, -1) || !aligned('back', z, 1)) return { status: 'invalid', reason: 'axes', sourceIds }
  const at = (role: OpeningRole, axis: THREE.Vector3) => v3(faces[role]!.center).dot(axis)
  const left = at('left', x), right = at('right', x), bottom = at('bottom', y), top = at('top', y), front = at('front', z)
  const back = faces.back ? at('back', z) : front - ref.fixedDepth!
  const width = round(right - left), height = round(top - bottom), depth = round(front - back)
  if (![width, height, depth].every((n) => Number.isFinite(n) && n > 0)) return { status: 'invalid', reason: 'dimensions', sourceIds }
  const other = profileFace(byId.get(ref.front.profileId)!, { ...ref.front, side: ref.front.side === 1 ? -1 : 1 }, trims.get(ref.front.profileId))
  const frame = round(Math.abs(v3(other.center).dot(z) - front))
  const center = x.clone().multiplyScalar((left + right) / 2).addScaledVector(y, (bottom + top) / 2).addScaledVector(z, (front + back) / 2)
  if (!Number.isFinite(frame) || !point(center).every(Number.isFinite)) return { status: 'invalid', reason: 'dimensions', sourceIds }
  return { status: 'resolved', opening: { position: point(center),
    quaternion: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z)).normalize().toArray() as ResolvedOpening['quaternion'],
    width, height, depth, frame, faces } }
}

/** Offer actual selected faces. Choosing a candidate never creates an association. */
export function openingFaceOptions(profiles: ProfileData[], selectedIds: string[], orientation: [number, number, number, number], throughRule: ThroughRule): Record<OpeningRole, OpeningFaceOption[]> {
  const out: Record<OpeningRole, OpeningFaceOption[]> = { left: [], right: [], bottom: [], top: [], front: [], back: [] }
  const q = new THREE.Quaternion(...orientation).normalize()
  const basis = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)].map((v) => v.applyQuaternion(q))
  const targets: Record<OpeningRole, [number, number]> = { left: [0, 1], right: [0, -1], bottom: [1, 1], top: [1, -1], front: [2, -1], back: [2, 1] }
  const ids = new Set(selectedIds), trims = computeAllTrims(profiles, throughRule)
  for (const p of profiles) if (ids.has(p.id) && !p.runnerBinding) {
    for (const axis of [0, 1, 2] as const) for (const side of [-1, 1] as const) {
      const ref = { profileId: p.id, axis, side }, face = profileFace(p, ref, trims.get(p.id))
      for (const role of roles) {
        const [a, sign] = targets[role]
        if (v3(face.normal).dot(basis[a]) * sign > 1 - 1e-6) out[role].push({ key: `${p.id}:${axis}:${side}`, ref, face, coordinate: v3(face.center).dot(basis[a]) })
      }
    }
  }
  for (const role of roles) out[role].sort((a, b) => a.coordinate - b.coordinate || a.key.localeCompare(b.key))
  return out
}

const panelBasis: Record<PanelOpeningMode, [[number, number, number], [number, number, number], [number, number, number]]> = {
  front: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], back: [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
  left: [[0, 0, 1], [0, 1, 0], [-1, 0, 0]], right: [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  top: [[1, 0, 0], [0, 0, -1], [0, 1, 0]], bottom: [[1, 0, 0], [0, 0, 1], [0, -1, 0]],
}
const panelRotation = (mode: PanelOpeningMode) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(...panelBasis[mode].map(v3) as [THREE.Vector3, THREE.Vector3, THREE.Vector3]))
export function panelOpeningOrientation(q: PanelData['quaternion'], mode: PanelOpeningMode): PanelData['quaternion'] {
  return new THREE.Quaternion(...q).normalize().multiply(panelRotation(mode).invert()).normalize().toArray() as PanelData['quaternion']
}

export function deriveOpeningFitting(f: FittingData, opening: ResolvedOpening): FittingData | null {
  const b = f.openingBinding
  if (!b || b.mode !== f.kind) return null
  const q = new THREE.Quaternion(...opening.quaternion)
  let width = opening.width, height = f.height, x = 0, y = 0
  if (b.mode === 'door') { width *= b.end - b.start; height = opening.height; x = opening.width * ((b.start + b.end) / 2 - 0.5) }
  else { y = -opening.height / 2 + b.bottomOffset + height / 2; if (b.bottomOffset + height > opening.height + 1e-6) return null }
  const result = { ...f, width: round(width), height: round(height), depth: opening.depth, frame: opening.frame,
    position: point(new THREE.Vector3(x, y, 0).applyQuaternion(q).add(v3(opening.position))), quaternion: [...opening.quaternion] as FittingData['quaternion'] }
  return validFitting(result) ? result : null
}
export function deriveOpeningPanel(p: PanelData, opening: ResolvedOpening): PanelData | null {
  const b = p.openingBinding
  if (!b) return null
  const [x, y, z] = panelBasis[b.mode].map(v3), spans = v3([opening.width, opening.height, opening.depth])
  const extent = (axis: THREE.Vector3) => Math.abs(axis.x) * spans.x + Math.abs(axis.y) * spans.y + Math.abs(axis.z) * spans.z
  const width = round(extent(x) - b.margins.left - b.margins.right), height = round(extent(y) - b.margins.bottom - b.margins.top)
  if (![width, height].every((n) => Number.isFinite(n) && n >= 20)) return null
  const q = new THREE.Quaternion(...opening.quaternion)
  const at = x.multiplyScalar((b.margins.left - b.margins.right) / 2).addScaledVector(y, (b.margins.bottom - b.margins.top) / 2)
    .addScaledVector(z, extent(z) / 2 + b.normalOffset).applyQuaternion(q).add(v3(opening.position))
  if (!point(at).every(Number.isFinite)) return null
  return { ...p, width, height, position: point(at), quaternion: q.multiply(panelRotation(b.mode)).normalize().toArray() as PanelData['quaternion'] }
}

/** A support recipe uses the same closed drawer layout as rendering and mounting checks. */
export function deriveRunner(p: ProfileData, f: FittingData): ProfileData | null {
  const b = p.runnerBinding
  if (!b || f.kind !== 'drawer' || !validFitting(f)) return null
  const { hw, hh } = specDims(p.spec), d = drawerLayout(f)
  const back = -f.depth / 2 + b.backOffset, front = f.depth / 2 + b.frontOffset
  if (!Number.isFinite(round(front - back)) || front - back < 10 || hh * 2 > d.boxHeight) return null
  const q = new THREE.Quaternion(...f.quaternion).normalize()
  const position = point(new THREE.Vector3((b.side === 'left' ? -1 : 1) * (f.width / 2 + hw), d.boxY, back).applyQuaternion(q).add(v3(f.position)))
  if (!position.every(Number.isFinite)) return null
  return { ...p, position, quaternion: q.toArray() as ProfileData['quaternion'], length: round(front - back), fixedTrims: { start: 0, end: 0 } }
}
export function deriveSupport(c: ConnectorData, p: ProfileData): ConnectorData | null {
  const b = c.supportBinding!, q = new THREE.Quaternion(...p.quaternion).normalize()
  const endpoint = profileBodyEndpoints(p)[b.end]
  const position = point(v3(b.localPosition).applyQuaternion(q).add(endpoint))
  if (!position.every(Number.isFinite)) return null
  return { ...c, position,
    quaternion: q.multiply(new THREE.Quaternion(...b.localQuaternion).normalize()).normalize().toArray() as ConnectorData['quaternion'] }
}

export interface BindingDocument { profiles: ProfileData[]; connectors: ConnectorData[]; panels: PanelData[]; fittings: FittingData[]; equipment?: EquipmentData[]; throughRule: ThroughRule }
export type BindingResolution = { status: 'resolved'; document: BindingDocument; orphanedIds: string[] } | Extract<EditResult, { status: 'rejected' }>
const nearValue = (a: unknown, b: unknown): boolean => typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-6
  : Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((v, i) => nearValue(v, b[i]))
    : a && b && typeof a === 'object' && typeof b === 'object' ? JSON.stringify(a) === JSON.stringify(b) : a === b
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const sameFields = (a: object, b: object, fields: string[]) => fields.every((key) => {
  const av = (a as Record<string, unknown>)[key], bv = (b as Record<string, unknown>)[key]
  if (key === 'quaternion' && tuple(av, 4) && tuple(bv, 4)) {
    return Math.abs(new THREE.Quaternion(...av as [number, number, number, number]).normalize()
      .dot(new THREE.Quaternion(...bv as [number, number, number, number]).normalize())) > 1 - 1e-10
  }
  return nearValue(av, bv)
})
const rejected = (reason: EditRejection, partId: string): Extract<EditResult, { status: 'rejected' }> => ({ status: 'rejected', reason, partIds: [partId] })

/** Stage every dependent before any store write. Broken links retain their last saved geometry. */
export function reconcileBindings(before: BindingDocument, candidate: BindingDocument): BindingResolution {
  const next = { ...candidate }, orphanedIds: string[] = []
  // Cache cuts and repeated opening references within this transaction.
  const openingResolver = (doc: BindingDocument) => {
    let trims: Map<string, ProfileTrims> | undefined
    const cache = new Map<string, OpeningResult>()
    return (ref: OpeningRef) => {
      const key = JSON.stringify(ref)
      if (!cache.has(key)) cache.set(key, resolveOpening(ref, doc.profiles, doc.throughRule,
        trims ??= computeAllTrims(doc.profiles, doc.throughRule)))
      return cache.get(key)!
    }
  }
  const resolveNext = openingResolver(next), resolveBefore = openingResolver(before)
  const beforeParts = new Map([...before.profiles, ...before.panels, ...before.fittings, ...before.connectors].map((p) => [p.id, p]))
  let issue: Extract<EditResult, { status: 'rejected' }> | undefined
  const accept = <T extends { id: string; locked?: boolean }>(part: T, derived: T, fields: string[], binding: unknown, previousBinding: unknown, driverChanged: boolean): T => {
    const old = beforeParts.get(part.id)
    if (old?.locked && !sameFields(old, derived, fields)) { issue ??= rejected('locked-dependent', part.id); return part }
    if (old && equal(binding, previousBinding) && !driverChanged && !sameFields(part, derived, fields)) {
      issue ??= rejected('driven-part', part.id); return part
    }
    return sameFields(part, derived, fields) ? part : derived
  }
  const openingPart = <T extends FittingData | PanelData>(part: T, derive: (part: T, opening: ResolvedOpening) => T | null, fields: string[]): T => {
    if (part.openingBinding === undefined) return part
    const binding = part.openingBinding, old = beforeParts.get(part.id) as T | undefined
    const valid = 'kind' in part ? validFittingOpeningBinding(binding) && binding.mode === part.kind : validPanelOpeningBinding(binding)
    if (!valid) { issue ??= rejected('invalid-opening', part.id); return part }
    const resolved = resolveNext(binding.opening)
    const previous = old?.openingBinding ? resolveBefore(old.openingBinding.opening) : undefined
    if (resolved.status === 'missing-source') {
      if (previous?.status !== 'missing-source') orphanedIds.push(part.id)
      if (old && equal(binding, old.openingBinding) && !sameFields(old, part, fields)) issue ??= rejected('driven-part', part.id)
      return part
    }
    if (resolved.status !== 'resolved') { issue ??= rejected('invalid-opening', part.id); return part }
    const derived = derive(part, resolved.opening)
    if (!derived) { issue ??= rejected('kind' in part ? 'invalid-fitting' : 'invalid-opening', part.id); return part }
    const oldDerived = previous?.status === 'resolved' && old ? derive(old, previous.opening) : null
    return accept(part, derived, fields, binding, old?.openingBinding, !oldDerived || !sameFields(oldDerived, derived, fields))
  }
  next.fittings = next.fittings.map((f) => openingPart(f, deriveOpeningFitting, ['width', 'height', 'depth', 'frame', 'position', 'quaternion']))
  next.panels = next.panels.map((p) => openingPart(p, deriveOpeningPanel, ['width', 'height', 'position', 'quaternion']))
  next.profiles = next.profiles.map((p) => {
    if (p.runnerBinding === undefined) return p
    if (!validRunnerBinding(p.runnerBinding)) { issue ??= rejected('invalid-profile', p.id); return p }
    const f = next.fittings.find((v) => v.id === p.runnerBinding!.fittingId)
    const old = beforeParts.get(p.id) as ProfileData | undefined
    const fields = ['length', 'position', 'quaternion', 'fixedTrims']
    if (!f) {
      if (before.fittings.some((v) => v.id === p.runnerBinding!.fittingId)) orphanedIds.push(p.id)
      if (old && equal(old.runnerBinding, p.runnerBinding) && !sameFields(old, p, fields)) issue ??= rejected('driven-part', p.id)
      return p
    }
    const derived = deriveRunner(p, f)
    if (!derived) { issue ??= rejected('invalid-profile', p.id); return p }
    const oldF = old?.runnerBinding && before.fittings.find((v) => v.id === old.runnerBinding!.fittingId)
    const oldDerived = old && oldF ? deriveRunner(old, oldF) : null
    return accept(p, derived, fields, p.runnerBinding, old?.runnerBinding, !oldDerived || !sameFields(oldDerived, derived, fields))
  })
  next.connectors = next.connectors.map((c) => {
    if (c.supportBinding === undefined) return c
    if (!validSupportBinding(c.supportBinding)) { issue ??= rejected('invalid-profile', c.id); return c }
    const p = next.profiles.find((v) => v.id === c.supportBinding!.profileId)
    const old = beforeParts.get(c.id) as ConnectorData | undefined, fields = ['position', 'quaternion']
    if (!p) {
      if (before.profiles.some((v) => v.id === c.supportBinding!.profileId)) orphanedIds.push(c.id)
      if (old && equal(old.supportBinding, c.supportBinding) && !sameFields(old, c, fields)) issue ??= rejected('driven-part', c.id)
      return c
    }
    const derived = deriveSupport(c, p), oldP = old?.supportBinding && before.profiles.find((v) => v.id === old.supportBinding!.profileId)
    if (!derived) { issue ??= rejected('invalid-profile', c.id); return c }
    const oldDerived = old && oldP ? deriveSupport(old, oldP) : null
    return accept(c, derived, fields, c.supportBinding, old?.supportBinding, !oldDerived || !sameFields(oldDerived, derived, fields))
  })
  for (const kind of ['profiles', 'panels', 'fittings', 'connectors'] as const) {
    if (next[kind].every((p, i) => p === candidate[kind][i])) (next[kind] as unknown[]) = candidate[kind]
  }
  return issue ?? { status: 'resolved', document: next, orphanedIds }
}
