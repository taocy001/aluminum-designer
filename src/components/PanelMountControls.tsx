import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { attachPanels } from '../utils/attachPanels'

export default function PanelMountControls() {
  const state = useStore()
  const { language, showToast, viewMode } = useToolStore()
  const zh = language === 'zh'
  const ids = state.panels.filter((p) => state.selectedIds.includes(p.id)).map((p) => p.id)
  if (!ids.length) return null
  const install = () => {
    const doc = useStore.getState()
    const result = attachPanels(doc, ids, () => `c-${crypto.randomUUID()}`)
    if (result.made.length) {
      const edit = doc.addItems([], result.made)
      if (edit.status !== 'applied') return
    }
    showToast(zh
      ? `添加 ${result.made.length} 处板材固定；已有 ${result.existing}，受阻 ${result.blocked}，无适配位置的板材 ${result.unsupported}`
      : `Added ${result.made.length} board mounts; ${result.existing} existing, ${result.blocked} blocked, ${result.unsupported} boards without seats`,
    result.made.length ? 'success' : 'info')
  }
  return <div className="mt-2 space-y-1">
    <button onClick={install} disabled={viewMode} className="w-full rounded border border-white/10 px-2 py-1.5 text-xs hover:bg-white/10 disabled:opacity-40">
      {zh ? '固定所选层板' : 'Attach selected shelves'}
    </button>
    <p className="text-[10px] leading-relaxed text-slate-400">
      {zh ? '适配水平木板与 B6 横梁；连接板安装在下方，按间距配垫套。板材需钻 Ø5.5 通孔，用 M5 穿栓、垫圈及螺母固定。不会移动板材。'
        : 'Horizontal wood shelves and B6 rails: plates underneath with cut spacers. Drill Ø5.5 through holes for M5 bolts, washers and nuts. Board positions are preserved.'}
    </p>
  </div>
}
