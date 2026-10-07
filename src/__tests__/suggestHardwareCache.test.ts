import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import * as bracketSeats from '../utils/bracketSeat'
import * as hardwareAudit from '../utils/connectorAuditCache'
import { buildProfile, prepareProfile } from '../utils/profileFactory'
import { suggestNext, type SuggestDoc } from '../utils/suggest'
import { specDims } from '../utils/specUtils'
import { vet } from '../utils/suggestGate'
import { computeAllTrims, setThroughRule } from '../utils/jointUtils'

afterEach(() => { vi.restoreAllMocks(); setThroughRule('rails') })

function cappedMember(): SuggestDoc {
  const p = buildProfile(new THREE.Vector3(0, 100, 0), new THREE.Vector3(0, 300, 0), '3030', 'cache-post')!
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, -1, 0))
  return { profiles: [p], connectors: [{ id: 'cache-cap', type: 'end-cap', series: 30,
    profileSpec: '3030', position: [0, 100, 0], quaternion: q.toArray() }], panels: [], fittings: [] }
}

describe('hardware audit reuse across suggestion searches', () => {
  it('uses the rendered audit for the first search and preserves complete fault details', () => {
    const doc = cappedMember()
    doc.profiles[0].id = 'rendered-post'
    doc.connectors[0].id = 'rendered-cap'
    // A displaced cap supplies the full diagnostic payload used by the sidebar.
    doc.connectors[0].position[0] = 8
    const trims = computeAllTrims(doc.profiles)
    const expected = bracketSeats.auditBrackets(doc.profiles, doc.connectors, trims)
    const audit = vi.spyOn(bracketSeats, 'auditBrackets')
    const rendered = hardwareAudit.cachedHardwareSupports(doc, trims)
    expect(rendered.faultDetails).toEqual(expected)
    expect([...rendered.faults]).toEqual(expected.map((fault) => fault.id))
    expect(expected).toHaveLength(1)
    expect(() => rendered.faultDetails[0].at.set(900, 900, 900)).toThrow(TypeError)
    const baselineCalls = () => audit.mock.calls.filter((args) => args[3] !== undefined
      && args[0] === doc.profiles && args[1] === doc.connectors)
    expect(baselineCalls()).toHaveLength(1)
    suggestNext(doc, []).next()
    expect(baselineCalls()).toHaveLength(1)
    expect(hardwareAudit.cachedHardwareSupports(doc, trims)).toBe(rendered)
  })

  it('uses explicit rendered cuts and invalidates their in-place changes', () => {
    const doc = cappedMember()
    doc.profiles[0].id = 'rendered-cut-post'
    doc.connectors[0].id = 'rendered-cut-cap'
    const trims = computeAllTrims(doc.profiles)
    const before = hardwareAudit.cachedHardwareSupports(doc, trims)
    expect(before.faultDetails).toEqual([])
    expect(before.supported.get('rendered-cut-cap')).toEqual(['rendered-cut-post'])
    expect(Object.isFrozen(before.supported.get('rendered-cut-cap'))).toBe(true)
    const cut = trims.get('rendered-cut-post')!
    cut.start.trim += 10
    cut.cutLength -= 10
    const after = hardwareAudit.cachedHardwareSupports(doc, trims)
    expect(after).not.toBe(before)
    expect(after.faultDetails).toEqual(bracketSeats.auditBrackets(doc.profiles, doc.connectors, trims))
    expect(after.faults.has('rendered-cut-cap')).toBe(true)
    expect(before.faultDetails).toEqual([])
  })

  it('reconstructs a real missing rail from current objects after detached originals are edited', () => {
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
    const posts = [0, 600].flatMap((x) => [0, 400].map((z) =>
      prepareProfile(V(x, 0, z), V(x, 800, z), '2020', [])!))
    const left = prepareProfile(V(0, 200, 0), V(0, 200, 400), '2020', posts)!
    const right = prepareProfile(V(600, 200, 0), V(600, 200, 400), '2020', posts)!
    const connectors = [left, right].flatMap((rail) => [0, 400].map((z) => {
      const post = posts.find((p) => p.position[0] === rail.position[0] && p.position[2] === z)!
      return { id: `${rail.id}-${z}`, type: 'inside-corner',
        ...bracketSeats.seatFor('inside-corner', rail, post, V(rail.position[0], 200, z))! }
    }))
    const doc: SuggestDoc = { profiles: [...posts, right], connectors, panels: [], fittings: [] }
    const search = () => {
      const candidate = suggestNext(doc, []).next().value!
      const { id: _id, ...member } = candidate.member
      return { ...candidate, member }
    }
    const expected = search()
    expect(expected.member.position).toEqual(left.position)
    const previous = { profiles: doc.profiles, connectors: doc.connectors }
    doc.profiles = structuredClone(doc.profiles)
    doc.connectors = structuredClone(doc.connectors)
    for (const p of previous.profiles) { p.position[0] += 2000; p.quaternion[0] += 0.3 }
    for (const c of previous.connectors) { c.position[1] += 2000; c.quaternion[1] += 0.3 }
    expect(search()).toEqual(expected)
    expect(search()).toEqual(expected)
  })

  it('invalidates generation recipes on manufacturing rules and restores only current document references', () => {
    setThroughRule('rails')
    const doc = cappedMember()
    doc.profiles[0].id = 'recipe-post'
    doc.connectors[0].id = 'recipe-cap'
    const supports = vi.spyOn(hardwareAudit, 'cachedHardwareSupports')
    const search = () => [...suggestNext(doc, [])]
    expect(search()).toEqual([])
    expect(supports).toHaveBeenCalledTimes(1)
    expect(search()).toEqual([])
    expect(supports).toHaveBeenCalledTimes(1)

    setThroughRule('posts')
    expect(search()).toEqual([])
    expect(supports).toHaveBeenCalledTimes(2)
    setThroughRule('rails')
    expect(search()).toEqual([])
    expect(supports).toHaveBeenCalledTimes(2)

    const previous = doc.profiles[0]
    doc.profiles = structuredClone(doc.profiles)
    previous.position[0] = 900
    expect(search()).toEqual([])
    expect(supports).toHaveBeenCalledTimes(2)
    doc.profiles[0].position[0] = 12
    search()
    expect(supports).toHaveBeenCalledTimes(3)
  })

  it('reuses an unchanged numeric snapshot and re-audits in-place edits to mounting inputs', () => {
    const doc = cappedMember()
    const audit = vi.spyOn(bracketSeats, 'auditBrackets')
    const calls = () => audit.mock.calls.filter((args) => args[3] !== undefined)
    const search = () => { suggestNext(doc, []).next() }
    search()
    expect(calls()).toHaveLength(1)
    expect(calls()[0][3]!.get('cache-cap')).toEqual(['cache-post'])
    search()
    expect(calls()).toHaveLength(1)
    // Equivalent replacement objects preserve the snapshot; references are not keys.
    doc.profiles = structuredClone(doc.profiles)
    doc.connectors = structuredClone(doc.connectors)
    search()
    expect(calls()).toHaveLength(1)

    const changeAndSearch = (change: () => void) => {
      const count = calls().length
      change(); search()
      expect(calls()).toHaveLength(count + 1)
      search()
      expect(calls()).toHaveLength(count + 1)
    }
    changeAndSearch(() => { doc.connectors[0].position[0] = 8 })
    expect(calls().at(-1)![3]!.has('cache-cap')).toBe(false)
    changeAndSearch(() => { doc.connectors[0].quaternion[0] += 0.1 })
    changeAndSearch(() => { doc.connectors[0].profileSpec = '2020' })
    changeAndSearch(() => { doc.connectors[0].series = 20 })
    changeAndSearch(() => { doc.connectors[0].mountSeries = [30, 40] })
    changeAndSearch(() => { doc.connectors[0].mountSeries![0] = 40 })
    changeAndSearch(() => { doc.profiles[0].length += 10 })
    changeAndSearch(() => { doc.profiles[0].position[2] += 10 })
    changeAndSearch(() => { doc.profiles[0].quaternion[2] += 0.1 })
    changeAndSearch(() => { doc.profiles[0].spec = '4040' })
    changeAndSearch(() => { doc.profiles[0].fixedTrims = { start: 40, end: 0 } })
    changeAndSearch(() => { doc.profiles[0].fixedTrims!.start = 50 })
    changeAndSearch(() => { doc.profiles[0].miterCuts.push({ side: 'start', angle: 45 }) })
    changeAndSearch(() => { doc.profiles[0].id = 'replacement-post' })
    changeAndSearch(() => { doc.connectors[0].id = 'replacement-cap' })
  })

  it('shares only the baseline audit while checking each proposed assembly again', () => {
    setThroughRule('rails')
    const profile = (id: string, a: number[], b: number[]) => buildProfile(new THREE.Vector3(...a), new THREE.Vector3(...b), '2020', id)!
    const beam = profile('audit-beam', [0, 100, 0], [200, 100, 0])
    const left = profile('audit-left', [0, 0, 0], [0, 100, 0])
    const middle = profile('audit-middle', [100, 0, 0], [100, 100, 0])
    const pose = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0))
    const doc: SuggestDoc = { profiles: [beam, left], panels: [], fittings: [], connectors: [{
      id: 'audit-cap', type: 'end-cap', series: 20, profileSpec: '2020', position: [200, 100, 0], quaternion: pose.toArray(),
    }] }
    const audit = vi.spyOn(bracketSeats, 'auditBrackets')
    for (let i = 0; i < 2; i++) {
      expect(vet(middle, { kind: 'close' }, doc)).toEqual({ ok: true })
      expect(audit.mock.calls.filter((args) => args[3] !== undefined)).toHaveLength(1)
      expect(audit.mock.calls.filter((args) => args[0].some((p) => p.id === middle.id) && args[1].length === 0)).toHaveLength(i + 1)
    }
  })

  it('keeps fixed section dimensions immutable without changing string fallback dimensions', () => {
    expect(specDims('2040')).toEqual({ w: 20, h: 40, hw: 10, hh: 20 })
    expect(() => Object.assign(specDims('2040'), { w: 900 })).toThrow(TypeError)
    expect(specDims('2040').w).toBe(20)
    expect(specDims('3050')).toEqual({ w: 30, h: 50, hw: 15, hh: 25 })
    expect(specDims('')).toEqual({ w: 20, h: 20, hw: 10, hh: 10 })
  })
})
