/** Generate fastened inset shelves and flush exterior boards in the public examples. */
import fs from 'node:fs'
import { parseProjectDocument } from '../src/utils/document'
import { useStore } from '../src/store/useStore'
import { autoConnect } from '../src/utils/autoConnect'
import { attachPanels } from '../src/utils/attachPanels'
import { setThroughRule } from '../src/utils/jointUtils'
import { createConnectorPlacementValidator } from '../src/utils/connectorPlacement'
import { unfastenedPanels } from '../src/utils/panelFastening'

const files = ['examples', 'examples/flat'].flatMap(dir => fs.readdirSync(dir)
  .filter(name => name.endsWith('.json') && name !== 'connector-demo.json').map(name => `${dir}/${name}`)).sort()
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  const indent = text.match(/\n( +)\"/)?.[1].length ?? 2
  const raw = JSON.parse(text)
  const doc = parseProjectDocument(raw)
  setThroughRule(doc.throughRule)
  for (const panel of doc.panels) {
    const bearings = doc.profiles.filter(p => p.id.startsWith(`${panel.id}-bearing-`))
    if (!bearings.length) continue
    // Bring the board into the existing surrounding frame, removing its separate bearing subframe.
    panel.position[1] -= bearings[0].spec === '3030' ? 24 : 19
  }
  doc.profiles = doc.profiles.filter(p => !p.id.includes('-bearing-'))
  const validate = createConnectorPlacementValidator(doc.profiles, doc)
  doc.connectors = doc.connectors.filter(c => validate(c, []).allowed)
  useStore.getState().loadDocument(doc)
  autoConnect('inside-corner')
  const oldIds = new Set(doc.connectors.map(c => c.id))
  let n = 0
  const stem = file.split('/').pop()!.replace('.json', '')
  const ids = new Set([...doc.profiles, ...doc.panels, ...doc.connectors, ...doc.fittings, ...(doc.equipment ?? [])].map(p => p.id))
  const id = () => { let value: string; do { value = `${stem}-fastener-${++n}` } while (ids.has(value)); ids.add(value); return value }
  doc.connectors = useStore.getState().connectors.map(c => oldIds.has(c.id) ? c : { ...c, id: id() })
  const result = attachPanels(doc, doc.panels.map(p => p.id), id)
  doc.connectors.push(...result.made)
  const unfixed = unfastenedPanels(doc)
  const mounts = doc.panels.map(p => ({ id: p.id, count: doc.connectors.filter(c => c.panelMount?.panelId === p.id).length }))
  console.log(file, JSON.stringify({ added: result.made.length, blocked: result.blocked, unsupported: result.unsupported, unfixed: unfixed, mounts }))
  if (unfixed.length || mounts.some(m => m.count < 4)) throw new Error(`Unfastened boards in ${file}`)
  if (JSON.stringify(raw.profiles) !== JSON.stringify(doc.profiles) || JSON.stringify(raw.panels) !== JSON.stringify(doc.panels)
    || JSON.stringify(raw.connectors) !== JSON.stringify(doc.connectors))
    fs.writeFileSync(file, JSON.stringify({ ...raw, ...doc, version: 10 }, null, indent) + '\n')
}
