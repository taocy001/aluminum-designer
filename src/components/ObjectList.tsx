import { useShallow } from 'zustand/react/shallow'
import { useSettledDocument } from '../store/useSettledDocument'
import { memo, useEffect, useMemo, useState } from 'react'
import { Eye, EyeOff, LocateFixed, Focus, RotateCcw, Search, Group, Pencil, Ungroup } from 'lucide-react'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { useViewStore, isObjectVisible } from '../store/useViewStore'
import { partNumber } from '../utils/partNumbers'
import { connectorEntry } from '../utils/connectorCatalog'
import { createSelectedGroup, renameGroup, dissolveGroup } from '../utils/groupOps'
import { cancelActiveTransformGesture } from '../utils/transformGesture'
import { projectSession } from '../utils/projectSession'

function ObjectList() {
  const { profiles, connectors, panels, fittings, equipment, groups, selectedIds, selectItem, selectItems } = useSettledDocument()
  const { language, viewMode, putDown, triggerCameraReset } = useToolStore(useShallow(s => ({ language: s.language, viewMode: s.viewMode, putDown: s.putDown, triggerCameraReset: s.triggerCameraReset })))
  const { hiddenIds, isolatedIds, hide, reveal, isolate, restoreAll } = useViewStore()
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('all')
  const [groupEdit, setGroupEdit] = useState<{ id: string | null; name: string } | null>(null)
  useEffect(() => {
    let id = projectSession.getState().id
    return projectSession.subscribe(() => {
      const next = projectSession.getState().id
      if (next !== id) { id = next; setGroupEdit(null); setQuery(''); setKind('all') }
    })
  }, [])
  const zh = language === 'zh'
  const rows = useMemo(() => [
    ...profiles.map(p => ({ id: p.id, kind: 'profile', number: partNumber('profile', p.id), name: zh ? '型材' : 'Profile', spec: `${p.spec} · ${Math.round(p.length)} mm` })),
    ...connectors.map(c => { const entry = connectorEntry(c.type); return { id: c.id, kind: 'connector', number: partNumber('connector', c.id), name: (zh ? entry?.labelZh : entry?.labelEn) ?? c.type, spec: `${c.series ?? 20} ${zh ? '系列' : 'series'}` } }),
    ...panels.map(p => ({ id: p.id, kind: 'panel', number: partNumber('panel', p.id), name: zh ? '板材' : 'Panel', spec: `${p.material} · ${p.width} × ${p.height} × ${p.thickness}` })),
    ...fittings.map(f => ({ id: f.id, kind: 'fitting', number: partNumber('fitting', f.id), name: f.kind === 'door' ? (zh ? '门' : 'Door') : (zh ? '抽屉' : 'Drawer'), spec: `${f.width} × ${f.height} × ${f.depth}` })),
    ...equipment.map(e => ({ id: e.id, kind: 'equipment', number: `E-${e.id}`, name: e.name, spec: `${e.width} × ${e.height} × ${e.depth}` })),
  ], [profiles, connectors, panels, fittings, equipment, zh])
  const matched = rows.filter(r => (kind === 'all' || r.kind === kind) && `${r.number} ${r.id} ${r.name} ${r.spec}`.toLowerCase().includes(query.trim().toLowerCase()))
  const revealInCanvas = (ids: string[]) => {
    cancelActiveTransformGesture()
    reveal(ids)
    const tools = useToolStore.getState()
    tools.setBuildStep(null)
    tools.setSection(null)
    if (!tools.showFittings && ids.some(id => fittings.some(f => f.id === id))) tools.toggleFittings()
  }
  const choose = (id: string, multi: boolean) => { putDown(); revealInCanvas([id]); selectItem(id, multi) }
  const chooseGroup = (memberIds: string[], multi: boolean) => {
    cancelActiveTransformGesture()
    putDown(); setQuery(''); setKind('all'); revealInCanvas(memberIds)
    const selected = useStore.getState().selectedIds
    selectItems(multi ? (memberIds.every(id => selected.includes(id))
      ? selected.filter(id => !memberIds.includes(id)) : [...new Set([...selected, ...memberIds])]) : memberIds)
  }
  const hideSelection = () => { cancelActiveTransformGesture(); hide(selectedIds); selectItems([]) }
  const disabled = selectedIds.length === 0
  return <div className="object-browser" data-testid="object-list">
    <label className="object-search"><Search size={14} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder={zh ? '搜索编号、类型、规格' : 'Search number, type, specification'} aria-label={zh ? '搜索对象' : 'Search objects'} data-testid="object-search" /></label>
    <select className="object-filter" aria-label={zh ? '对象类型' : 'Object type'} value={kind} onChange={e => setKind(e.target.value)}>
      {([['all', '全部', 'All'], ['profile', '型材', 'Profiles'], ['connector', '连接件', 'Connectors'], ['panel', '板材', 'Panels'], ['fitting', '门 / 抽屉', 'Doors / drawers'], ['equipment', '设备', 'Equipment']] as const).map(([value, cn, en]) => <option key={value} value={value}>{zh ? cn : en}</option>)}
    </select>
    <div className="object-actions">
      <button disabled={disabled} onClick={() => { revealInCanvas(selectedIds); triggerCameraReset('selection') }} title={zh ? '定位选中对象' : 'Frame selection'}><LocateFixed size={14} />{zh ? '定位' : 'Frame'}</button>
      <button disabled={disabled} onClick={hideSelection} title={zh ? '隐藏选中对象' : 'Hide selection'}><EyeOff size={14} />{zh ? '隐藏' : 'Hide'}</button>
      <button disabled={disabled} onClick={() => { cancelActiveTransformGesture(); isolate(selectedIds) }} title={zh ? '只显示选中对象' : 'Show only selection'}><Focus size={14} />{zh ? '隔离' : 'Isolate'}</button>
      <button disabled={!hiddenIds.length && !isolatedIds} onClick={() => { cancelActiveTransformGesture(); restoreAll() }} title={zh ? '恢复全部可见' : 'Show all'}><RotateCcw size={14} />{zh ? '恢复' : 'Restore'}</button>
    </div>
    <div className="object-groups">
      <div className="object-group-heading"><span>{zh ? '分组' : 'Groups'}</span><button data-testid="group-create" disabled={viewMode || selectedIds.length < 2} onClick={() => setGroupEdit({ id: null, name: zh ? `组 ${groups.length + 1}` : `Group ${groups.length + 1}` })}><Group size={14} />{zh ? '选中项成组' : 'Group selection'}</button></div>
      {groupEdit && <form className="object-group-form" onSubmit={e => {
        e.preventDefault()
        if (groupEdit.id ? renameGroup(groupEdit.id, groupEdit.name) : createSelectedGroup(groupEdit.name)) setGroupEdit(null)
      }}>
        <input autoFocus maxLength={200} aria-label={zh ? '组名称' : 'Group name'} value={groupEdit.name} onChange={e => setGroupEdit({ ...groupEdit, name: e.target.value })} />
        <button type="submit" disabled={viewMode || !groupEdit.name.trim()}>{zh ? '确定' : 'Apply'}</button><button type="button" onClick={() => setGroupEdit(null)}>{zh ? '取消' : 'Cancel'}</button>
      </form>}
      {groups.map(group => <div className="object-group-row" key={group.id} data-testid="object-group" data-group-id={group.id}>
        <button className="object-group-main" aria-pressed={group.memberIds.every(id => selectedIds.includes(id))} onClick={e => chooseGroup(group.memberIds, e.shiftKey)} onDoubleClick={() => triggerCameraReset('selection')} title={zh ? '选择整组；双击定位' : 'Select group; double-click to frame'}><Group size={14} /><span>{group.name}</span><small>{group.memberIds.length}</small></button>
        <button disabled={viewMode} title={zh ? '重命名组' : 'Rename group'} onClick={() => setGroupEdit({ id: group.id, name: group.name })}><Pencil size={13} /></button>
        <button disabled={viewMode} title={zh ? '解散组，保留零件' : 'Dissolve group, keep parts'} onClick={() => { if (dissolveGroup(group.id) && groupEdit?.id === group.id) setGroupEdit(null) }}><Ungroup size={13} /></button>
      </div>)}
    </div>
    <p className="object-count">{matched.length} / {rows.length} {zh ? '个对象 · Shift 多选' : 'objects · Shift to multiselect'}</p>
    <div role="list" aria-label={zh ? '工程对象' : 'Project objects'}>
      {matched.map(row => { const visible = isObjectVisible(row.id); const selected = selectedIds.includes(row.id); return <div role="listitem" className={`object-row ${selected ? 'is-selected' : ''} ${visible ? '' : 'is-hidden'}`} key={row.id} data-testid="object-row" data-object-id={row.id}>
        <button className="object-row-main" aria-pressed={selected} onClick={e => choose(row.id, e.shiftKey)} onDoubleClick={() => triggerCameraReset('selection')} title={`${row.number}\n${row.name} · ${row.spec}`}>
          <span className="object-number">{row.number}</span><span className="object-description">{row.name} <span>{row.spec}</span></span>
        </button>
        <button className="object-visibility" aria-label={`${visible ? (zh ? '隐藏' : 'Hide') : (zh ? '显示' : 'Show')} ${row.number}`} onClick={() => { cancelActiveTransformGesture(); if (visible) { hide([row.id]); selectItems(selectedIds.filter(id => id !== row.id)) } else revealInCanvas([row.id]) }}>{visible ? <Eye size={15} /> : <EyeOff size={15} />}</button>
      </div> })}
      {!matched.length && <p className="object-empty">{rows.length ? (zh ? '没有匹配的对象' : 'No matching objects') : (zh ? '添加零件或打开工程后，对象会显示在这里。' : 'Add parts or open a project to see its objects.')}</p>}
    </div>
  </div>
}

export default memo(ObjectList)
