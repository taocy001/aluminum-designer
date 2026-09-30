import { beforeEach, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { buildProfile } from '../utils/profileFactory'
import { computeTrims, setThroughRule } from '../utils/jointUtils'
import { commitExactLength } from '../utils/editOps'
import { clearOpLog, describeChange, opLog, record } from '../utils/opLog'

beforeEach(() => {
  useStore.setState({ profiles: [], connectors: [], panels: [], fittings: [],
    selectedIds: [], past: [], future: [], throughRule: 'rails' })
  setThroughRule('rails')
  useToolStore.getState().stopDrag()
  useToolStore.getState().stopResize()
  clearOpLog()
})

it('logs the first automatic 40 to 15 mm resize when only the physical cuts change', () => {
  const post = buildProfile(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 800, 0), '4040', 'A')!
  const rail = buildProfile(new THREE.Vector3(0, 800, 0), new THREE.Vector3(10, 800, 0), '4040', 'B')!
  useStore.setState({ profiles: [post, rail] })
  const before = useStore.getState()
  expect(computeTrims(rail, before.profiles).cutLength).toBe(40)
  expect(rail.fixedTrims).toBeUndefined()

  useToolStore.getState().startResize({ id: rail.id, end: 'end', origin: rail.position,
    length: rail.length, grabLength: rail.length, downX: 0, downY: 0 })
  expect(commitExactLength(15)).toBe(true)
  const after = useStore.getState(), edited = after.profiles[1]
  expect(edited.length).toBe(rail.length)
  expect(edited.position).toEqual(rail.position)
  expect(computeTrims(edited, after.profiles).cutLength).toBe(15)
  expect(computeTrims(after.profiles[0], after.profiles).cutLength)
    .toBe(computeTrims(post, before.profiles).cutLength)

  const change = describeChange(before, after)
  expect(change?.ids).toEqual(['B'])
  expect(change?.detail).toContain('fixedTrims')
  record(before, after)
  expect(opLog()).toHaveLength(1)
  expect(opLog()[0].ids).toEqual(['B'])
})
