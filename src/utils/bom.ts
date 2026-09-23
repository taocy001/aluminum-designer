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
 * The shopping list. Profiles are grouped by spec and cut length; connectors by type and
 * series; fasteners are derived from the connectors that are actually placed, because the
 * usual way a build stalls is discovering the bolts and T-nuts were never ordered.
 * Ends that butt against something and ends left open are reported as suggestions, so a
 * frame without hand-placed parts still tells you roughly what to buy.
 */
export function buildBom(
  profiles: ProfileData[], connectors: ConnectorData[], trims: Map<string, ProfileTrims>,
  language: 'zh' | 'en', panels: PanelData[] = [], fittings: FittingData[] = [],
): BomResult {
  const profileRows = new Map<string, BomRow>()
  let totalCutLength = 0
  for (const p of profiles) {
    const cut = Math.round(trims.get(p.id)?.cutLength ?? p.length)
    totalCutLength += trims.get(p.id)?.cutLength ?? p.length
    const key = `${p.spec}-${cut}`
    const row = profileRows.get(key) ?? { kind: 'profile' as const, key, label: p.spec, spec: p.spec, length: cut, qty: 0 }
    row.qty++
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
      label: connectorLabel(c.type, language), spec: `${series}${language === 'zh' ? ' 系列' : ' series'}`, qty: 0,
    }
    row.qty++
    connectorRows.set(key, row)

    const recipe = connectorEntry(c.type)?.fasteners
    if (recipe) {
      if (recipe.bolts) boltsBySeries.set(series, (boltsBySeries.get(series) ?? 0) + recipe.bolts)
      if (recipe.nuts) nutsBySeries.set(series, (nutsBySeries.get(series) ?? 0) + recipe.nuts)
    }
  }

  const fasteners: BomRow[] = []
  for (const [series, qty] of [...boltsBySeries].sort((a, b) => a[0] - b[0])) {
    fasteners.push({ kind: 'fastener', key: `bolt-${series}`, label: boltLabel(series, language), spec: `${series}`, qty })
  }
  for (const [series, qty] of [...nutsBySeries].sort((a, b) => a[0] - b[0])) {
    fasteners.push({ kind: 'fastener', key: `nut-${series}`, label: nutLabel(series, language), spec: `${series}`, qty })
  }

  // what the frame implies, for the parts nobody has placed yet
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
  const placedCaps = connectors.filter((c) => c.type === 'end-cap').length

  const suggested: BomRow[] = []
  const bracketEntry = CONNECTOR_CATALOG.find((c) => c.type === 'bracket')!
  const missingBrackets = Math.max(0, buttEnds - placedBrackets)
  if (missingBrackets > 0) {
    suggested.push({
      kind: 'suggested', key: 'suggest-bracket', spec: '',
      label: language === 'zh' ? `${bracketEntry.labelZh}（按对接端推算）` : `${bracketEntry.labelEn} (from butt joints)`,
      qty: missingBrackets,
    })
  }
  let freeEnds = 0
  for (const qty of freeEndsBySeries.values()) freeEnds += qty
  // caps are suggested per series, because a 20 cap does not fit a 40 post
  let capsCovered = placedCaps
  for (const [series, qty] of [...freeEndsBySeries].sort((a, b) => a[0] - b[0])) {
    const missing = Math.max(0, qty - capsCovered)
    capsCovered = Math.max(0, capsCovered - qty)
    if (missing === 0) continue
    suggested.push({
      kind: 'suggested', key: `suggest-cap-${series}`, spec: `${series}`,
      label: language === 'zh' ? `端盖 ${series} 系列（按自由端推算）` : `End cap, ${series} series (from free ends)`,
      qty: missing,
    })
  }

  // Boards are grouped the way a cutting shop quotes them: one line per size and material.
  // A drawer and a door are components, but they are still made of board and still take
  // hardware, so they are broken down here rather than being left off the order.
  const panelRows = new Map<string, BomRow>()
  let totalBoardArea = 0
  const fittingBoards: PanelData[] = []
  for (const f of fittings) {
    for (const b of fittingParts(f).boards) {
      fittingBoards.push({
        id: `${f.id}-${b.role}`, width: b.width, height: b.height, thickness: b.thickness,
        position: [0, 0, 0], quaternion: [0, 0, 0, 1], material: f.material,
      })
    }
    if (f.kind === 'drawer') {
      const key = `runner-${Math.round(f.depth)}`
      const row = connectorRows.get(key) ?? {
        kind: 'connector' as const, key,
        label: language === 'zh' ? `抽屉滑轨 ${Math.round(f.depth)}mm` : `Drawer runner ${Math.round(f.depth)} mm`,
        spec: language === 'zh' ? '侧装一对' : 'side-mount pair', qty: 0,
      }
      row.qty++
      connectorRows.set(key, row)
    } else {
      const type: HingeType = f.hingeType ?? 'cup'
      const n = hingeCount(type, f.height)
      const key = `hinge-${type}`
      const names = {
        cup: language === 'zh' ? '35 杯铰' : '35 mm cup hinge',
        slot: language === 'zh' ? '型材合页' : 'T-slot leaf hinge',
        continuous: language === 'zh' ? `长排合页 ${Math.round(f.height)}mm` : `Piano hinge ${Math.round(f.height)} mm`,
      }
      const row = connectorRows.get(key) ?? { kind: 'connector' as const, key, label: names[type], spec: '', qty: 0 }
      row.qty += n
      connectorRows.set(key, row)
    }
  }
  for (const b of [...panels, ...fittingBoards]) {
    const w = Math.round(b.width), h = Math.round(b.height)
    // the same board turned on its side is the same cut, so the pair is ordered
    const [a1, a2] = w >= h ? [w, h] : [h, w]
    totalBoardArea += (a1 * a2) / 1e6
    const key = `${b.material}-${b.thickness}-${a1}x${a2}`
    const row = panelRows.get(key) ?? {
      kind: 'panel' as const, key,
      label: `${a1} × ${a2} mm`,
      spec: `${materialLabel(b.material, language)} ${b.thickness}mm`,
      qty: 0,
    }
    row.qty++
    panelRows.set(key, row)
  }

  return {
    panels: [...panelRows.values()].sort((a, b) => a.spec.localeCompare(b.spec) || a.label.localeCompare(b.label)),
    totalBoardArea,
    profiles: [...profileRows.values()].sort((a, b) => a.spec.localeCompare(b.spec) || (b.length ?? 0) - (a.length ?? 0)),
    connectors: [...connectorRows.values()].sort((a, b) => a.label.localeCompare(b.label)),
    fasteners,
    suggested,
    totalCutLength,
    buttEnds,
    freeEnds,
  }
}

/** CSV with fixed English headers, so downstream tools do not depend on the UI language */
export function bomToCsv(bom: BomResult, overall: string): string {
  const lines = ['Category,Item,Spec,Cut length (mm),Quantity']
  for (const r of bom.profiles) lines.push(`Profile,${r.label},${r.spec},${r.length ?? ''},${r.qty}`)
  for (const r of bom.connectors) lines.push(`Connector,"${r.label}",${r.spec},,${r.qty}`)
  for (const r of bom.fasteners) lines.push(`Fastener,"${r.label}",${r.spec},,${r.qty}`)
  for (const r of bom.panels) lines.push(`Board,"${r.label}","${r.spec}",,${r.qty}`)
  for (const r of bom.suggested) lines.push(`Suggested,"${r.label}",${r.spec},,${r.qty}`)
  lines.push(`Summary,Overall WxDxH,${overall},,`)
  lines.push(`Summary,Total cut length (mm),,${Math.round(bom.totalCutLength)},`)
  lines.push(`Summary,Board area (m2),,${bom.totalBoardArea.toFixed(2)},`)
  return lines.join('\n')
}
