import { useState } from 'react'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { rejectedLocalProject, clearRejectedLocalProject } from '../utils/documentPersistence'
import { downloadText, forgetSavedFile } from '../utils/projectFile'

/** A rejected automatic save never stops the editor, and can be recovered as a file. */
export default function RecoveryNotice() {
  const [raw, setRaw] = useState(rejectedLocalProject)
  const language = useToolStore((s) => s.language)
  if (raw === null) return null
  const zh = language === 'zh'
  return <div role="alert" data-testid="recovery-notice" className="shrink-0 flex flex-wrap items-center gap-3 bg-amber-950 px-4 py-2 text-xs text-amber-100">
    <span>{zh ? '本地工程数据无法读取，原始数据已保留。' : 'The local project could not be read. Its original data has been kept.'}</span>
    <button className="underline p-2" onClick={() => downloadText('aluframe-recovery.json', raw, 'application/json')}>
      {zh ? '下载原始数据' : 'Download original data'}
    </button>
    <button className="underline p-2" onClick={() => {
      useStore.getState().loadDocument({ profiles: [], connectors: [], panels: [], fittings: [], throughRule: 'rails' })
      useStore.persist.clearStorage()
      clearRejectedLocalProject()
      forgetSavedFile()
      setRaw(null)
    }}>{zh ? '开始新工程' : 'Start a new project'}</button>
  </div>
}
