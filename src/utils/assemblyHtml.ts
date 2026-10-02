import * as THREE from 'three'
import type { ProjectDocument } from './document'
import { assemblySteps, type Step } from './assembly'
import { computeAllTrims } from './jointUtils'
import { connectorOBB, panelOBB, trimmedOBB } from './analysis'
import { fittingParts, fittingSolids } from './fittingGeometry'
import { equipmentBody } from './equipmentGeometry'
import { obbCorners, type OBB } from './obb'
import { buildBom, type BomRow } from './bom'
import { nestProfiles, STOCK_LENGTH } from './nesting'
import { connectorLabel } from './connectorCatalog'
import { materialLabel } from './panelOps'
import { fittingBoardNumber, partNumber } from './partNumbers'

export interface AssemblyHtmlOptions {
  language: 'zh' | 'en'
  title?: string
  stockLength?: number
}

interface IllustratedPart {
  entityId: string
  number: string
  label: string
  dimensions: string
  box: OBB
}
interface Reference { name: string; box: OBB }
type Point = [number, number]

const escapeHtml = (value: string | number) => String(value).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]!)
const dimension = (value: number) => String(Math.round(value * 1000) / 1000)
const compareNumber = (a: IllustratedPart, b: IllustratedPart) => a.number < b.number ? -1 : a.number > b.number ? 1 : 0
const size = (...values: number[]) => values.map(dimension).join(' × ') + ' mm'
const project = (v: THREE.Vector3): Point => [(v.x - v.z) * Math.sqrt(3) / 2, (v.x + v.z) / 2 - v.y]
const edges = [[0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3], [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7]]
const faces = [
  { corners: [0, 1, 3, 2], axis: 0, side: -1 }, { corners: [4, 6, 7, 5], axis: 0, side: 1 },
  { corners: [0, 4, 5, 1], axis: 1, side: -1 }, { corners: [2, 3, 7, 6], axis: 1, side: 1 },
  { corners: [0, 2, 6, 4], axis: 2, side: -1 }, { corners: [1, 5, 7, 3], axis: 2, side: 1 },
] as const

