/** Rebuild the inset shelves and their hardware from the public bookcase example. */
import fs from 'node:fs'
import { parseProjectDocument } from '../src/utils/document'
import { useStore } from '../src/store/useStore'
import { autoConnect } from '../src/utils/autoConnect'
import { attachPanels } from '../src/utils/attachPanels'
import { setThroughRule } from '../src/utils/jointUtils'

const file = 'examples/bookcase-tall.json'
const source = parseProjectDocument(fs.readFileSync(file, 'utf8'))
const levels = [350, 700, 1050, 1400, 1700]
const profiles = source.profiles.filter(p => !(p.spec === '2020' && [198, 880].includes(p.length)))
  .map((p, i) => {
    const next = { ...p, id: `bookcase-profile-${i + 1}`, position: [...p.position] as typeof p.position }
    if (levels.includes(p.position[1]) && p.length === 280) next.spec = '2020'
    if (levels.includes(p.position[1]) && p.length === 880) {
      next.position = [10, p.position[1], p.position[2] < 160 ? 20 : 300]
      next.quaternion = [.5, .5, .5, .5]
    }
    return next
  })
const panels = source.panels.map((p, i) => ({ ...p, id: `bookcase-panel-${i + 1}`,
  position: [450, [355, 700, 1050, 1400, 1700][i], 160] as typeof p.position }))
setThroughRule('rails')
useStore.getState().loadDocument({ profiles, panels, connectors: [], fittings: [], equipment: [], throughRule: 'rails' })
autoConnect('inside-corner')
const connectors = useStore.getState().connectors.map((c, i) => ({ ...c, id: `bookcase-corner-${i + 1}` }))
const doc = { profiles, panels, connectors, fittings: [], equipment: [], throughRule: 'rails' as const }
let n = 0
const mounted = attachPanels(doc, panels.map(p => p.id), () => `bookcase-panel-mount-${++n}`)
if (profiles.length !== 32 || connectors.length !== 148 || mounted.made.length !== 40 || mounted.blocked || mounted.unsupported)
  throw new Error(`Unexpected bookcase layout: ${JSON.stringify({ profiles: profiles.length, connectors: connectors.length, mounted })}`)
fs.writeFileSync(file, JSON.stringify({ version: 10, ...doc, connectors: [...connectors, ...mounted.made] }, null, 2) + '\n')
console.log(`${file}: ${profiles.length} profiles, ${connectors.length} inner brackets, ${mounted.made.length} panel mounts`)
