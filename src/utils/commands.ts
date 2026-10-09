import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { copySelected, pasteCopied, hasCopiedParts, duplicateSelected, mirrorSelected, rotateSelected, selectAll, selectConnected, selectionLocked } from './editOps'
import { reportEditResult } from './editFeedback'
import { transformGestureActive } from './transformGesture'

export type CommandId = string

type Text = readonly [zh: string, en: string]
type Command = {
  id: string
  label: Text | (() => Text)
  keys?: readonly string[]
  edit?: boolean
  idle?: boolean
  selection?: 'any' | 'unlocked'
  unavailable?: () => Text | null
  run: () => unknown
}
const pick = (text: Text) => text[useToolStore.getState().language === 'zh' ? 0 : 1]
const parts = () => { const s = useStore.getState(); return [...s.profiles, ...s.connectors, ...s.panels, ...s.fittings, ...s.equipment] }
const selected = () => { const ids = new Set(useStore.getState().selectedIds); return parts().filter(p => ids.has(p.id)) }
const event = (name: string, detail: string) => window.dispatchEvent(new CustomEvent(name, { detail }))
const file = (id: string, label: Text, keys: string[]): Command => ({ id, label, keys, run: () => event('aluframe:project-command', id) })

/** Menus, shortcut dispatch, search and help use the same labels and availability. */
export const commands: readonly Command[] = [
  file('open', ['打开工程…', 'Open project…'], ['Mod+O']),
  file('save', ['保存…', 'Save…'], ['Mod+S']),
  file('save-as', ['另存为…', 'Save as…'], ['Mod+Shift+S']),
  { id: 'undo', label: ['撤销', 'Undo'], keys: ['Mod+Z'], edit: true,
    unavailable: () => useStore.getState().past.length ? null : ['没有可撤销的操作', 'Nothing to undo'],
    run: () => { useToolStore.getState().cancelDraw(); useStore.getState().undo() } },
  { id: 'redo', label: ['重做', 'Redo'], keys: ['Mod+Shift+Z', 'Mod+Y'], edit: true,
    unavailable: () => useStore.getState().future.length ? null : ['没有可重做的操作', 'Nothing to redo'],
    run: () => { useToolStore.getState().cancelDraw(); useStore.getState().redo() } },
  { id: 'copy', label: ['复制选中件', 'Copy selection'], keys: ['Mod+C'], idle: true, selection: 'any', run: copySelected },
  { id: 'paste', label: ['粘贴副本', 'Paste parts'], keys: ['Mod+V'], idle: true, edit: true,
    unavailable: () => hasCopiedParts() ? null : ['请先复制零件', 'Copy parts first'], run: pasteCopied },
  { id: 'duplicate', label: ['创建副本', 'Duplicate selection'], keys: ['Mod+D'], idle: true, edit: true, selection: 'any', run: duplicateSelected },
  { id: 'delete', label: ['删除选中件', 'Delete selection'], keys: ['Delete', 'Backspace'], idle: true, edit: true, selection: 'unlocked',
    run: () => reportEditResult(useStore.getState().removeSelected()) },
  { id: 'select-all', label: ['全选', 'Select all'], keys: ['Mod+A'], run: selectAll },
  { id: 'clear-selection', label: ['取消全选', 'Clear selection'], keys: ['Mod+Shift+A'], run: () => useStore.getState().clearSelection() },
  { id: 'connected', label: ['选择连通构件', 'Select connected parts'], idle: true, selection: 'any',
    run: () => selectConnected(useStore.getState().selectedIds[0]) },
  { id: 'lock', label: () => selectionLocked(useStore.getState(), useStore.getState().selectedIds) ? ['解锁选中件', 'Unlock selection'] : ['锁定选中件', 'Lock selection'],
    keys: ['L'], idle: true, edit: true, selection: 'any', run: () => useStore.getState().toggleLockSelected() },
  { id: 'pivot', label: ['切换旋转支点', 'Cycle rotation pivot'], keys: ['P'], idle: true, run: () => useToolStore.getState().cyclePivotMode() },
  ...(['x', 'y', 'z'] as const).flatMap(axis => [
    ...([90, -90] as const).map(degrees => ({ id: `rotate-${axis}${degrees < 0 ? '-back' : ''}`, label: [`绕 ${axis.toUpperCase()} 轴旋转 ${degrees}°`, `Rotate ${degrees}° around ${axis.toUpperCase()}`] as Text,
      idle: true, edit: true, selection: 'unlocked' as const, run: () => rotateSelected(axis, degrees) })),
    { id: `mirror-${axis}`, label: [`沿 ${axis.toUpperCase()} 轴镜像复制`, `Mirror copy on ${axis.toUpperCase()}`] as Text,
      idle: true, edit: true, selection: 'any' as const, run: () => mirrorSelected(axis) },
  ]),
  { id: 'fit', label: ['适配选中内容或整图', 'Fit selection or all'], keys: ['F'],
    run: () => useToolStore.getState().triggerCameraReset(useStore.getState().selectedIds.length ? 'selection' : 'all') },
  { id: 'fit-all', label: ['适配整图', 'Fit all'], run: () => useToolStore.getState().triggerCameraReset('all') },
  ...(['top', 'front', 'right', 'iso'] as const).map((view, index) => ({ id: `view-${view}`,
    label: ([['俯视', 'Top view'], ['正视', 'Front view'], ['右视', 'Right view'], ['等轴测', 'Isometric view']] as const)[index],
    run: () => useToolStore.getState().setCameraView(view) })),
  { id: 'view-mode', label: () => useToolStore.getState().viewMode ? ['切换到编辑模式', 'Switch to edit mode'] : ['切换到查看模式', 'Switch to view mode'],
    keys: ['V'], run: () => { const t = useToolStore.getState(); t.setViewMode(!t.viewMode) } },
  { id: 'labels', label: ['显示 / 隐藏尺寸', 'Toggle dimensions'], run: () => useToolStore.getState().toggleDimensionLabels() },
  { id: 'part-numbers', label: ['显示 / 隐藏零件编号', 'Toggle part numbers'], run: () => useToolStore.getState().togglePartNumbers() },
  { id: 'help', label: ['快捷键帮助', 'Keyboard help'], run: () => useToolStore.getState().toggleHelp() },
]

