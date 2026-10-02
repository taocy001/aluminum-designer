import { drawerLayout } from './drawerLayout'
import { fittingBoardNumber, partNumber } from './partNumbers'
import type { ConnectorData, PanelData, ProfileData, FittingData, HingeType } from '../store/useStore'
import { fittingParts, hingeCount } from './fittingGeometry'
import { materialLabel } from './panelOps'
import type { ProfileTrims } from './jointUtils'
import {
  CONNECTOR_CATALOG, boltLabel, connectorEntry, connectorLabel, nutLabel, seriesOf,
  type ConnectorSeries,
} from './connectorCatalog'

export interface BomRow {
  kind: 'profile' | 'connector' | 'fastener' | 'suggested' | 'panel'
  /** stable key for React and for the CSV */
  key: string
  label: string
  spec: string
  /** cut length for profiles, blank for everything else */
  length?: number
  qty: number
  /** Placed parts and fitting boards represented by this row; inferred hardware has none. */
  partNumbers: string[]
}

export interface BomResult {
  profiles: BomRow[]
  connectors: BomRow[]
  fasteners: BomRow[]
  suggested: BomRow[]
  /** board cut list: one row per distinct size, thickness and material */
  panels: BomRow[]
  totalCutLength: number
  /** square metres of board, which is how sheet goods are quoted */
  totalBoardArea: number
  buttEnds: number
  freeEnds: number
}

/**
 * Group profiles by specification and cut length, and connectors by type and series.
 * Derive fasteners from placed connectors and report inferred end hardware separately.
 */
