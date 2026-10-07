import type { ConnectorData, EquipmentData, FittingData, PanelData, ProfileData } from '../store/useStore'
import type { ThroughRule } from './jointUtils'
import { ALL_SPECS } from './specUtils'
import { CONNECTOR_CATALOG } from './connectorCatalog'
import { migrateFittings } from './migrate'
import { validFittingFields, validFittingDimensions } from './fittingValidation'
import { validOpeningRef, validFittingOpeningBinding, validPanelOpeningBinding, validRunnerBinding, validSupportBinding } from './openingBindings'
import { normalizeEquipmentClearance, validEquipment } from './equipmentValidation'

export const PROJECT_VERSION = 9
export interface ProjectGeometry {
  profiles: ProfileData[]
  connectors: ConnectorData[]
  panels: PanelData[]
  fittings: FittingData[]
  equipment?: EquipmentData[]
}
export interface ProjectDocument extends ProjectGeometry { throughRule: ThroughRule }
export interface ValidatedProjectDocument extends ProjectDocument { equipment: EquipmentData[] }
export interface ParsedProjectDocument extends ValidatedProjectDocument { version: typeof PROJECT_VERSION }
const specs = ALL_SPECS
const materials = ['mdf', 'ply', 'acrylic', 'alu']
const connectorTypes = new Set(CONNECTOR_CATALOG.map((entry) => entry.type))
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const positive = (v: unknown) => finite(v) && v > 0
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const vector = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every(finite)
const oneOf = (v: unknown, values: readonly unknown[]) => values.includes(v)
function optional(v: unknown, valid: (v: unknown) => boolean): boolean { return v === undefined || valid(v) }
function fail(message: string): never { throw new Error(`Invalid project: ${message}`) }