export function commandLabel(command: Command): string { return pick(typeof command.label === 'function' ? command.label() : command.label) }
export function commandReason(command: Command): string | null {
  const tool = useToolStore.getState()
  if (!['open', 'save', 'save-as'].includes(command.id) && (transformGestureActive() || tool.isDragging || tool.resize || tool.rotationGesture))
    return pick(['请先结束当前拖动', 'Finish the current drag first'])
  if (command.edit && tool.viewMode) return pick(['查看模式不可编辑', 'Switch to edit mode first'])
  if (command.idle && (tool.isDrawing || tool.pendingRotate)) return pick(['请先完成或取消当前操作', 'Finish or cancel the current operation first'])
  if (command.selection) {
    const selection = selected()
    if (!selection.length) return pick(['请先选择零件', 'Select parts first'])
    if (command.selection === 'unlocked' && selection.every(p => p.locked)) return pick(['选中件已全部锁定', 'All selected parts are locked'])
  }
  const reason = command.unavailable?.()
  return reason ? pick(reason) : null
}
export function runCommand(id: string): boolean {
  const command = commands.find(c => c.id === id)
  if (!command || commandReason(command)) return false
  command.run()
  return true
}
export function commandShortcut(id: string, mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)): string {
  return commands.find(c => c.id === id)?.keys?.map(key => key.replace('Mod+', mac ? '⌘+' : 'Ctrl+')).join(' / ') ?? ''
}
export function keyCommand(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): string | undefined {
  if (event.altKey) return
  const chord = `${event.ctrlKey || event.metaKey ? 'Mod+' : ''}${event.shiftKey ? 'Shift+' : ''}${event.key.length === 1 ? event.key.toUpperCase() : event.key}`
  // Shift also capitalizes unmodified letter shortcuts, except commands explicitly using Shift.
  return commands.find(c => c.keys?.includes(chord))?.id
    ?? (!event.ctrlKey && !event.metaKey && event.key.length === 1 ? commands.find(c => c.keys?.includes(event.key.toUpperCase()))?.id : undefined)
}
export function searchCommands(query: string): readonly Command[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return commands.filter(command => {
    const labels = typeof command.label === 'function' ? command.label() : command.label
    const text = `${labels.join(' ')} ${command.id} ${commandShortcut(command.id)}`.toLocaleLowerCase()
    return words.every(word => /^[a-z]$/.test(word)
      ? new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(text)
      : text.includes(word))
  })
}
