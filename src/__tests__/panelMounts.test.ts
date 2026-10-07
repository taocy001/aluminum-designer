import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { PanelData } from '../store/useStore'
import { buildProfile } from '../utils/profileFactory'
import { attachPanels } from '../utils/attachPanels'
import { panelBoltLength, panelMountSupports } from '../utils/panelMounts'
import { panelDrillCenters, panelShape } from '../utils/panelDrilling'
import { connectorHitsBody } from '../utils/connectorCollision'
import { findConflicts, panelOBB } from '../utils/analysis'
import { computeAllTrims } from '../utils/jointUtils'
import { parseProjectDocument, serializeProjectDocument, type ProjectGeometry } from '../utils/document'
import { encodeShareLink, decodeShare } from '../utils/shareLink'
import { buildStep } from '../utils/step'
import { buildBom } from '../utils/bom'
import { remapCopiedBindings } from '../utils/bindingCopies'
import { makeOBB } from '../utils/obb'
import { shelfEdges } from '../utils/shelfSupport'

function fixture(spacer = 1): ProjectGeometry {
  const rail = (x: number, z: number, endX: number, endZ: number, wide = false) => {
    const p = buildProfile(new THREE.Vector3(x, 350, z), new THREE.Vector3(endX, 350, endZ), wide ? '2040' : '2020')!
    if (wide) p.quaternion = [.5, .5, .5, .5]
    return p
  }
  const panel: PanelData = { id: 'board', width: 860, height: 240, thickness: 18,
    position: [450, 349 + spacer, 160], quaternion: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], material: 'ply' }
  return { profiles: [rail(0, 20, 900, 20, true), rail(0, 300, 900, 300, true), rail(10, 40, 10, 280), rail(890, 40, 890, 280)],
    panels: [panel], connectors: [], fittings: [] }
}
function install(doc = fixture()) {
  let n = 0
  const result = attachPanels(doc, ['board'], () => `mount-${n++}`)
  return { ...doc, connectors: result.made, result }
}

describe('shelf edge fastening', () => {
  it('recognises spread fasteners, but rejects missing, shifted, clustered or obstructed mounts', () => {
    const doc = install()
    const edges = (connectors = doc.connectors, profiles = doc.profiles) =>
      shelfEdges(doc.panels, profiles, undefined, connectors)
    expect(edges()).toHaveLength(4)
    expect(edges().every((edge) => edge.fixed && !edge.carried)).toBe(true)
    expect(edges(doc.connectors.slice(0, 1)).some((edge) => edge.fixed)).toBe(false)
    expect(edges(doc.connectors.slice(1)).filter((edge) => edge.fixed)).toHaveLength(3)
    const trims = computeAllTrims(doc.profiles)
    const hostTrim = trims.get(doc.connectors[0].panelMount!.profileId)!
    hostTrim.cutLength = 30
    expect(shelfEdges(doc.panels, doc.profiles, trims, doc.connectors).filter((edge) => edge.fixed).length).toBeLessThan(4)
    const shifted = structuredClone(doc.connectors)
    shifted[0].position[1] += 2
    expect(edges(shifted).filter((edge) => edge.fixed)).toHaveLength(3)
    // Two legitimate mount positions grouped near one corner do not fix an entire edge.
    const cluster = structuredClone(doc.connectors.slice(0, 2))
    const delta = new THREE.Vector3(...cluster[1].position).sub(new THREE.Vector3(...cluster[0].position))
    cluster[1].position = new THREE.Vector3(...cluster[0].position).add(delta.normalize().multiplyScalar(30)).toArray()
    expect(edges(cluster).some((edge) => edge.fixed)).toBe(false)
    const mount = doc.connectors[0]
    const obstruction = buildProfile(new THREE.Vector3(mount.position[0], mount.position[1] - 10, mount.position[2]),
      new THREE.Vector3(mount.position[0], mount.position[1] + 30, mount.position[2]), '2020')!
    expect(edges(doc.connectors, [...doc.profiles, obstruction]).filter((edge) => edge.fixed).length).toBeLessThan(4)
  })
})