/** Standalone, printable instructions using the project's closed fitting geometry. */
export function buildAssemblyHtml(document: ProjectDocument, options: AssemblyHtmlOptions): string {
  const { profiles, connectors, panels, fittings, throughRule } = document
  const language = options.language, zh = language === 'zh'
  const title = options.title ?? (zh ? '装配图与下料清单' : 'Assembly and cutting guide')
  const stockLength = options.stockLength ?? STOCK_LENGTH
  if (!Number.isFinite(stockLength) || stockLength <= 0) throw new Error('Invalid stock length')
  const t = zh ? {
    overview: '模型概览', materials: '材料清单', cutting: '型材下料', steps: '装配步骤',
    number: '零件编号', item: '名称', specification: '规格 / 尺寸', quantity: '数量',
    profile: '型材', panel: '板件', drawer: '抽屉', door: '门', hardware: '五金', suggested: '推算五金',
    step: '第', stepEnd: '步', previous: '已放置', current: '本步零件', equipment: '设备参考',
    empty: '无装配零件。', noCuts: '无型材下料。', bar: '原料', cut: '切段长度', offcut: '余料',
    unavailable: '超出原料长度，无法下料', total: '合计', stock: '原料长度',
    limits: '仅按几何接触生成装配建议；不验证稳定性或工具空间。',
    geometry: '图示为零件实体盒的等轴投影；门和抽屉按关闭状态展示。虚线设备仅作位置参考。',
    numbering: '框内数字为本图索引，材料和步骤表同时列出图示索引与完整零件编号。完整编号与 BOM、下料表一致；点选图中零件可跳转到材料清单。',
    inferred: '推算数量需结合实际连接方式确认。',
  } : {
    overview: 'Model overview', materials: 'Materials', cutting: 'Profile cutting', steps: 'Assembly steps',
    number: 'Part number', item: 'Item', specification: 'Specification / dimensions', quantity: 'Quantity',
    profile: 'Profile', panel: 'Board', drawer: 'Drawer', door: 'Door', hardware: 'Hardware', suggested: 'Suggested hardware',
    step: 'Step ', stepEnd: '', previous: 'Earlier steps', current: 'Current parts', equipment: 'Equipment reference',
    empty: 'No assembly parts.', noCuts: 'No profile cuts.', bar: 'Stock bar', cut: 'Cut length', offcut: 'Offcut',
    unavailable: 'Exceeds stock length; cannot be cut', total: 'Total', stock: 'Stock length',
    limits: 'Assembly suggestions use geometric contact only; stability and tool access are not checked.',
    geometry: 'Illustrations are isometric projections of part bounding solids. Doors and drawers are closed; dashed equipment is a position reference.',
    numbering: 'Boxed numbers are drawing indexes. Material and step tables pair each index with its full part number, which matches the BOM and cutting list. Click illustrated parts to find their material rows.',
    inferred: 'Confirm suggested quantities against the actual connections.',
  }
  const trims = computeAllTrims(profiles, throughRule)
  const steps = assemblySteps(profiles, connectors, panels, fittings, throughRule)
  const parts: IllustratedPart[] = [
    ...profiles.map((p) => ({
      entityId: p.id, number: partNumber('profile', p.id), label: `${t.profile} ${p.spec}`,
      dimensions: size(trims.get(p.id)!.cutLength), box: trimmedOBB(p, trims.get(p.id)!),
    })),
    ...connectors.map((c) => ({
      entityId: c.id, number: partNumber('connector', c.id), label: connectorLabel(c.type, language),
      dimensions: `${c.series ?? 20}`, box: connectorOBB(c),
    })),
    ...panels.map((p) => ({
      entityId: p.id, number: partNumber('panel', p.id), label: `${t.panel} · ${materialLabel(p.material, language)}`,
      dimensions: size(p.width, p.height, p.thickness), box: panelOBB(p),
    })),
    ...fittings.flatMap((f) => {
      const boxes = fittingSolids(f, 0)
      return fittingParts(f).boards.map((b, i) => ({
        entityId: f.id, number: fittingBoardNumber(f.id, b.key),
        label: `${f.kind === 'door' ? t.door : t.drawer} ${partNumber('fitting', f.id)} · ${b.key}`,
        dimensions: size(b.width, b.height, b.thickness), box: boxes[i],
      }))
    }),
  ].sort(compareNumber)
  const drawingIndexes = new Map(parts.map((part, i) => [part.number, i + 1]))
  const references = [...(document.equipment ?? [])].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .map((e) => ({ name: e.name, box: equipmentBody(e) }))
  const projectedBounds = new THREE.Box2()
  for (const part of [...parts, ...references]) for (const corner of obbCorners(part.box)) {
    projectedBounds.expandByPoint(new THREE.Vector2(...project(corner)))
  }
  const minX = projectedBounds.isEmpty() ? 0 : projectedBounds.min.x
  const minY = projectedBounds.isEmpty() ? 0 : projectedBounds.min.y
  const maxX = projectedBounds.isEmpty() ? 1 : projectedBounds.max.x
  const maxY = projectedBounds.isEmpty() ? 1 : projectedBounds.max.y
  const scale = Math.min(700 / Math.max(1, maxX - minX), 460 / Math.max(1, maxY - minY))
  const at = (p: Point): string => `${dimension(30 + (p[0] - minX) * scale)},${dimension(30 + (p[1] - minY) * scale)}`
  const depth = (p: IllustratedPart) => p.box.center.x + p.box.center.y + p.box.center.z
  const referenceSvg = ({ name, box }: Reference) => {
    const points = obbCorners(box).map(project)
    return `<g class="reference"><title>${escapeHtml(t.equipment)}: ${escapeHtml(name)}</title>${edges.map(([a, b]) =>
      `<path d="M${at(points[a])} L${at(points[b])}"/>`).join('')}</g>`
  }
  const diagram = (shown: IllustratedPart[], current: Set<string>, label: string) => {
    const ordered = [...shown].sort((a, b) => depth(a) - depth(b) || compareNumber(a, b))
    const occupied: Array<{ x: number; y: number; w: number; h: number }> = [{ x: 595, y: 385, w: 140, h: 110 }]
    const leaders: string[] = []
    const markers = shown.filter((part) => current.has(part.entityId)).sort(compareNumber).map((part) => {
      const index = drawingIndexes.get(part.number)!, w = String(index).length * 8 + 12, h = 20
      const center = project(part.box.center)
      const px = 30 + (center[0] - minX) * scale, py = 30 + (center[1] - minY) * scale
      let chosen = { x: px - w / 2, y: py - h / 2, w, h }, best = Infinity
      for (let ring = 0; ring <= 12; ring++) for (let direction = 0; direction < (ring ? 12 : 1); direction++) {
        const angle = direction * Math.PI / 6
        const candidate = {
          x: Math.max(4, Math.min(756 - w, px + Math.cos(angle) * ring * 22 - w / 2)),
          y: Math.max(4, Math.min(516 - h, py + Math.sin(angle) * ring * 22 - h / 2)), w, h,
        }
        const overlap = occupied.reduce((sum, other) => sum
          + Math.max(0, Math.min(candidate.x + w + 3, other.x + other.w + 3) - Math.max(candidate.x - 3, other.x - 3))
          * Math.max(0, Math.min(candidate.y + h + 3, other.y + other.h + 3) - Math.max(candidate.y - 3, other.y - 3)), 0)
        const score = overlap * 10000 + Math.hypot(candidate.x + w / 2 - px, candidate.y + h / 2 - py)
        if (score < best) { chosen = candidate; best = score }
      }
      occupied.push(chosen)
      const x = chosen.x + w / 2, y = chosen.y + h / 2
      leaders.push(`<path d="M${dimension(px)},${dimension(py)} L${dimension(x)},${dimension(y)}"/>`)
      return `<a class="marker" href="#part-${escapeHtml(part.number)}" data-drawing-index="${index}" data-marker-number="${escapeHtml(part.number)}"><title>${escapeHtml(part.number)}</title><rect x="${dimension(chosen.x)}" y="${dimension(chosen.y)}" width="${w}" height="${h}" rx="6"/><text x="${dimension(x)}" y="${dimension(y + 4)}">${index}</text></a>`
    }).join('')
    return `<svg viewBox="0 0 760 520" role="img" aria-label="${escapeHtml(label)}" xmlns="http://www.w3.org/2000/svg">
      <title>${escapeHtml(label)}</title>${ordered.map((part) => {
        const points = obbCorners(part.box).map(project)
        const polygons = faces.filter((face) => {
          const axis = part.box.axes[face.axis]
          return (axis.x + axis.y + axis.z) * face.side > 1e-9
        }).map((face) => `<polygon class="face-${face.axis}" points="${face.corners.map((index) => at(points[index])).join(' ')}"/>`).join('')
        return `<a href="#part-${escapeHtml(part.number)}" class="${current.has(part.entityId) ? 'current' : 'previous'}" data-part-number="${escapeHtml(part.number)}"><title>${escapeHtml(part.number)} · ${escapeHtml(part.label)} · ${escapeHtml(part.dimensions)}</title>${polygons}</a>`
      }).join('')}${references.map(referenceSvg).join('')}<g class="marker-leaders">${leaders.join('')}</g>${markers}
      <g class="axes" transform="translate(665,450)"><path d="M0,0 l48,28 M0,0 l-48,28 M0,0 v-50"/><text x="52" y="35">X</text><text x="-62" y="35">Z</text><text x="-5" y="-58">Y</text></g>
    </svg>`
  }
  const header = (labels: string[]) => `<thead><tr>${labels.map((label) => `<th>${escapeHtml(label)}</th>`).join('')}</tr></thead>`
  const indexedNumber = (number: string) => `${drawingIndexes.has(number) ? `<b class="drawing-index" data-index="${drawingIndexes.get(number)}">${drawingIndexes.get(number)}</b> ` : ''}${escapeHtml(number)}`
  const partLink = (number: string) => `<a href="#part-${escapeHtml(number)}">${indexedNumber(number)}</a>`
  const row = (cells: string[]) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`
  const numbers = (list: string[], anchor = false) => list.map((number) => anchor
    ? `<span id="part-${escapeHtml(number)}">${indexedNumber(number)}</span>` : partLink(number)).join('<br>') || '—'
  const partTable = (selected: IllustratedPart[]) => `<table>${header([t.number, t.item, t.specification])}<tbody>${selected.map((part) =>
    row([partLink(part.number), escapeHtml(part.label), escapeHtml(part.dimensions)])).join('')}</tbody></table>`
  const legend = `<p class="legend"><span class="key current-key"></span>${t.current}<span class="key previous-key"></span>${t.previous}<span class="key reference-key"></span>${t.equipment}</p>`
  const bom = buildBom(profiles, connectors, trims, language, panels, fittings)
  const materialRows = (rows: BomRow[]) => rows.map((part) => row([
    numbers(part.partNumbers, true), escapeHtml(part.label),
    escapeHtml(`${part.spec}${part.length === undefined ? '' : ` · ${size(part.length)}`}`), String(part.qty),
  ])).join('')
  const materialTable = (rows: BomRow[]) => `<table>${header([t.number, t.item, t.specification, t.quantity])}<tbody>${materialRows(rows)}</tbody></table>`
  const nesting = nestProfiles(bom.profiles, stockLength)
  const stockCounts = new Map<string, number>()
  const cutRows = nesting.bars.map((bar) => {
    const index = (stockCounts.get(bar.spec) ?? 0) + 1
    stockCounts.set(bar.spec, index)
    return row([escapeHtml(`${bar.spec} / ${index}`), numbers(bar.partNumbers),
      bar.cuts.map((cut) => escapeHtml(size(cut))).join('<br>'), escapeHtml(size(bar.remainder))])
  }).join('')
  const stepIds = (step: Step) => [...step.profiles, ...step.connectors, ...step.panels, ...step.fittings]
  const installed = new Set<string>()
  const instructions = steps.map((step) => {
    const current = new Set(stepIds(step))
    for (const id of current) installed.add(id)
    const heading = `${t.step}${step.n}${t.stepEnd}`
    return `<section class="assembly-step" data-step="${step.n}"><h2>${heading}</h2>${legend}<div class="step-layout"><figure>${diagram(parts.filter((part) => installed.has(part.entityId)), current, heading)}</figure>${partTable(parts.filter((part) => current.has(part.entityId)))}</div></section>`
  }).join('\n')
  return `<!doctype html>
<html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f1f5f9;color:#172033;font:14px/1.5 system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:32px;background:white}h1{font-size:28px;margin:0 0 12px}h2{font-size:22px;margin:0 0 16px}h3{font-size:16px;margin:24px 0 8px}p{margin:8px 0;color:#475569}section{padding:28px 0;border-top:1px solid #cbd5e1}figure{margin:0;min-width:0}svg{display:block;width:100%;height:auto;background:#f8fafc;border:1px solid #e2e8f0}svg polygon{stroke:#475569;stroke-width:.65;stroke-linejoin:round}.current polygon{fill:#5eead4}.current .face-0{fill:#2dd4bf}.current .face-1{fill:#ccfbf1}.previous polygon{fill:#e2e8f0;stroke:#94a3b8}.previous .face-0{fill:#cbd5e1}.previous .face-1{fill:#f1f5f9}svg a:hover polygon{fill:#fbbf24}.reference path{fill:none;stroke:#8b5cf6;stroke-width:1.1;stroke-dasharray:5 4}.marker-leaders path{stroke:#0f766e;stroke-width:.8;fill:none}.marker rect{fill:white;stroke:#0f766e;stroke-width:1.2}.marker text{text-anchor:middle;fill:#115e59;font:700 13px system-ui,sans-serif}.drawing-index{display:inline-block;min-width:19px;border:1px solid #0f766e;border-radius:5px;padding:0 3px;text-align:center;color:#115e59}.axes path{stroke:#64748b;fill:none}.axes text{font-size:17px;fill:#64748b}.step-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px;align-items:start}.legend{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;margin-bottom:14px}.key{display:inline-block;width:18px;height:12px;margin-left:10px}.key:first-child{margin-left:0}.current-key{background:#5eead4}.previous-key{background:#cbd5e1}.reference-key{border:1px dashed #8b5cf6}table{border-collapse:collapse;width:100%;font-size:12px;table-layout:fixed}th,td{border:1px solid #cbd5e1;padding:7px;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#e2e8f0}td span{scroll-margin-top:20px}a{color:#0f766e;text-decoration:none}a:hover{text-decoration:underline}:target{background:#fef08a}thead{display:table-header-group}tr{break-inside:avoid}.warning{color:#92400e}.overview figure{max-width:780px;margin:auto}.summary{font-weight:600}@media(max-width:760px){main{padding:18px}.step-layout{grid-template-columns:1fr}}@media print{@page{size:A4 landscape;margin:12mm}body{background:white;font-size:11px}main{padding:0;max-width:none}h1{font-size:22px}h2{font-size:18px}section{padding:12px 0;border:0}.assembly-step,.materials,.cutting{break-before:page}.step-layout{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}figure{break-inside:avoid}table{font-size:10px}th,td{padding:5px}svg{max-height:150mm}.overview svg{max-height:115mm}a{color:inherit}.key,polygon,th{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${t.limits}</p><p>${t.geometry}</p><p>${t.numbering}</p>
<section class="overview"><h2>${t.overview}</h2><figure>${diagram(parts, new Set(parts.map((part) => part.entityId)), t.overview)}</figure>${parts.length ? '' : `<p>${t.empty}</p>`}</section>
<section class="materials"><h2>${t.materials}</h2>${materialTable([...bom.profiles, ...bom.connectors, ...bom.fasteners, ...bom.panels])}${bom.suggested.length ? `<h3>${t.suggested}</h3><p>${t.inferred}</p>${materialTable(bom.suggested)}` : ''}</section>
<section class="cutting"><h2>${t.cutting}</h2><p>${t.stock}: ${escapeHtml(size(stockLength))}</p>${cutRows ? `<table>${header([t.bar, t.number, t.cut, t.offcut])}<tbody>${cutRows}</tbody></table><p class="summary">${t.total}: ${nesting.totalBars}</p>` : `<p>${t.noCuts}</p>`}${nesting.unsatisfied.length ? `<h3 class="warning">${t.unavailable}</h3><table>${header([t.number, t.specification, t.quantity])}<tbody>${nesting.unsatisfied.map((item) => row([numbers(item.partNumbers), escapeHtml(`${item.spec} · ${size(item.length)}`), String(item.qty)])).join('')}</tbody></table>` : ''}</section>
${instructions || `<section><h2>${t.steps}</h2><p>${t.empty}</p></section>`}</main></body></html>`
}
