import { memo, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useSettledDocument } from '../store/useSettledDocument'
import { useToolStore } from '../store/useToolStore'
import { useViewStore } from '../store/useViewStore'
import { useInspectionStore } from '../store/useInspectionStore'
import { inspectDocument, type InspectionIssue } from '../utils/inspectionIssues'
import { partNumber } from '../utils/partNumbers'
import AutoConnectReport from './AutoConnectReport'
import ManufacturingPanel from './ManufacturingPanel'

const labels = {
  zh: { collision: '零件相交', 'equipment-body': '设备与零件相交', 'equipment-clearance': '设备预留空间被占用',
    joint: '接头规格不匹配', connector: '连接件未正确贴合安装面', runner: '滑轨缺少连续安装面',
    shelf: '板边未确认承托或固定', swing: '门或抽屉运动范围相交' },
  en: { collision: 'Parts intersect', 'equipment-body': 'Equipment intersects a part', 'equipment-clearance': 'Equipment clearance obstructed',
    joint: 'Incompatible joint', connector: 'Connector does not fit its mounting faces', runner: 'Runner has no continuous mounting surface',
    shelf: 'Board edge lacks confirmed support or fastening', swing: 'Door or drawer movement overlaps' },
}

function InspectionPanel() {
  const doc = useSettledDocument()
  const { language, transforming } = useToolStore(useShallow(s => ({ language: s.language, transforming: s.isDragging || !!s.resize || !!s.rotationGesture })))
  const zh = language === 'zh'
  const stable = doc
  const issues = useMemo(() => inspectDocument(stable),
    [stable.profiles, stable.connectors, stable.panels, stable.fittings, stable.equipment, stable.throughRule])
  const [filter, setFilter] = useState<InspectionIssue['kind'] | 'all'>('all')
  const locate = (issue: InspectionIssue) => {
    const tools = useToolStore.getState()
    tools.putDown(); tools.cancelDraw()
    tools.setSection(null); tools.setBuildStep(null)
    useToolStore.setState({ showFittings: true })
    useViewStore.getState().reveal(issue.ids)
    doc.selectItems(issue.ids)
    useInspectionStore.getState().focusAt(issue.position)
  }
  const number = (id: string) => {
    const kind = doc.profiles.some(p => p.id === id) ? 'profile' : doc.connectors.some(p => p.id === id) ? 'connector'
      : doc.panels.some(p => p.id === id) ? 'panel' : doc.fittings.some(p => p.id === id) ? 'fitting' : null
    return kind ? partNumber(kind, id) : id
  }
  return <section data-testid="inspection-panel" className="space-y-3 text-xs">
    <div className="flex items-center justify-between gap-2">
      <h2 className="font-semibold">{zh ? '装配检查' : 'Assembly checks'} · {issues.length}</h2>
      <select aria-label={zh ? '问题类型' : 'Issue type'} value={filter} onChange={e => setFilter(e.target.value as typeof filter)} className="min-w-0 max-w-40 rounded bg-slate-800 p-1.5">
        <option value="all">{zh ? '全部问题' : 'All issues'}</option>
        {Object.entries(labels[language]).map(([key, value]) => <option key={key} value={key}>{value}</option>)}
      </select>
    </div>
    <p className="text-slate-400">{transforming ? (zh ? '松开鼠标后更新检查。' : 'Checks update on release.')
      : (zh ? '点击问题定位；修改后更新，撤销后重新检查。' : 'Select an issue to locate it. Checks update after edits and undo.')}</p>
    {!issues.length && <p className="text-emerald-300">{zh ? '未发现上述几何问题。' : 'No issues found by these geometry checks.'}</p>}
    {issues.filter(i => filter === 'all' || i.kind === filter).map(issue => <button type="button" key={issue.key} data-testid="inspection-issue" disabled={transforming} onClick={() => locate(issue)}
      className="block w-full rounded border border-slate-700 bg-slate-900 p-2 text-left enabled:hover:border-cyan-500 disabled:opacity-60 focus-visible:outline-cyan-400">
      <span className="block text-amber-300">{labels[language][issue.kind]}</span>
      <span className="mt-1 block break-words text-slate-300">{issue.ids.map(number).join(' + ')}</span>
      {issue.detail && <span className="block text-slate-400">{issue.kind === 'connector'
        ? ({ 'off-seat': zh ? '安装孔偏离槽位' : 'Mounting holes miss slots', 'wrong-series': zh ? '槽系列不匹配' : 'Slot series mismatch', 'no-joint': zh ? '缺少有效支承面' : 'No valid support faces' }[issue.detail] ?? issue.detail)
        : issue.kind === 'runner' ? (issue.detail === 'left' ? (zh ? '左侧' : 'Left side') : (zh ? '右侧' : 'Right side')) : issue.detail}</span>}
    </button>)}
    <AutoConnectReport />
    <ManufacturingPanel document={stable} zh={zh} />
  </section>
}

export default memo(InspectionPanel)
