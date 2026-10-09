import { useSettledDocument } from '../store/useSettledDocument'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { attachPanels } from '../utils/attachPanels'

export default function PanelMountControls() {
  const state = useSettledDocument()
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
      {zh ? '固定所选板材' : 'Attach selected panels'}
    </button>
    <p className="text-[10px] leading-relaxed text-slate-400">
      {zh ? '嵌入层板用下方连接片固定；贴合型材的背板用穿板螺栓固定。20 / 30 系列分别配 M5 / M6，板孔 Ø5.5 / Ø6.6 mm。适配 6–40 mm 木板。'
        : 'Inset shelves use plates underneath; flush back panels use through-bolts. Series 20 / 30 use M5 / M6 with Ø5.5 / Ø6.6 mm holes. For 6–40 mm wood boards.'}
    </p>
  </div>
}
