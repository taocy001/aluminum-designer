import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { buildProfile } from '../utils/profileFactory'
import { attachPanels } from '../utils/attachPanels'
import { panelMountCandidates, panelMountSupports, panelMountFasteners, panelMountFrame, panelBoltLength, panelFastenerSizes, directStackExtra } from '../utils/panelMounts'
import { panelDrillCenters } from '../utils/panelDrilling'
import { findConflicts } from '../utils/analysis'
import { computeAllTrims } from '../utils/jointUtils'
import { parseProjectDocument, serializeProjectDocument, type ProjectGeometry } from '../utils/document'
import { encodeShareLink, decodeShare } from '../utils/shareLink'
import { panelMountMeshes } from '../utils/panelMountGeometry'
import { unfastenedPanels } from '../utils/panelFastening'

function fixture(): ProjectGeometry {
  return { profiles: [-200, 200].map(x => buildProfile(new THREE.Vector3(x, 0, 0), new THREE.Vector3(x, 600, 0), '2020')!),
    panels: [{ id: 'back', width: 500, height: 600, thickness: 18, material: 'mdf', position: [0, 300, -19], quaternion: [0, 0, 0, 1] }],
    connectors: [], fittings: [] }
}
function install(doc: ProjectGeometry) {
  let n = 0
  return attachPanels(doc, doc.panels.map(p => p.id), () => `mount-${n++}`)
}

