import type { ConnectorData, FittingData, PanelData, ProfileData } from '../store/useStore'
import type { ThroughRule } from './jointUtils'
import { CONNECTOR_CATALOG } from './connectorCatalog'
import { migrateFittings } from './migrate'
import { validFittingFields, validFittingDimensions } from './fittingValidation'

export const PROJECT_VERSION = 7
export interface ProjectGeometry {
  profiles: ProfileData[]
  connectors: ConnectorData[]
  panels: PanelData[]
  fittings: FittingData[]
}
export interface ProjectDocument extends ProjectGeometry { throughRule: ThroughRule }
export interface ParsedProjectDocument extends ProjectDocument { version: typeof PROJECT_VERSION }
const specs = ['2020', '2040', '3030', '3040', '4040']
const materials = ['mdf', 'ply', 'acrylic', 'alu']
const connectorTypes = new Set(CONNECTOR_CATALOG.map((entry) => entry.type))
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const positive = (v: unknown) => finite(v) && v > 0
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const vector = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every(finite)
const oneOf = (v: unknown, values: readonly unknown[]) => values.includes(v)
function optional(v: unknown, valid: (v: unknown) => boolean): boolean { return v === undefined || valid(v) }
function fail(message: string): never { throw new Error(`Invalid project: ${message}`) }

function readProjectDocument(input: unknown): ProjectDocument {
  const doc: unknown = typeof input === 'string' ? JSON.parse(input) : input
  if (!record(doc)) fail('expected an object')
  if (!optional(doc.version, (v) => finite(v) && Number.isInteger(v) && v >= 1 && v <= PROJECT_VERSION)) fail('unsupported version')
  if (!optional(doc.throughRule, (v) => oneOf(v, ['rails', 'posts']))) fail('through rule')
  if (!Array.isArray(doc.profiles)) fail('profiles')
  for (const key of ['connectors', 'panels', 'fittings']) {
    if (doc[key] !== undefined && !Array.isArray(doc[key])) fail(key)
  }
  const ids = new Set<string>()
  const base = (value: unknown): Record<string, unknown> => {
    if (!record(value)) fail('part must be an object')
    if (typeof value.id !== 'string' || !value.id.trim() || ids.has(value.id)) fail('missing or duplicate part id')
    ids.add(value.id)
    if (!vector(value.position, 3) || !vector(value.quaternion, 4)) fail(`pose of ${value.id}`)
    const norm = value.quaternion.reduce((sum, v) => sum + v * v, 0)
    if (!finite(norm) || norm < 1e-12) fail(`orientation of ${value.id}`)
    if (!optional(value.locked, (v) => typeof v === 'boolean')) fail('locked')
    return value
  }
  const profiles = doc.profiles.map((value) => {
    const p = base(value)
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
    const c = base(value)
    if (typeof c.type !== 'string' || !connectorTypes.has(c.type)
      || !optional(c.series, (v) => oneOf(v, [20, 30, 40]))) fail('connector type or series')
    return { ...c } as unknown as ConnectorData
  })
  const panels = ((doc.panels ?? []) as unknown[]).map((value) => {
    const b = base(value)
    if (![b.width, b.height, b.thickness].every(positive) || !oneOf(b.material, materials)) fail('panel size or material')
    return { ...b } as unknown as PanelData
  })
  const fittings = ((doc.fittings ?? []) as unknown[]).map((value) => {
    const f = base(value)
    if (!validFittingFields(f)) fail('fitting dimensions or mechanism')
    return { ...f, open: f.open ?? 0 } as unknown as FittingData
  })
  return {
    profiles, connectors, panels, fittings,
    throughRule: (doc.throughRule ?? 'rails') as ThroughRule,
  }
}

function checkFittingDimensions(doc: ProjectDocument): ProjectDocument {
  if (!doc.fittings.every(validFittingDimensions)) fail('fitting opening or drawer box dimensions')
  return doc
}

/** Validate current geometry without inferring or moving any parts. */
export function validateProjectDocument(input: unknown): ProjectDocument {
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