describe('fastening an inset shelf without changing its position', () => {
  it.each([1, 6])('uses the %i mm gap for spacers and checks both supports', (gap) => {
    const doc = fixture(gap), original = JSON.stringify(doc)
    const mounted = install(doc), trims = computeAllTrims(doc.profiles)
    expect(mounted.result).toMatchObject({ blocked: 0, unsupported: 0, existing: 0 })
    expect(mounted.connectors).toHaveLength(8)
    expect(JSON.stringify(doc)).toBe(original)
    for (const c of mounted.connectors) {
      expect(c.panelMount!.spacer).toBe(gap)
      expect(panelBoltLength(c.panelMount!)).toBe(gap === 1 ? 35 : 40)
      expect(panelMountSupports(c, doc.profiles, doc.panels, trims)).toEqual([c.panelMount!.profileId])
    }
    expect(findConflicts(doc.profiles, trims, mounted.connectors, doc.panels)).toEqual([])
    expect(attachPanels(mounted, ['board'], () => 'unexpected')).toMatchObject({ made: [], existing: 8 })
  })

  it('rejects unsupported material, locked boards and moved hosts', () => {
    const doc = install(), c = doc.connectors[0]
    for (const change of [{ material: 'acrylic' as const }, { locked: true }]) {
      expect(install({ ...fixture(), panels: [{ ...doc.panels[0], ...change }] }).connectors).toEqual([])
    }
    const moved = doc.profiles.map(p => p.id === c.panelMount!.profileId ? { ...p, position: [p.position[0], 400, p.position[2]] as [number, number, number] } : p)
    expect(panelMountSupports(c, moved, doc.panels)).toBeNull()
    expect(panelMountSupports(c, doc.profiles, [{ ...doc.panels[0], material: 'acrylic' }])).toBeNull()
    expect(panelMountSupports({ ...c, position: [c.position[0], c.position[1] + 1, c.position[2]] }, doc.profiles, doc.panels)).toBeNull()
  })

  it('opens only the intended board shaft, retaining interference with another board and bolt tips', () => {
    const doc = install(), c = doc.connectors[0], board = doc.panels[0], body = panelOBB(board)
    expect(connectorHitsBody(c, body, .15, false, board.id)).toBe(false)
    expect(connectorHitsBody(c, body, .15, false, 'other-board')).toBe(true)
    expect(connectorHitsBody(c, body, .15, false)).toBe(true)
    const above = { ...board, id: 'obstacle', thickness: 2, position: [450, board.position[1] + 15, 160] as [number, number, number] }
    expect(connectorHitsBody(c, panelOBB(above), .15, false, above.id)).toBe(true)
    expect(attachPanels({ ...fixture(), panels: [board, above] }, ['board'], () => 'blocked').made).toEqual([])
  })

  it('includes the profile-side T-nut shoulder in collision checks', () => {
    const c = install().connectors[0]
    const rotation = new THREE.Quaternion(...c.quaternion)
    // Outside the M5 shaft and below the plate, inside the B6 nut shoulder.
    const center = new THREE.Vector3(-2, 0, -15).applyQuaternion(rotation).add(new THREE.Vector3(...c.position))
    const obstacle = makeOBB(center, new THREE.Vector3(.2, .2, .2), rotation)
    expect(connectorHitsBody(c, obstacle, .15)).toBe(true)
    expect(connectorHitsBody({ ...c, panelMount: undefined }, obstacle, .15)).toBe(false)
  })

  it('provides eight actual 5.5 mm through holes and all fastening parts in the BOM', () => {
    const doc = install(), panel = doc.panels[0]
    expect(panelDrillCenters(panel, doc.connectors)).toHaveLength(8)
    const shape = panelShape(panel, doc.connectors)
    expect(shape.holes).toHaveLength(8)
    const bounds = new THREE.Box2().setFromPoints(shape.holes[0].getPoints(16))
    expect(bounds.getSize(new THREE.Vector2()).x).toBeCloseTo(5.5)
    expect(panelShape({ ...panel, id: 'other' }, doc.connectors).holes).toHaveLength(0)
    const bom = buildBom(doc.profiles, doc.connectors, computeAllTrims(doc.profiles), 'en', doc.panels)
    expect(bom.fasteners.reduce((sum, row) => sum + row.qty, 0)).toBe(64)
    expect(bom.fasteners.some(r => r.label.includes('DIN 934'))).toBe(true)
  })

  it('exports the board holes in STEP as inner face boundaries', () => {
    const doc = install()
    const hardware = buildStep({ profiles: [], connectors: doc.connectors })
    const withBoard = buildStep({ profiles: [], connectors: doc.connectors, panels: doc.panels })
    const holes = (step: string) => (step.match(/= FACE_BOUND\(/g) ?? []).length
    expect(holes(withBoard) - holes(hardware)).toBe(16)
  })

  it('round trips assembly metadata through JSON and share URLs', async () => {
    const doc = install()
    const saved = parseProjectDocument(serializeProjectDocument(doc))
    expect(saved.connectors).toEqual(JSON.parse(JSON.stringify(doc.connectors)))
    const link = await encodeShareLink(doc, 'https://example.com/')
    expect((await decodeShare(link.split('#d=')[1])).connectors).toEqual(JSON.parse(JSON.stringify(doc.connectors)))
    const invalid = { ...doc, connectors: [{ ...doc.connectors[0], panelMount: { ...doc.connectors[0].panelMount!, spacer: -1 } }] }
    expect(() => serializeProjectDocument(invalid)).toThrow()
  })

  it('remaps whole assemblies and preserves standalone copied hardware dimensions', () => {
    const doc = install()
    const copies = { ...doc, profiles: doc.profiles.map(p => ({ ...p, id: `${p.id}-copy` })), panels: doc.panels.map(p => ({ ...p, id: `${p.id}-copy` })), connectors: doc.connectors.map(c => ({ ...c, id: `${c.id}-copy` })) }
    const mapped = remapCopiedBindings(doc, copies)
    expect(mapped.connectors[0].panelMount).toEqual({ ...doc.connectors[0].panelMount, profileId: `${doc.connectors[0].panelMount!.profileId}-copy`, panelId: 'board-copy' })
    const only = { profiles: [], panels: [], fittings: [], connectors: [doc.connectors[0]] }
    expect(remapCopiedBindings(only, { ...only, connectors: [copies.connectors[0]] }).connectors[0].panelMount).toEqual(doc.connectors[0].panelMount)
  })
})