describe('flush board fastening', () => {
  it('uses full T-nut engagement without bottoming out and distributes real holes', async () => {
    const doc = fixture(), result = install(doc)
    expect(result).toMatchObject({ blocked: 0, unsupported: 0 })
    expect(result.made).toHaveLength(4)
    doc.connectors = result.made
    expect(unfastenedPanels(doc)).toEqual([])
    expect(unfastenedPanels({ ...doc, connectors: doc.connectors.slice(0, 2) })).toEqual(['back'])
    for (const c of doc.connectors) {
      expect(panelMountFasteners(c.panelMount!, c.series)).toEqual([
        { kind: 'bolt', count: 1, thread: 'M5', length: 25, standard: 'DIN 912' },
        { kind: 'washer', count: 2, thread: 'M5', standard: 'ISO 7089', descriptionZh: '厚 1 mm', descriptionEn: '1 mm thick' },
      ])
      expect(panelMountFrame(c).boardHole.z).toBeCloseTo(-10)
    }
    expect(panelDrillCenters(doc.panels[0], doc.connectors).map(h => h.diameter)).toEqual([5.5, 5.5, 5.5, 5.5])
    expect(findConflicts(doc.profiles, computeAllTrims(doc.profiles), doc.connectors, doc.panels)).toEqual([])
    expect(install(doc)).toMatchObject({ made: [], existing: 4 })
    const roundtrip = parseProjectDocument(serializeProjectDocument(doc))
    expect(roundtrip.connectors).toEqual(doc.connectors)
    const link = await encodeShareLink(doc, 'https://example.com/')
    expect((await decodeShare(link.split('#d=')[1])).connectors).toEqual(doc.connectors)
  })

  it.each([6, 18, 25, 40])('fastens a %i mm I8 backboard through the nominal nut thickness with a clear slot floor', (thickness) => {
    const doc = fixture()
    doc.profiles = [-200, 200].map(x => buildProfile(new THREE.Vector3(x, 0, 0), new THREE.Vector3(x, 600, 0), '4040')!)
    doc.panels = [{ ...doc.panels[0], thickness, position: [0, 300, -20 - thickness / 2] }]
    const result = install(doc)
    expect(result).toMatchObject({ blocked: 0, unsupported: 0 })
    expect(result.made).toHaveLength(4)
    doc.connectors = result.made
    expect(unfastenedPanels(doc)).toEqual([])
    expect(findConflicts(doc.profiles, computeAllTrims(doc.profiles), doc.connectors, doc.panels)).toEqual([])
    expect(panelDrillCenters(doc.panels[0], doc.connectors).map(h => h.diameter)).toEqual([9, 9, 9, 9])
    const mount = result.made[0].panelMount!, d = panelFastenerSizes(40)
    const bearing = thickness + directStackExtra(mount, 40) + d.washer
    expect(bearing - panelBoltLength(mount, 40)).toBeCloseTo(-11)
    // Manufacturer nut ends at depth 10.9; profile slot floor is at depth 12.25.
    const shaft = panelMountMeshes(mount, 40).find(mesh => mesh.panelShaft)!.geometry
    shaft.computeBoundingBox()
    expect(shaft.boundingBox!.min.x).toBeCloseTo(-11)
    expect(shaft.boundingBox!.max.x).toBeCloseTo(bearing)
    expect(panelMountFasteners(mount, 40).filter(f => f.thread).every(f => f.thread === 'M8')).toBe(true)
    expect(install(doc)).toMatchObject({ made: [], existing: 4 })
    expect(parseProjectDocument(serializeProjectDocument(doc)).connectors).toEqual(doc.connectors)
  })

  it('fastens an I8 inset shelf using a 6 mm plate and separate rail bolt spacer', () => {
    const rail = buildProfile(new THREE.Vector3(-300, 0, 0), new THREE.Vector3(300, 0, 0), '4040')!
    const doc: ProjectGeometry = { profiles: [rail], connectors: [], fittings: [], panels: [{ id: 'shelf', material: 'ply',
      width: 500, height: 100, thickness: 18, position: [0, 0, 70], quaternion: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] }] }
    const result = install(doc)
    expect(result.made).toHaveLength(2)
    expect(result.blocked).toBe(0)
    doc.connectors = result.made
    expect(findConflicts(doc.profiles, computeAllTrims(doc.profiles), doc.connectors, doc.panels)).toEqual([])
    for (const c of result.made) {
      const parts = panelMountFasteners(c.panelMount!, 40)
      expect(parts).toContainEqual({ kind: 'bolt', count: 1, thread: 'M8', length: 20, standard: 'DIN 912' })
      expect(parts.some(p => p.kind === 'other' && p.length === 1.4)).toBe(true)
      expect(panelBoltLength(c.panelMount!, 40)).toBe(50)
      expect(c.panelMount!.spacer).toBe(11)
    }
    expect(panelDrillCenters(doc.panels[0], result.made).map(h => h.diameter)).toEqual([9, 9])
    expect(install(doc)).toMatchObject({ made: [], existing: 2 })
    expect(parseProjectDocument(serializeProjectDocument(doc)).connectors).toEqual(doc.connectors)
  })

  it('does not count a bare nut as a complete installation', () => {
    const doc = fixture(), candidate = panelMountCandidates(doc.panels[0], doc.profiles)[0]
    // Bare T-nuts use local Y as their mounting normal rather than panel assemblies' local X.
    const normal = panelMountFrame(candidate).normal
    doc.connectors = [{ ...candidate, id: 'bare', panelMount: undefined,
      quaternion: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal).toArray() }]
    const result = install(doc)
    expect(result.existing).toBe(0)
    expect(result.made.length).toBeGreaterThanOrEqual(3)
    expect(result.made.some(c => new THREE.Vector3(...c.position).distanceTo(new THREE.Vector3(...candidate.position)) < 1)).toBe(false)
  })

  it('rejects a gap behind the board, wrong metadata, and unverified 3040 hosts', () => {
    const doc = fixture(), candidate = panelMountCandidates(doc.panels[0], doc.profiles)[0]
    expect(install({ ...doc, panels: [{ ...doc.panels[0], position: [0, 300, -20] }] }).made).toEqual([])
    expect(panelMountSupports({ ...candidate, panelMount: { ...candidate.panelMount!, spacer: 1 } }, doc.profiles, doc.panels)).toBeNull()
    const bad = { ...doc, profiles: doc.profiles.map(p => ({ ...p, spec: '3040' as const })) }
    expect(install(bad).made).toEqual([])
    expect(panelMountSupports({ ...candidate, series: 30 }, bad.profiles, doc.panels)).toBeNull()
  })

  it('uses physical M6 holes and fittings for a 3030 inset shelf', () => {
    const rail = buildProfile(new THREE.Vector3(-300, 0, 0), new THREE.Vector3(300, 0, 0), '3030')!
    const doc: ProjectGeometry = { profiles: [rail], connectors: [], fittings: [], panels: [{ id: 'shelf', material: 'ply',
      width: 500, height: 100, thickness: 18, position: [0, 0, 70], quaternion: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] }] }
    const result = install(doc)
    expect(result.made).toHaveLength(2)
    expect(result.blocked).toBe(0)
    for (const c of result.made) {
      expect(c.series).toBe(30)
      expect(c.panelMount?.spacer).toBe(6)
      expect(panelMountFasteners(c.panelMount!, 30).filter(f => f.thread).every(f => f.thread === 'M6')).toBe(true)
    }
    expect(panelDrillCenters(doc.panels[0], result.made).map(h => h.diameter)).toEqual([6.6, 6.6])
    expect(install({ ...doc, profiles: [{ ...rail, spec: '3040' }] }).made).toEqual([])
  })
})
