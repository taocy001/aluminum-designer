import { beforeEach, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { useInspectionStore } from '../store/useInspectionStore'
import { buildProfile } from '../utils/profileFactory'
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
  expect(useInspectionStore.getState().report).toBeNull()
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
