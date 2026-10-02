import { afterEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { FittingData, PanelData } from '../store/useStore'
import type { ProjectDocument } from '../utils/document'
import { buildAssemblyHtml } from '../utils/assemblyHtml'
import { buildProfile } from '../utils/profileFactory'
import { buildBom } from '../utils/bom'
import { computeAllTrims, getThroughRule, setThroughRule } from '../utils/jointUtils'
import { fittingParts } from '../utils/fittingGeometry'
import { partNumber, fittingBoardNumber } from '../utils/partNumbers'
import { equipment } from './fixtures/equipment'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const profile = (id: string, start = V(0, 0, 0), end = V(0, 800, 0)) => buildProfile(start, end, '4040', id)!
const empty = (): ProjectDocument => ({ profiles: [], connectors: [], panels: [], fittings: [], equipment: [], throughRule: 'rails' })
const fitting = (id: string, kind: FittingData['kind']): FittingData => ({
  id, kind, width: 580, height: kind === 'drawer' ? 250 : 800, depth: 550,
  position: [300, 450, 250], quaternion: [0, 0, 0, 1], material: 'ply', open: 0,
})
const sample = (): ProjectDocument => ({
  ...empty(), profiles: [profile('post-b'), profile('post-a', V(600, 0, 0), V(600, 800, 0)), profile('rail', V(0, 800, 0), V(600, 800, 0))],
  connectors: [{ id: 'bracket', type: 'bracket', position: [0, 700, 0], quaternion: [0, 0, 0, 1] }],
  panels: [{ id: 'shelf', width: 550, height: 500, thickness: 18, position: [300, 400, 250], quaternion: [0, 0, 0, 1], material: 'ply' }],
  fittings: [fitting('drawer-1', 'drawer'), fitting('door-1', 'door')],
  equipment: [equipment('oven', { name: 'Oven reference' })],
})
const sections = (html: string) => [...html.matchAll(/<section class="assembly-step"[\s\S]*?<\/section>/g)].map((m) => m[0])
const figure = (html: string) => html.match(/<figure>([\s\S]*?)<\/figure>/)![1]

afterEach(() => setThroughRule('rails'))

describe('standalone assembly HTML', () => {
  it('includes inline illustrations, per-step parts and printable layout without external resources', () => {
    const html = buildAssemblyHtml(sample(), { language: 'en', title: 'Cabinet' })
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('<title>Cabinet</title>')
    expect(html).toContain('@media print')
    expect(html).toContain('break-before:page')
    expect(sections(html).length).toBeGreaterThan(1)
    expect(html).toContain('<polygon')
    expect(html).not.toMatch(/<script|<link|<img|@import|url\(|(?:src|href)="(?:https?:|\/\/)/i)
    expect(html).toContain('stability and tool access are not checked')
  })

  it('retains each BOM identity in the material table and exactly one assembly step', () => {
    const doc = sample(), html = buildAssemblyHtml(doc, { language: 'en' })
    const bom = buildBom(doc.profiles, doc.connectors, computeAllTrims(doc.profiles, doc.throughRule), 'en', doc.panels, doc.fittings)
    const expected = [...bom.profiles, ...bom.connectors, ...bom.panels].flatMap((r) => r.partNumbers)
    const anchored = [...html.matchAll(/<span id="part-([^"]+)">/g)].map((m) => m[1])
    expect(anchored.sort()).toEqual([...expected].sort())
    const stepNumbers = sections(html).flatMap((section) => [...section.matchAll(/<td><a href="#part-([^"]+)">/g)].map((m) => m[1]))
    expect(stepNumbers.sort()).toEqual([...expected].sort())
    for (const part of doc.fittings) for (const board of fittingParts(part).boards) {
      expect(html).toContain(`data-part-number="${fittingBoardNumber(part.id, board.key)}"`)
    }
  })

  it('highlights only the current step and keeps earlier parts visible', () => {
    const html = buildAssemblyHtml(sample(), { language: 'en' })
    const steps = sections(html)
    expect(steps[0]).not.toContain('class="previous" data-part-number')
    expect(steps[0]).toContain('class="current" data-part-number')
    expect(steps.at(-1)).toContain('class="previous" data-part-number')
    expect(steps.at(-1)).toContain('class="current" data-part-number')
    const firstNumbers = [...figure(steps[0]).matchAll(/data-part-number="([^"]+)"/g)].map((m) => m[1])
    const finalNumbers = [...figure(steps.at(-1)!).matchAll(/data-part-number="([^"]+)"/g)].map((m) => m[1])
    expect(firstNumbers.every((number) => finalNumbers.includes(number))).toBe(true)
  })

  it('does not change when source arrays are reordered', () => {
    const doc = sample()
    const reordered = Object.fromEntries(Object.entries(doc).map(([key, value]) => [key, Array.isArray(value) ? [...value].reverse() : value])) as unknown as ProjectDocument
    expect(buildAssemblyHtml(doc, { language: 'en' })).toBe(buildAssemblyHtml(reordered, { language: 'en' }))
  })

  it('prints each drawing index beside the same complete identity in the material and step tables', () => {
    const html = buildAssemblyHtml(sample(), { language: 'en' })
    const overview = figure(html)
    const markers = [...overview.matchAll(/data-drawing-index="(\d+)" data-marker-number="([^"]+)"/g)]
    expect(markers.length).toBeGreaterThan(5)
    expect(new Set(markers.map((marker) => marker[1])).size).toBe(markers.length)
    const ids = markers.map((marker) => marker[2])
    expect(ids).toEqual([...ids].sort())
    for (const [, index, number] of markers) {
      const text = `<b class="drawing-index" data-index="${index}">${index}</b> ${number}`
      expect(html).toContain(`<span id="part-${number}">${text}</span>`)
      expect(sections(html).filter((section) => section.includes(`<td><a href="#part-${number}">${text}</a>`))).toHaveLength(1)
      expect(overview).toMatch(new RegExp(`data-drawing-index="${index}" data-marker-number="${number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]*?<text[^>]*>${index}</text>`))
    }
    expect(html).toContain('Boxed numbers are drawing indexes.')
  })

  it('closes doors and drawers without changing the source document', () => {
    const doc = sample()
    const closed = buildAssemblyHtml(doc, { language: 'en' })
    doc.fittings = doc.fittings.map((f, i) => ({ ...f, open: i ? 0.6 : 1 }))
    const before = structuredClone(doc)
    expect(buildAssemblyHtml(doc, { language: 'en' })).toBe(closed)
    expect(doc).toEqual(before)
  })

  it('uses fixed cuts for dimensions and nesting instead of nominal profile length', () => {
    const doc = empty()
    doc.profiles = [{ ...profile('fixed'), fixedTrims: { start: 10.25, end: 96.5 } }]
    const html = buildAssemblyHtml(doc, { language: 'en', stockLength: 1000 })
    expect(html).toContain('693.25 mm')
    expect(html).not.toContain('800 mm')
    expect(html).toContain('303.75 mm')
    expect(html).toContain('Stock length: 1000 mm')
  })

  it('uses the document rule independently of global state', () => {
    const doc = empty()
    doc.profiles = [profile('post'), profile('rail', V(0, 800, 0), V(600, 800, 0))]
    setThroughRule('posts')
    const rails = buildAssemblyHtml(doc, { language: 'en' })
    expect(rails).toContain('780 mm')
    expect(rails).toContain('620 mm')
    expect(getThroughRule()).toBe('posts')
    setThroughRule('rails')
    const posts = buildAssemblyHtml({ ...doc, throughRule: 'posts' }, { language: 'en' })
    expect(posts).toContain('820 mm')
    expect(posts).toContain('580 mm')
    expect(getThroughRule()).toBe('rails')
    expect(rails).not.toBe(posts)
  })

  it('reports oversize cuts with their original identities', () => {
    const doc = empty()
    doc.profiles = [profile('long', V(0, 0, 0), V(0, 7000, 0))]
    const html = buildAssemblyHtml(doc, { language: 'en', stockLength: 6000 })
    expect(html).toContain('Exceeds stock length; cannot be cut')
    const cutting = html.match(/<section class="cutting">([\s\S]*?)<\/section>/)![1]
    expect(cutting).toContain(partNumber('profile', 'long'))
    expect(cutting).toContain('7000 mm')
    expect(cutting).not.toContain('Total: 1')
  })

  it('shows equipment only as reference and creates no material or assembly step for it', () => {
    const doc = { ...empty(), equipment: [equipment('only', { name: 'Equipment only' })] }
    const html = buildAssemblyHtml(doc, { language: 'en' })
    expect(html).toContain('<g class="reference">')
    expect(html).toContain('Equipment reference: Equipment only')
    expect(html).not.toContain('data-part-number=')
    expect(html).not.toContain('id="part-')
    expect(sections(html)).toEqual([])
    expect(html).toContain('No assembly parts.')
  })

  it('escapes user text and numbers derived from arbitrary IDs', () => {
    const title = '"><script>alert("title")</script>'
    const doc = { ...empty(), equipment: [equipment('e', { name: '<img src=x onerror=alert(1)> & "unsafe"' })] }
    doc.profiles = [profile('p"><script>alert(1)</script>')]
    const html = buildAssemblyHtml(doc, { language: 'en', title })
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt;')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;unsafe&quot;')
    expect(html).toContain(partNumber('profile', doc.profiles[0].id))
  })

  it('projects arbitrarily rotated boards and preserves their dimensions', () => {
    const board: PanelData = { id: 'rotation', width: 600, height: 300, thickness: 18, position: [300, 400, 200], quaternion: [0, 0, 0, 1], material: 'ply' }
    const doc = { ...empty(), panels: [board] }
    const flat = figure(buildAssemblyHtml(doc, { language: 'en' }))
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, -0.7, 0.6))
    board.quaternion = q.toArray()
    const html = buildAssemblyHtml(doc, { language: 'en' })
    expect(figure(html)).not.toBe(flat)
    expect(html).toContain('600 × 300 × 18 mm')
    expect(html).not.toMatch(/\bNaN\b|\bInfinity\b/)
  })

  it('handles empty drawings and Chinese text', () => {
    const html = buildAssemblyHtml(empty(), { language: 'zh' })
    expect(html).toContain('<html lang="zh-CN">')
    expect(html).toContain('无装配零件。')
    expect(html).toContain('不验证稳定性或工具空间')
    expect(html).not.toMatch(/\bNaN\b|\bInfinity\b/)
  })

  it.each([0, -1, NaN, Infinity])('rejects invalid stock length %s', (stockLength) => {
    expect(() => buildAssemblyHtml(empty(), { language: 'en', stockLength })).toThrow('Invalid stock length')
  })
})
