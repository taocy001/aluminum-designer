import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseProjectDocument } from '../src/utils/document'
import { setThroughRule } from '../src/utils/jointUtils'
import { unflushPairs } from '../src/utils/faceAlign'
import { auditBrackets } from '../src/utils/bracketSeat'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = ['examples', 'examples/flat'].flatMap((dir) => fs.readdirSync(path.join(root, dir))
  .filter((name) => name.endsWith('.json') && name !== 'connector-demo.json').map((name) => `${dir}/${name}`)).sort()
const report = files.map((file) => {
  const doc = parseProjectDocument(JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')))
  setThroughRule(doc.throughRule)
  const invalid = auditBrackets(doc.profiles, doc.connectors)
  if (invalid.length) throw new Error(`${file}: ${JSON.stringify(invalid)}`)
  return { file, connectors: doc.connectors.length,
    unsupportedCornerPairs: unflushPairs(doc.profiles).map(({ a, b }) => [a, b].sort().join('|')).sort() }
})
fs.mkdirSync(path.join(root, 'examples/checks'), { recursive: true })
fs.writeFileSync(path.join(root, 'examples/checks/hardware.json'), JSON.stringify(report, null, 2) + '\n')
console.log(report.map(({ file, connectors, unsupportedCornerPairs }) => `${file}: ${connectors} connectors, ${unsupportedCornerPairs.length} unsupported corner pairs`).join('\n'))
