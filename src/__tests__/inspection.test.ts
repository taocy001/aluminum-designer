import { beforeEach, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { useInspectionStore } from '../store/useInspectionStore'
import { buildProfile } from '../utils/profileFactory'
import { remainingConnectionIssues } from '../utils/connectionReport'
import { inspectDocument } from '../utils/inspectionIssues'
import { autoConnect } from '../utils/autoConnect'
import { nearbyConnectorSeats, sameConnectorModel } from '../utils/connectorRecovery'

beforeEach(() => {
  useStore.setState({ profiles: [], connectors: [], panels: [], fittings: [], equipment: [], past: [], future: [], selectedIds: [], throughRule: 'rails' })
  useToolStore.setState({ viewMode: false, buildStep: null })
  useInspectionStore.setState({ report: null, overlap: null, focus: null })
})
it('reports failed end seats with real hosts and offers same-model replacements', () => {
  const host = buildProfile(new THREE.Vector3(0, 100, 0), new THREE.Vector3(0, 100, 400), '2040', 'host')!
  const seats = nearbyConnectorSeats('end-cap', new THREE.Vector3(), [host], [], {})
  const bad = { id: 'bad', type: 'end-cap', ...seats[0].seat, position: seats[0].seat.position.map((v, i) => v + (i === 2 ? 5 : 0)) as [number, number, number], locked: true }
  useStore.setState({ profiles: [host], connectors: [bad] })
  autoConnect('end-cap')
  const report = useInspectionStore.getState().report!
  expect(report.issues.some(i => i.connectorId === 'bad')).toBe(true)
  expect(report.issues.filter(i => !i.connectorId).every(i => i.hosts.includes('host'))).toBe(true)
  const next = nearbyConnectorSeats('end-cap', new THREE.Vector3(...bad.position), [host], useStore.getState().connectors, { excludeConnectorId: bad.id })
  expect(next.some(c => c.allowed && sameConnectorModel(bad, c.seat))).toBe(true)
  expect(next.every(c => !sameConnectorModel({ ...bad, profileSpec: '2020' }, c.seat))).toBe(true)
  const past = useStore.getState().past.length
  useInspectionStore.getState().focusAt(bad.position)
  expect(useStore.getState().past.length).toBe(past)
  useStore.setState({ throughRule: 'posts' })
  expect(useInspectionStore.getState().report).toBe(report)
  expect(useInspectionStore.getState().focus).toBeNull()
})
it('does not auto-connect in view mode and closes overlap on display changes', () => {
  useToolStore.setState({ viewMode: true })
  expect(autoConnect('end-cap').reason).toBe('view-only')
  expect(useStore.getState().past).toHaveLength(0)
  useInspectionStore.getState().setOverlap({ x: 100, y: 100, picks: [] })
  useToolStore.setState({ buildStep: 0 })
  expect(useInspectionStore.getState().overlap).toBeNull()
})

it('revalidates repaired failures, keeps other issues, and restores failures on undo', () => {
  const host = buildProfile(new THREE.Vector3(0, 100, 0), new THREE.Vector3(0, 100, 400), '2040', 'host')!
  const seats = nearbyConnectorSeats('end-cap', new THREE.Vector3(), [host], [], {})
  const valid = { id: 'cap', type: 'end-cap', ...seats[0].seat }
  const bad = { ...valid, position: valid.position.map((n, i) => n + (i === 2 ? 5 : 0)) as [number, number, number] }
  useStore.setState({ profiles: [host], connectors: [bad] })
  useInspectionStore.getState().setReport({ type: 'end-cap', placed: 0, skipped: 0, repaired: 0,
    issues: [{ connectorId: bad.id, position: bad.position, hosts: [host.id], reason: 'no-joint', candidate: bad },
      { position: seats[1].seat.position, hosts: [host.id], reason: 'collision', candidate: { id: 'other', type: 'end-cap', ...seats[1].seat } }] })
  const pending = () => { const r = useInspectionStore.getState(); return remainingConnectionIssues(r.report!, useStore.getState(), r.reportHosts, r.replacements) }
  expect(pending()).toHaveLength(2)
  expect(useStore.getState().commitDocument({ connectors: [valid] }).status).toBe('applied')
  expect(pending()).toHaveLength(1)
  expect(pending()[0].sourceIndex).toBe(1)
  useStore.getState().undo()
  expect(pending()).toHaveLength(2)
})
it('clears a report on document replacement and reports a moved missing installation at its current host', () => {
  const host = buildProfile(new THREE.Vector3(0, 100, 0), new THREE.Vector3(0, 100, 400), '2040', 'host')!
  useStore.setState({ profiles: [host] })
  useInspectionStore.getState().setReport({ type: 'end-cap', placed: 0, skipped: 0, repaired: 0,
    issues: [{ position: [0, 100, 0], hosts: [host.id], reason: 'collision' }] })
  useStore.setState({ profiles: [{ ...host, position: [100, 100, 0] }] })
  const r = useInspectionStore.getState()
  expect(remainingConnectionIssues(r.report!, useStore.getState(), r.reportHosts, {})[0].position).toEqual([100, 100, 0])
  useStore.getState().loadDocument({ profiles: [], connectors: [], panels: [], fittings: [], equipment: [], throughRule: 'rails' })
  expect(useInspectionStore.getState().report).toBeNull()
})
it('inspection follows geometry edits and undo without modifying the document', () => {
  const a = buildProfile(new THREE.Vector3(0, 100, 0), new THREE.Vector3(0, 100, 400), '2040', 'a')!
  const b = { ...a, id: 'b' }
  useStore.setState({ profiles: [a, b] })
  const issues = () => inspectDocument(useStore.getState()).filter(i => i.kind === 'collision')
  expect(issues()).toHaveLength(1)
  expect(issues()[0].ids).toEqual(['a', 'b'])
  expect(useStore.getState().past).toHaveLength(0)
  useStore.getState().commitDocument({ profiles: [a, { ...b, position: [100, 100, 0] }] })
  expect(issues()).toHaveLength(0)
  useStore.getState().undo()
  expect(issues()).toHaveLength(1)
})