export function buildBom(
  profiles: ProfileData[], connectors: ConnectorData[], trims: Map<string, ProfileTrims>,
  language: 'zh' | 'en', panels: PanelData[] = [], fittings: FittingData[] = [],
): BomResult {
  const profileRows = new Map<string, BomRow>()
  let totalCutLength = 0
  for (const p of profiles) {
    const cut = cutDimension(trims.get(p.id)?.cutLength ?? p.length)
    totalCutLength += trims.get(p.id)?.cutLength ?? p.length
    const key = `${p.spec}-${cut}`
    const row = profileRows.get(key) ?? { kind: 'profile' as const, key, label: p.spec, spec: p.spec, length: cut, qty: 0, partNumbers: [] }
    row.qty++
    row.partNumbers.push(partNumber('profile', p.id))
    profileRows.set(key, row)
  }

  const connectorRows = new Map<string, BomRow>()
  const boltsBySeries = new Map<ConnectorSeries, number>()
  const nutsBySeries = new Map<ConnectorSeries, number>()
  for (const c of connectors) {
    const series = (c.series ?? 20) as ConnectorSeries
    const key = `${c.type}-${series}`
    const row = connectorRows.get(key) ?? {
      kind: 'connector' as const, key,
      label: connectorLabel(c.type, language), spec: `${series}${language === 'zh' ? ' 系列' : ' series'}`, qty: 0, partNumbers: [],
    }
    row.qty++
    row.partNumbers.push(partNumber('connector', c.id))
    connectorRows.set(key, row)

    const recipe = connectorEntry(c.type)?.fasteners
    if (recipe) {
      if (recipe.bolts) boltsBySeries.set(series, (boltsBySeries.get(series) ?? 0) + recipe.bolts)
      if (recipe.nuts) nutsBySeries.set(series, (nutsBySeries.get(series) ?? 0) + recipe.nuts)
    }
  }

  const fasteners: BomRow[] = []
  for (const [series, qty] of [...boltsBySeries].sort((a, b) => a[0] - b[0])) {
    fasteners.push({ kind: 'fastener', key: `bolt-${series}`, label: boltLabel(series, language), spec: `${series}`, qty, partNumbers: [] })
  }
  for (const [series, qty] of [...nutsBySeries].sort((a, b) => a[0] - b[0])) {
    fasteners.push({ kind: 'fastener', key: `nut-${series}`, label: nutLabel(series, language), spec: `${series}`, qty, partNumbers: [] })
  }

  // Suggested hardware for inferred connections without placed parts.
  let buttEnds = 0
  const freeEndsBySeries = new Map<ConnectorSeries, number>()
  for (const p of profiles) {
    const t = trims.get(p.id)
    if (!t) continue
    const series = seriesOf(p.spec)
    for (const end of [t.start, t.end]) {
      if (end.butt) buttEnds++
      else if (end.partners === 0) freeEndsBySeries.set(series, (freeEndsBySeries.get(series) ?? 0) + 1)
    }
  }
  // only the parts a butt joint actually needs count against the bracket suggestion
  const placedBrackets = connectors.filter((c) => connectorEntry(c.type)?.isCornerBracket).length
  const placedCaps = new Map<ConnectorSeries, number>()
  for (const c of connectors.filter((c) => c.type === 'end-cap')) {
    const series = c.series ?? 20
    placedCaps.set(series, (placedCaps.get(series) ?? 0) + 1)
  }

  const suggested: BomRow[] = []
  const bracketEntry = CONNECTOR_CATALOG.find((c) => c.type === 'bracket')!
  const missingBrackets = Math.max(0, buttEnds - placedBrackets)
  if (missingBrackets > 0) {
    suggested.push({
      kind: 'suggested', key: 'suggest-bracket', spec: '',
      label: language === 'zh' ? `${bracketEntry.labelZh}（按对接端推算）` : `${bracketEntry.labelEn} (from butt joints)`,
      qty: missingBrackets, partNumbers: [],
    })
  }
  let freeEnds = 0
  for (const qty of freeEndsBySeries.values()) freeEnds += qty
  // caps are suggested per series, because a 20 cap does not fit a 40 post
  for (const [series, qty] of [...freeEndsBySeries].sort((a, b) => a[0] - b[0])) {
    const missing = Math.max(0, qty - (placedCaps.get(series) ?? 0))
    if (missing === 0) continue
    suggested.push({
      kind: 'suggested', key: `suggest-cap-${series}`, spec: `${series}`,
      label: language === 'zh' ? `端盖 ${series} 系列（按自由端推算）` : `End cap, ${series} series (from free ends)`,
      qty: missing, partNumbers: [],
    })
  }

  // Group boards by size and material; expand fittings into their boards and hardware.
  const panelRows = new Map<string, BomRow>()
  let totalBoardArea = 0
  const boards = panels.map((panel) => ({ panel, number: partNumber('panel', panel.id) }))
  for (const f of fittings) {
    for (const b of fittingParts(f).boards) {
      boards.push({ number: fittingBoardNumber(f.id, b.key), panel: {
        id: `${f.id}-${b.key}`, width: b.width, height: b.height, thickness: b.thickness,
        position: [0, 0, 0], quaternion: [0, 0, 0, 1], material: f.material,
      } })
    }
    if (f.kind === 'drawer') {
      const depth = cutDimension(drawerLayout(f).runnerLength)
      const key = `runner-${depth}`
      const row = connectorRows.get(key) ?? {
        kind: 'connector' as const, key,
        label: language === 'zh' ? `抽屉滑轨 ${depth}mm` : `Drawer runner ${depth} mm`,
        spec: language === 'zh' ? '侧装一对' : 'side-mount pair', qty: 0, partNumbers: [],
      }
      row.qty++
      connectorRows.set(key, row)
    } else {
      const type: HingeType = f.hingeType ?? 'cup'
      const span = f.hinge === 'top' || f.hinge === 'bottom' ? f.width : f.height
      const n = hingeCount(type, span)
      const length = cutDimension(span)
      const key = type === 'continuous' ? `hinge-${type}-${length}` : `hinge-${type}`
      const names = {
        cup: language === 'zh' ? '35 杯铰' : '35 mm cup hinge',
        slot: language === 'zh' ? '型材合页' : 'T-slot leaf hinge',
        continuous: language === 'zh' ? `长排合页 ${length}mm` : `Piano hinge ${length} mm`,
      }
      const row = connectorRows.get(key) ?? { kind: 'connector' as const, key, label: names[type], spec: '', qty: 0, partNumbers: [] }
      row.qty += n
      connectorRows.set(key, row)
    }
  }
  for (const { panel: b, number } of boards) {
    const w = cutDimension(b.width), h = cutDimension(b.height)
    // the same board turned on its side is the same cut, so the pair is ordered
    const [a1, a2] = w >= h ? [w, h] : [h, w]
    totalBoardArea += (a1 * a2) / 1e6
    const key = `${b.material}-${b.thickness}-${a1}x${a2}`
    const row = panelRows.get(key) ?? {
      kind: 'panel' as const, key,
      label: `${a1} × ${a2} mm`,
      spec: `${materialLabel(b.material, language)} ${b.thickness}mm`,
      qty: 0, partNumbers: [],
    }
    row.qty++
    row.partNumbers.push(number)
    panelRows.set(key, row)
  }

  for (const row of [...profileRows.values(), ...connectorRows.values(), ...panelRows.values()]) row.partNumbers.sort()

  return {
    panels: [...panelRows.values()].sort((a, b) => a.spec.localeCompare(b.spec) || a.label.localeCompare(b.label)),
    totalBoardArea,
    profiles: [...profileRows.values()].sort((a, b) => a.spec.localeCompare(b.spec) || (b.length ?? 0) - (a.length ?? 0)),
    connectors: [...connectorRows.values()].sort((a, b) => a.label.localeCompare(b.label) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    fasteners,
    suggested,
    totalCutLength,
    buttEnds,
    freeEnds,
  }
}

/** Millimetres to the same 0.001 mm precision used by joint geometry and project links. */
function cutDimension(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** CSV with fixed English headers, so downstream tools do not depend on the UI language */
export function bomToCsv(bom: BomResult, overall: string): string {
  const lines = ['Category,Item,Spec,Cut length (mm),Quantity,Part numbers']
  const quoted = (value: string) => `"${value.replace(/"/g, '""')}"`
  const numbers = (row: BomRow) => quoted(row.partNumbers.join('; '))
  for (const r of bom.profiles) lines.push(`Profile,${r.label},${r.spec},${r.length ?? ''},${r.qty},${numbers(r)}`)
  for (const r of bom.connectors) lines.push(`Connector,${quoted(r.label)},${r.spec},,${r.qty},${numbers(r)}`)
  for (const r of bom.fasteners) lines.push(`Fastener,${quoted(r.label)},${r.spec},,${r.qty},${numbers(r)}`)
  for (const r of bom.panels) lines.push(`Board,${quoted(r.label)},${quoted(r.spec)},,${r.qty},${numbers(r)}`)
  for (const r of bom.suggested) lines.push(`Suggested,${quoted(r.label)},${r.spec},,${r.qty},${numbers(r)}`)
  lines.push(`Summary,Overall WxDxH,${overall},,,`)
  lines.push(`Summary,Total cut length (mm),,${cutDimension(bom.totalCutLength)},,`)
  lines.push(`Summary,Board area (m2),,${bom.totalBoardArea.toFixed(2)},,`)
  return lines.join('\n')
}