function readProjectDocument(input: unknown): ValidatedProjectDocument {
  const doc: unknown = typeof input === 'string' ? JSON.parse(input) : input
  if (!record(doc)) fail('expected an object')
  if (!optional(doc.version, (v) => finite(v) && Number.isInteger(v) && v >= 1 && v <= PROJECT_VERSION)) fail('unsupported version')
  if (!optional(doc.throughRule, (v) => oneOf(v, ['rails', 'posts']))) fail('through rule')
  if (!Array.isArray(doc.profiles)) fail('profiles')
  for (const key of ['connectors', 'panels', 'fittings', 'equipment']) {
    if (doc[key] !== undefined && !Array.isArray(doc[key])) fail(key)
  }
  const ids = new Set<string>()
  const base = (value: unknown, binding?: 'openingBinding' | 'runnerBinding' | 'supportBinding'): Record<string, unknown> => {
    if (!record(value)) fail('part must be an object')
    if (typeof value.id !== 'string' || !value.id.trim() || ids.has(value.id)) fail('missing or duplicate part id')
    ids.add(value.id)
    if (!vector(value.position, 3) || !vector(value.quaternion, 4)) fail(`pose of ${value.id}`)
    const norm = value.quaternion.reduce((sum, v) => sum + v * v, 0)
    if (!finite(norm) || norm < 1e-12) fail(`orientation of ${value.id}`)
    if (!optional(value.locked, (v) => typeof v === 'boolean')) fail('locked')
    for (const key of ['openingBinding', 'runnerBinding', 'supportBinding']) {
      if (key !== binding && value[key] !== undefined) fail(`binding of ${value.id}`)
    }
    return value
  }
  const profiles = doc.profiles.map((value) => {
    const p = base(value, 'runnerBinding')
    if (!optional(p.runnerBinding, validRunnerBinding)) fail('runner binding')
    if (!oneOf(p.spec, specs) || !positive(p.length)) fail('profile size')
    if (!optional(p.fixedTrims, (v) => record(v) && finite(v.start) && finite(v.end)
      && finite((p.length as number) - v.start - v.end)
      && (p.length as number) - v.start - v.end >= 1 - 1e-7)) fail('fixed profile cuts')
    if (!optional(p.miterCuts, (v) => Array.isArray(v) && v.every((m) => record(m)
      && finite(m.angle) && oneOf(m.side, ['start', 'end'])))) fail('miter cuts')
    if (!optional(p.holes, (v) => Array.isArray(v) && v.every((h) => record(h)
      && typeof h.id === 'string' && vector(h.position, 3) && positive(h.diameter)))) fail('holes')
    return { ...p, miterCuts: p.miterCuts ?? [], holes: p.holes ?? [] } as unknown as ProfileData
  })
  const connectors = ((doc.connectors ?? []) as unknown[]).map((value) => {
    const c = base(value, 'supportBinding')
    if (!optional(c.supportBinding, validSupportBinding)) fail('support binding')
    if (typeof c.type !== 'string' || !connectorTypes.has(c.type)
      || !optional(c.series, (v) => oneOf(v, [20, 30, 40]))
      || !optional(c.mountSeries, (v) => Array.isArray(v) && v.length === 2 && v.every((x) => oneOf(x, [20, 30, 40])))
      || !optional(c.profileSpec, (v) => oneOf(v, ALL_SPECS))) fail('connector type or series')
    return { ...c } as unknown as ConnectorData
  })
  const panels = ((doc.panels ?? []) as unknown[]).map((value) => {
    const b = base(value, 'openingBinding')
    if (!optional(b.openingBinding, validPanelOpeningBinding)) fail('panel opening binding')
    if (![b.width, b.height, b.thickness].every(positive) || !oneOf(b.material, materials)) fail('panel size or material')
    return { ...b } as unknown as PanelData
  })
  const fittings = ((doc.fittings ?? []) as unknown[]).map((value) => {
    const f = base(value, 'openingBinding')
    if (!optional(f.openingBinding, (v) => validFittingOpeningBinding(v) && v.mode === f.kind)) fail('fitting opening binding')
    if (!validFittingFields(f)) fail('fitting dimensions or mechanism')
    return { ...f, open: f.open ?? 0 } as unknown as FittingData
  })
  const equipment = ((doc.equipment ?? []) as unknown[]).map((value) => {
    const e = base(value)
    const clearance = normalizeEquipmentClearance(e.clearance)
    const normalized = { ...e, clearance }
    if (!clearance || !validEquipment(normalized)) fail('equipment dimensions, clearance or name')
    return normalized as unknown as EquipmentData
  })
  const profileIds = new Set(profiles.map((p) => p.id))
  const drawerIds = new Set(fittings.filter((f) => f.kind === 'drawer').map((f) => f.id))
  const reference = (id: string, expected: Set<string>) => {
    if (ids.has(id) && !expected.has(id)) fail('binding source type')
  }
  for (const p of profiles) if (p.runnerBinding) reference(p.runnerBinding.fittingId, drawerIds)
  for (const c of connectors) if (c.supportBinding) reference(c.supportBinding.profileId, profileIds)
  for (const part of [...panels, ...fittings]) if (part.openingBinding) {
    const opening = part.openingBinding.opening
    if (!validOpeningRef(opening)) fail('opening reference')
    for (const key of ['left', 'right', 'bottom', 'top', 'front', 'back'] as const) {
      if (opening[key]) reference(opening[key].profileId, profileIds)
    }
  }
  return {
    profiles, connectors, panels, fittings, equipment,
    throughRule: (doc.throughRule ?? 'rails') as ThroughRule,
  }
}

function checkFittingDimensions(doc: ValidatedProjectDocument): ValidatedProjectDocument {
  if (!doc.fittings.every(validFittingDimensions)) fail('fitting opening or drawer box dimensions')
  return doc
}

/** Validate current geometry without inferring or moving any parts. */
export function validateProjectDocument(input: unknown): ValidatedProjectDocument {
  return checkFittingDimensions(readProjectDocument(input))
}

/** Read external data; retain the current version so a second parse cannot migrate it again. */
export function parseProjectDocument(input: unknown): ParsedProjectDocument {
  const doc: unknown = typeof input === 'string' ? JSON.parse(input) : input
  const checked = readProjectDocument(doc)
  const version = (doc as { version?: number }).version
  return {
    ...checkFittingDimensions({ ...checked,
      fittings: version === undefined || version <= 5 ? migrateFittings(checked.profiles, checked.fittings) : checked.fittings,
    }), version: PROJECT_VERSION,
  }
}

export function serializeProjectDocument(doc: ProjectGeometry & { throughRule?: ThroughRule }): string {
  const checked = validateProjectDocument(doc)
  return JSON.stringify({ version: PROJECT_VERSION, savedAt: new Date().toISOString(), ...checked }, null, 2)
}
