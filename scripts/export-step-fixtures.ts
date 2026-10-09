/** Generate CAD acceptance inputs outside the repository: npx vite-node scripts/export-step-fixtures.ts /tmp/step-check */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, relative, isAbsolute, sep } from 'node:path'
import { Quaternion, Euler, Matrix4, Vector3, Box3 } from 'three'
import { buildStep, type StepInput } from '../src/utils/step'
import { ALL_SPECS } from '../src/utils/specUtils'
import { fittingParts } from '../src/utils/fittingGeometry'
import { CONNECTOR_CATALOG, connectorScale } from '../src/utils/connectorCatalog'
import { connectorMeshes } from '../src/utils/connectorGeometry'
import type { ConnectorData } from '../src/store/useStore'

const directory = process.argv[2]
if (!directory) throw new Error('Supply an output directory outside the repository')
const relativeOutput = relative(process.cwd(), resolve(directory))
if (relativeOutput !== '..' && !relativeOutput.startsWith(`..${sep}`) && !isAbsolute(relativeOutput)) throw new Error('Output must be outside the repository')
mkdirSync(directory, { recursive: true })
const only = process.argv[3]
const manifest: { file: string; name: string; products: number; solids: number; bounds?: number[]; volume?: number }[] = []
function output(file: string, input: StepInput, expected: { bounds?: number[]; volume?: number } = {}) {
  if (only && file !== only && !(only === 'caster-mount' && file.startsWith('caster-mount-'))) return
  const name = input.name ?? file
  // Compare CAD import with the source mesh, independently of STEP entity topology.
  if (input.connectors?.length && !input.profiles.length && !input.panels?.length && !input.fittings?.length) {
    const bounds = new Box3()
    let volume = 0
    for (const connector of input.connectors) {
      const scale = connectorScale(connector.series ?? 20)
      const transform = new Matrix4().compose(new Vector3(...connector.position),
        new Quaternion(...connector.quaternion).normalize(), new Vector3(scale, scale, scale))
      for (const { geometry, visualOnly } of connectorMeshes(connector.type, connector.series, connector.profileSpec, connector.mountSeries, connector.panelMount)) {
        if (visualOnly) continue
        const positions = geometry.getAttribute('position'), indices = geometry.getIndex()
        let meshVolume = 0
        for (let i = 0; i < (indices?.count ?? positions.count); i += 3) {
          const triangle = [0, 1, 2].map(offset => new Vector3().fromBufferAttribute(positions,
            indices ? indices.getX(i + offset) : i + offset).applyMatrix4(transform))
          triangle.forEach(point => bounds.expandByPoint(point))
          meshVolume += triangle[0].dot(triangle[1].clone().cross(triangle[2])) / 6
        }
        volume += Math.abs(meshVolume)
      }
    }
    expected = { volume, bounds: [...bounds.min.toArray(), ...bounds.max.toArray()], ...expected }
  }
  const step = buildStep({ ...input, name })
  writeFileSync(resolve(directory, `${file}.step`), step)
  manifest.push({ file: `${file}.step`, name, products: input.profiles.length + (input.panels?.length ?? 0) + (input.connectors?.length ?? 0)
    + (input.fittings?.reduce((count, fitting) => count + fittingParts(fitting).boards.length, 0) ?? 0),
    solids: (step.match(/(?:MANIFOLD_SOLID_BREP|FACETED_BREP)\(/g) ?? []).length, ...expected })
}
const identity: [number, number, number, number] = [0, 0, 0, 1]
output('panel', { name: "柜体 'A' \\ panel", profiles: [], panels: [{ id: 'board', material: 'ply', width: 400, height: 200, thickness: 18,
  position: [100, 200, 300], quaternion: identity }] }, { volume: 400 * 200 * 18, bounds: [-100, 100, 291, 300, 300, 309] })
output('sections', { profiles: ALL_SPECS.map((spec, i) => ({ id: spec, spec, length: 400,
  position: [i * 100, 0, 0], quaternion: identity, holes: [], miterCuts: [] })) })
const rotation = new Quaternion().setFromEuler(new Euler(.2, .4, .6)).toArray()
for (const entry of CONNECTOR_CATALOG) {
  const connectors: ConnectorData[] = ([20, 30, 40] as const).map((series, i) => ({ id: `${entry.type}-${series}`, type: entry.type, series,
    position: [i * 300, 100, 40], quaternion: rotation }))
  // Each detailed caster is large enough to warrant a separate CAD session.
  if (entry.type === 'caster-mount') {
    for (const connector of connectors) output(`caster-mount-${connector.series}`, { profiles: [], connectors: [connector] })
  } else output(entry.type, { profiles: [], connectors })
}
output('b6-adapters', { profiles: [], connectors: (['end-cap', 'foot'] as const).map((type, i) => ({ id: type, type, series: 20,
  profileSpec: '4040-B6', position: [i * 300, 0, 0], quaternion: rotation })) })
if (!manifest.length) throw new Error(`Unknown STEP fixture: ${only}`)
writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`Exported ${manifest.length} STEP fixtures to ${directory}`)
