import { useMemo, useState } from 'react'
import type { ProjectDocument } from '../utils/document'
import { documentBoards, nestPanels, panelHolesCsv, panelLayoutCsv, type SheetOptions } from '../utils/panelNesting'
import { downloadText } from '../utils/projectFile'

export default function ManufacturingPanel({ document, zh }: { document: ProjectDocument; zh: boolean }) {
  const [options, setOptions] = useState<SheetOptions>({ width: 2440, height: 1220, kerf: 3, margin: 10, rotate: false })
  const [selected, setSelected] = useState(0)
  const boards = useMemo(() => documentBoards(document), [document.panels, document.fittings, document.connectors])
  const result = useMemo(() => {
    try { return nestPanels(boards, options) } catch { return null }
  }, [boards, options])
  const sheetIndex = Math.min(selected, Math.max(0, (result?.sheets.length ?? 1) - 1))
  const sheet = result?.sheets[sheetIndex]
  const holeCount = boards.reduce((n, b) => n + b.holes.length, 0)
  if (!boards.length) return null
  const fields = [
    ['width', zh ? '原板宽' : 'Stock width'], ['height', zh ? '原板高' : 'Stock height'],
    ['kerf', zh ? '锯缝' : 'Saw kerf'], ['margin', zh ? '边距' : 'Edge margin'],
  ] as const
  return <details className="rounded border border-slate-700 p-2 text-xs" data-testid="panel-cut-plan">
    <summary className="cursor-pointer font-semibold">{zh ? '板材下料' : 'Panel cutting'} · {boards.length}</summary>
    <div className="mt-3 grid grid-cols-2 gap-2">
      {fields.map(([key, label]) => <label key={key} className="block text-slate-300">{label} · mm
        <input aria-label={label} type="number" min={key === 'width' || key === 'height' ? 1 : 0} value={Number.isFinite(options[key]) ? options[key] : ''}
          onChange={e => setOptions({ ...options, [key]: e.currentTarget.valueAsNumber })}
          className="mt-1 block w-full rounded bg-slate-800 p-1.5" />
      </label>)}
    </div>
    <label className="my-3 flex items-center gap-2"><input type="checkbox" checked={options.rotate} onChange={e => setOptions({ ...options, rotate: e.target.checked })} />
      {zh ? '允许板材旋转 90°（确认纹理方向后开启）' : 'Allow 90° rotation (check grain direction first)'}</label>
    {!result && <p role="alert" className="text-amber-300">{zh ? '请输入有效尺寸，边距不能超过原板短边的一半。' : 'Enter valid dimensions; margins must leave usable sheet area.'}</p>}
    {result && <>
      <p className="my-2 text-slate-300">{zh ? '分材质、厚度排版' : 'Grouped by material and thickness'} · {result.sheets.length} {zh ? '张' : 'sheets'} · {Math.round(result.utilization * 100)}%</p>
      {sheet && <>
        <select aria-label={zh ? '查看原板' : 'View stock sheet'} value={sheetIndex} onChange={e => setSelected(Number(e.target.value))} className="mb-2 w-full rounded bg-slate-800 p-1.5">
          {result.sheets.map((s, i) => <option key={i} value={i}>{i + 1} · {s.material} · {s.thickness} mm</option>)}
        </select>
        <svg role="img" aria-label={zh ? '板材排版预览' : 'Panel layout preview'} viewBox={`0 0 ${options.width} ${options.height}`} className="w-full rounded bg-slate-800">
          {sheet.placements.map((p, i) => <g key={p.board.id}><title>{p.board.id} · {p.width} × {p.height} mm</title>
            <rect x={p.x} y={p.y} width={p.width} height={p.height} fill={i % 2 ? '#155e75' : '#1e40af'} stroke="#94a3b8" strokeWidth={3} />
            <text x={p.x + p.width / 2} y={p.y + p.height / 2} textAnchor="middle" dominantBaseline="central" fill="white" fontSize={Math.min(50, p.width / 3, p.height / 2)}>{i + 1}</text>
          </g>)}
        </svg>
        <ol className="my-2 space-y-1 text-slate-400">{sheet.placements.map((p, i) => <li key={p.board.id} className="break-all">{i + 1}. {p.board.id} · {p.width} × {p.height}{p.rotated ? ' ↻90°' : ''}</li>)}</ol>
      </>}
      {result.oversized.length > 0 && <p role="alert" className="my-2 break-words text-amber-300">{zh ? '超出原板，未排入：' : 'Too large for stock: '}{result.oversized.map(b => b.id).join(', ')}</p>}
      <p className="my-2 text-slate-400">{zh ? '直切排版草案；排版坐标从原板左上角计量。锯缝和边距按输入值计算，不保证用料最少。' : 'Guillotine layout measured from the stock sheet’s upper-left corner, with the entered kerf and margins; not guaranteed optimal.'}</p>
      <button className="rounded bg-slate-700 px-3 py-2 hover:bg-slate-600" onClick={() => downloadText('panel-layout.csv', '\uFEFF' + panelLayoutCsv(result, options), 'text/csv;charset=utf-8;')}>{zh ? '导出板材排版 CSV' : 'Export panel layout CSV'}</button>
    </>}
    <p className="my-2 text-slate-400">{zh ? `已有板材固定通孔 ${holeCount} 个。孔坐标从各板局部左下角计量；不包含铰链、滑轨等尚未定义的加工孔。` : `${holeCount} defined panel mounting through-holes. Coordinates start at each board’s local lower-left corner; undefined hinge and runner holes are excluded.`}</p>
    <button disabled={!holeCount} className="rounded bg-slate-700 px-3 py-2 hover:bg-slate-600 disabled:opacity-40" onClick={() => downloadText('panel-holes.csv', '\uFEFF' + panelHolesCsv(boards), 'text/csv;charset=utf-8;')}>{zh ? '导出已有板孔 CSV' : 'Export defined panel holes CSV'}</button>
  </details>
}
