import type { FittingData } from '../store/useStore'
import { drawerLayout } from './drawerLayout'

export const MIN_FITTING_OPENING = 60

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const tuple = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every(finite)
const oneOf = (v: unknown, values: readonly unknown[]) => values.includes(v)
const optional = (v: unknown, valid: (v: unknown) => boolean) => v === undefined || valid(v)

function validDrawerConfig(value: unknown): boolean {
  if (!record(value)) return false
  return Object.entries(value).every(([key, v]) => {
    if (v === undefined) return ['sideClearance', 'boxThickness', 'bottomThickness', 'rearClearance', 'runnerLength', 'runnerTravel', 'reinforcement'].includes(key)
    if (key === 'reinforcement') return record(v) && Object.keys(v).every((k) => ['count', 'width', 'height'].includes(k))
      && finite(v.count) && Number.isInteger(v.count) && v.count >= 0 && v.count <= 4
      && finite(v.width) && v.width > 0 && finite(v.height) && v.height > 0
    if (['sideClearance', 'rearClearance', 'runnerTravel'].includes(key)) return finite(v) && v >= 0
    return ['boxThickness', 'bottomThickness', 'runnerLength'].includes(key) && finite(v) && v > 0
  })
}

/** Structural checks also apply to legacy records before their frame dimensions are migrated. */
export function validFittingFields(value: unknown): boolean {
  if (!record(value) || typeof value.id !== 'string' || !value.id.trim()
    || !tuple(value.position, 3) || !tuple(value.quaternion, 4)) return false
  const norm = value.quaternion.reduce((sum, v) => sum + v * v, 0)
  return finite(norm) && norm >= 1e-12
    && optional(value.locked, (v) => typeof v === 'boolean')
    && oneOf(value.kind, ['door', 'drawer'])
    && [value.width, value.height, value.depth].every((v) => finite(v) && v > 0)
    && oneOf(value.material, ['mdf', 'ply', 'acrylic', 'alu'])
    && optional(value.open, (v) => finite(v) && v >= 0 && v <= 1)
    && optional(value.frame, (v) => finite(v) && v >= 0)
    && optional(value.hinge, (v) => oneOf(v, ['left', 'right', 'top', 'bottom']))
    && optional(value.hingeType, (v) => oneOf(v, ['cup', 'slot', 'continuous']))
    && optional(value.overlay, (v) => oneOf(v, ['full', 'half', 'inset']))
    && optional(value.meeting, (v) => value.kind === 'door' && oneOf(v, ['left', 'right']))
    && optional(value.swing, (v) => finite(v) && v > 0 && v <= 180)
    && optional(value.stacked, (v) => record(v) && Object.entries(v).every(([key, entry]) =>
      oneOf(key, ['above', 'below']) && typeof entry === 'boolean'))
    && optional(value.drawer, (v) => value.kind === 'drawer' && validDrawerConfig(v))
}

/** Every accepted drawer includes its front, two sides, back, inner front and base. */
export function validFittingDimensions(f: FittingData): boolean {
  if (![f.width, f.height, f.depth].every((v) => finite(v) && v >= MIN_FITTING_OPENING)) return false
  if (f.kind !== 'drawer') return true
  if (!optional(f.drawer, validDrawerConfig)) return false
  const d = drawerLayout(f)
  const { reinforcement: r } = d.config
  return Object.values(d).filter((v) => typeof v === 'number').every(finite)
    && d.boxWidth > 40 && d.boxDepth > 40 && d.innerWidth > 0 && d.innerHeight > 0 && d.innerDepth > 0
    && r.count * r.width <= d.innerWidth && d.runnerLength > 0 && d.runnerLength <= Math.min(f.depth, d.boxDepth)
    && (f.drawer?.runnerTravel === undefined || d.travel <= d.runnerLength)
}

export function validFitting(value: unknown): value is FittingData {
  return validFittingFields(value) && finite((value as FittingData).open)
    && validFittingDimensions(value as FittingData)
}

export function validFittings(fittings: FittingData[]): boolean {
  return Array.isArray(fittings) && fittings.every(validFitting)
    && new Set(fittings.map((f) => f.id)).size === fittings.length
}
