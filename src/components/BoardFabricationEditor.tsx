import { useEffect, useState } from 'react'
import { useToolStore } from '../store/useToolStore'
import { useStore } from '../store/useStore'
import { boardBlank, DEFAULT_FABRICATION, type BoardFabrication } from '../utils/boardFabrication'
import type { CutBoard } from '../utils/panelNesting'
import { reportEditResult } from '../utils/editFeedback'
import { transformGestureActive } from '../utils/transformGesture'

export default function BoardFabricationEditor({ boards, zh }: { boards: CutBoard[]; zh: boolean }) {
  const [id, setId] = useState('')
  const board = boards.find(b => b.id === id) ?? boards[0]
  const [draft, setDraft] = useState<BoardFabrication>(DEFAULT_FABRICATION)
  const [error, setError] = useState(false)
  useEffect(() => { setDraft(board.fabrication ?? DEFAULT_FABRICATION); setError(false) }, [board.id, board.fabrication])
  const viewMode = useToolStore(s => s.viewMode)
  const locked = useStore(s => !![...s.panels, ...s.fittings].find(p => p.id === board.sourceId)?.locked)
  const apply = () => {
    if (transformGestureActive() || useToolStore.getState().viewMode) return
    try { boardBlank(board.width, board.height, draft) } catch { setError(true); return }
    const s = useStore.getState()
    const result = board.boardKey
      ? s.updateFitting(board.sourceId, { fabrication: { ...s.fittings.find(f => f.id === board.sourceId)?.fabrication, [board.boardKey]: draft } })
      : s.commitPanelEdit(board.sourceId, { fabrication: draft })
    reportEditResult(result)
    setError(result.status === 'rejected')
  }
  return <details className="my-3 border-t border-slate-700 pt-2" data-testid="board-fabrication">
    <summary className="cursor-pointer">{zh ? '纹理与封边' : 'Grain and edge bands'}</summary>
    <label className="mt-2 block">{zh ? '板件' : 'Board'}
      <select aria-label={zh ? '加工板件' : 'Fabrication board'} value={board.id} onChange={e => setId(e.target.value)} className="mt-1 w-full rounded bg-slate-800 p-1.5">
        {boards.map(b => <option key={b.id} value={b.id}>{b.id} · {b.width} × {b.height}</option>)}
      </select>
    </label>
    <fieldset disabled={locked || viewMode} className="mt-2 space-y-2 disabled:opacity-50">
      <label className="block">{zh ? '板件纹理' : 'Board grain'}
        <select aria-label={zh ? '板件纹理' : 'Board grain'} value={draft.grain} onChange={e => setDraft({ ...draft, grain: e.target.value as BoardFabrication['grain'] })} className="mt-1 w-full rounded bg-slate-800 p-1.5">
          <option value="none">{zh ? '无方向要求' : 'No direction constraint'}</option>
          <option value="x">{zh ? '沿板宽 X' : 'Along width X'}</option>
          <option value="y">{zh ? '沿板高 Y' : 'Along height Y'}</option>
        </select>
      </label>
      <div className="grid grid-cols-2 gap-2">{(zh ? ['左封边', '右封边', '下封边', '上封边'] : ['Left band', 'Right band', 'Bottom band', 'Top band']).map((label, i) => <label key={i}>{label} · mm
        <input aria-label={label} type="number" min="0" max="10" step="0.1" value={Number.isFinite(draft.bands[i]) ? draft.bands[i] : ''}
          onChange={e => { const bands = [...draft.bands] as BoardFabrication['bands']; bands[i] = e.currentTarget.valueAsNumber; setDraft({ ...draft, bands }) }} className="mt-1 w-full rounded bg-slate-800 p-1.5" />
      </label>)}</div>
      <button type="button" onClick={apply} className="rounded bg-slate-700 px-3 py-2 hover:bg-slate-600">{zh ? '应用到板件' : 'Apply to board'}</button>
    </fieldset>
    {locked && <p className="mt-2 text-amber-300">{zh ? '板件已锁定，请先解锁。' : 'Unlock the board to edit.'}</p>}
    {error && <p role="alert" className="mt-2 text-amber-300">{zh ? '未应用：请检查封边尺寸或部件锁定状态。' : 'Not applied: check band dimensions and part locks.'}</p>}
    <p className="mt-2 text-slate-400">{zh ? '按板件局部正面定义左右上下。模型尺寸为封边后成品尺寸，下料扣除相应封边厚度；0 表示不封边。' : 'Edges refer to the local front face. Model dimensions are finished sizes; cutting deducts band thickness. Zero means no band.'}</p>
  </details>
}
