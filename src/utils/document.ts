import type { ConnectorData, FittingData, PanelData, ProfileData } from '../store/useStore'
import type { ThroughRule } from './jointUtils'
import { CONNECTOR_CATALOG } from './connectorCatalog'
import { migrateFittings } from './migrate'

export const PROJECT_VERSION = 4
export interface ProjectGeometry {
  profiles: ProfileData[]
  connectors: ConnectorData[]
  panels: PanelData[]
  fittings: FittingData[]
}
export interface ProjectDocument extends ProjectGeometry { throughRule: ThroughRule }
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

/** Validate all four part types before any document or file target is changed. */
export function parseProjectDocument(input: unknown): ProjectDocument {
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
    if (!oneOf(f.kind, ['drawer', 'door']) || ![f.width, f.height, f.depth].every(positive)
      || !oneOf(f.material, materials) || !optional(f.open, (v) => finite(v) && v >= 0 && v <= 1)
      || !optional(f.frame, (v) => finite(v) && v >= 0)
      || !optional(f.hinge, (v) => oneOf(v, ['left', 'right', 'top', 'bottom']))
      || !optional(f.hingeType, (v) => oneOf(v, ['cup', 'slot', 'continuous']))
      || !optional(f.overlay, (v) => oneOf(v, ['full', 'half', 'inset']))
      || !optional(f.swing, (v) => finite(v) && v > 0 && v <= 180)
      || !optional(f.stacked, (v) => record(v) && optional(v.above, (x) => typeof x === 'boolean')
        && optional(v.below, (x) => typeof x === 'boolean'))) fail('fitting dimensions or mechanism')
    return { ...f, open: f.open ?? 0 } as unknown as FittingData
  })
  return {
    profiles, connectors, panels, fittings: migrateFittings(profiles, fittings),
    throughRule: (doc.throughRule ?? 'rails') as ThroughRule,
  }
}

export function serializeProjectDocument(doc: ProjectGeometry & { throughRule?: ThroughRule }): string {
  const checked = parseProjectDocument(doc)
  return JSON.stringify({ version: PROJECT_VERSION, savedAt: new Date().toISOString(), ...checked }, null, 2)
}
