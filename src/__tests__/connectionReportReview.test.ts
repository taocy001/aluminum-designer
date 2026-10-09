import { beforeEach, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store/useStore'
import { useInspectionStore } from '../store/useInspectionStore'
import { useToolStore } from '../store/useToolStore'
import { buildProfile } from '../utils/profileFactory'
import { nearbyConnectorSeats } from '../utils/connectorRecovery'
import { remainingConnectionIssues } from '../utils/connectionReport'

beforeEach(() => {
  useStore.getState().loadDocument({ profiles: [], connectors: [], panels: [], fittings: [], equipment: [], throughRule: 'rails' })
  useStore.setState({ past: [], future: [], selectedIds: [] })
  useToolStore.setState({ viewMode: false })
})

function setup() {
  const host = buildProfile(new THREE.Vector3(0, 100, 0), new THREE.Vector3(0, 100, 400), '2040', 'host')!
  const candidates = nearbyConnectorSeats('end-cap', new THREE.Vector3(), [host], [], {})
    .map((seat, index) => ({ id: `cap-${index}`, type: 'end-cap', ...seat.seat }))
  useStore.setState({ profiles: [host] })
  useInspectionStore.getState().setReport({ type: 'end-cap', placed: 0, repaired: 0, skipped: 0,
    issues: candidates.map(candidate => ({ candidate, position: candidate.position, hosts: [host.id], reason: 'collision' })) })
  return { host, candidates }
}
function pending() {
  const report = useInspectionStore.getState()
  return remainingConnectionIssues(report.report!, useStore.getState(), report.reportHosts, report.replacements)
}

it('repairs multiple failures one at a time and restores the exact remaining items through undo and redo', () => {
  const { candidates } = setup()
  expect(candidates).toHaveLength(2)
  for (let i = 0; i < candidates.length; i++) {
    const s = useStore.getState()
    expect(s.commitDocument({ connectors: [...s.connectors, candidates[i]] }).status).toBe('applied')
    useInspectionStore.getState().recordRepair(i, candidates[i].id)
    expect(pending().map(item => item.sourceIndex)).toEqual(i ? [] : [1])
  }
  useStore.getState().undo()
  expect(pending().map(item => item.sourceIndex)).toEqual([1])
  useStore.getState().undo()
  expect(pending().map(item => item.sourceIndex)).toEqual([0, 1])
  useStore.getState().redo()
  expect(pending().map(item => item.sourceIndex)).toEqual([1])
})

it('removes deleted-host failures and restores them when host deletion is undone', () => {
  setup()
  expect(useStore.getState().commitDocument({ profiles: [] }).status).toBe('applied')
  expect(pending()).toEqual([])
  useStore.getState().undo()
  expect(pending()).toHaveLength(2)
})

it('transforms missing installation positions and orientations with a rotated and translated host', () => {
  const { host, candidates } = setup()
  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
  const position = new THREE.Vector3(150, 200, 50)
  useStore.setState({ profiles: [{ ...host, position: position.toArray(),
    quaternion: rotation.clone().multiply(new THREE.Quaternion(...host.quaternion)).toArray() }] })
  const results = pending()
  for (let i = 0; i < candidates.length; i++) {
    const expected = new THREE.Vector3(...candidates[i].position).sub(new THREE.Vector3(...host.position))
      .applyQuaternion(rotation).add(position)
    expect(new THREE.Vector3(...results[i].position).distanceTo(expected)).toBeLessThan(.001)
    const expectedQ = rotation.clone().multiply(new THREE.Quaternion(...candidates[i].quaternion))
    expect(Math.abs(new THREE.Quaternion(...results[i].candidate!.quaternion).dot(expectedQ))).toBeCloseTo(1)
  }
})
