import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { parseProjectDocument } from '../src/utils/document'
import { computeAllTrims, setThroughRule } from '../src/utils/jointUtils'
import { unflushPairs } from '../src/utils/faceAlign'
import { auditBrackets } from '../src/utils/bracketSeat'
import { getProfileEndpoints } from '../src/utils/geometryCore'
import { jointPartnersAt } from '../src/utils/connectorFit'
import { findConflicts } from '../src/utils/analysis'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = ['examples', 'examples/flat'].flatMap((dir) => fs.readdirSync(path.join(root, dir))
  .filter((name) => name.endsWith('.json') && name !== 'connector-demo.json').map((name) => `${dir}/${name}`)).sort()
const report = files.map((file) => {
  const doc = parseProjectDocument(JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')))
  setThroughRule(doc.throughRule)
  const trims = computeAllTrims(doc.profiles)
  const supports = new Map<string, string[]>()
  const invalid = auditBrackets(doc.profiles, doc.connectors, trims, supports)
  if (invalid.length) throw new Error(`${file}: ${JSON.stringify(invalid)}`)
  const clashes = findConflicts(doc.profiles, trims, doc.connectors, doc.panels, doc.fittings)
  if (clashes.length) throw new Error(`${file}: ${JSON.stringify(clashes)}`)
  const reachable = (from: string, at?: THREE.Vector3) => {
    const links = new Map(doc.profiles.map((p) => [p.id, new Set<string>()]))
    for (const c of doc.connectors) {
      if (at && new THREE.Vector3(...c.position).distanceTo(at) >= 80) continue
      for (const a of supports.get(c.id) ?? []) for (const b of supports.get(c.id) ?? []) links.get(a)!.add(b)
    }
    const seen = new Set([from])
    for (const id of seen) for (const next of links.get(id) ?? []) seen.add(next)
    return seen
  }
  const connected = reachable(doc.profiles[0].id)
  if (connected.size !== doc.profiles.length) throw new Error(`${file}: disconnected profiles ${doc.profiles.filter((p) => !connected.has(p.id)).map((p) => p.id)}`)
  const unfastenedLocalJoints = new Set<string>()
  for (const p of doc.profiles) for (const tip of Object.values(getProfileEndpoints(p))) {
    for (const { a, b, at } of jointPartnersAt(tip, p, doc.profiles)) {
      if (!reachable(a.id, at).has(b.id)) unfastenedLocalJoints.add([a.id, b.id].sort().join('|'))
    }
  }
  if (unfastenedLocalJoints.size) throw new Error(`${file}: unfastened joints ${[...unfastenedLocalJoints]}`)
  const unsupportedCornerPairs = unflushPairs(doc.profiles).map(({ a, b }) => [a, b].sort().join('|')).sort()
  if (unsupportedCornerPairs.length) throw new Error(`${file}: unsupported joints ${unsupportedCornerPairs}`)
  return { file, profiles: doc.profiles.length, connectors: doc.connectors.length,
    connectedProfiles: connected.size, unsupportedCornerPairs, unfastenedLocalJoints: [...unfastenedLocalJoints] }
})
fs.mkdirSync(path.join(root, 'examples/checks'), { recursive: true })
fs.writeFileSync(path.join(root, 'examples/checks/hardware.json'), JSON.stringify(report, null, 2) + '\n')
console.log(report.map(({ file, connectors, unsupportedCornerPairs }) => `${file}: ${connectors} connectors, ${unsupportedCornerPairs.length} unsupported corner pairs`).join('\n'))
