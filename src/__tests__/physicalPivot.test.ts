import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore, type ProfileData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { rotateSelected, selectionPivot, type PivotMode } from '../utils/editOps'
import { buildProfile, lowestPointY } from '../utils/profileFactory'
import { computeTrims, setThroughRule, withFixedProfileCuts } from '../utils/jointUtils'
import { profileBodyEndpoints } from '../utils/profileFaces'
import { TEMPLATES } from '../utils/templates'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const member = (id: string, start: THREE.Vector3, end: THREE.Vector3): ProfileData =>
  buildProfile(start, end, '4040', id)!
const load = (profiles: ProfileData[], selectedIds: string[]) => useStore.setState({
  profiles, selectedIds, connectors: [], panels: [], fittings: [], past: [], future: [], throughRule: 'rails',
})
const body = (p: ProfileData, all: ProfileData[]) => profileBodyEndpoints(p, computeTrims(p, all))
const point = (p: ProfileData, all: ProfileData[], mode: PivotMode) => {
  const ends = body(p, all)
  return mode === 'center' ? ends.start.add(ends.end).multiplyScalar(0.5) : ends[mode]
}
const close = (actual: THREE.Vector3, expected: THREE.Vector3) => expect(actual.distanceTo(expected)).toBeLessThan(0.002)

beforeEach(() => {
  load([], [])
  setThroughRule('rails')
  useToolStore.getState().setPivotMode('center')
  useToolStore.getState().stopDrag()
  useToolStore.getState().stopResize()
})

describe('physical rotation pivots', () => {
  for (const [mode, x] of [['start', -20], ['end', 565], ['center', 272.5]] as const) {
    it(`uses asymmetric stored cuts for the ${mode}`, () => {
      const p = { ...member('rail', V(0, 800, 0), V(600, 800, 0)), fixedTrims: { start: -20, end: 35 } }
      close(selectionPivot([p], [], mode), V(x, 800, 0))
    })
  }

  it('resolves automatic cuts against unselected neighbours without changing the document', () => {
    const post = member('post', V(0, 0, 0), V(0, 800, 0))
    const rail = member('rail', V(0, 800, 0), V(600, 800, 0))
    const all = [post, rail]
    const before = structuredClone(all)
    close(selectionPivot([rail], [], 'start', [], [], all), V(-20, 800, 0))
    close(selectionPivot([rail], [], 'center', [], [], all), V(290, 800, 0))
    close(selectionPivot([post], [], 'end', [], [], all), V(0, 780, 0))
    expect(all).toEqual(before)
  })

  it('follows the local length direction of a reversed, rolled rectangular member', () => {
    const p = buildProfile(V(500, 1000, 300), V(100, 600, -100), '2040', 'diagonal')!
    const rolled = new THREE.Quaternion(...p.quaternion)
      .multiply(new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), Math.PI / 3))
    p.quaternion = rolled.toArray() as ProfileData['quaternion']
    p.fixedTrims = { start: 30, end: -45 }
    const dir = V(-1, -1, -1).normalize()
    close(selectionPivot([p], [], 'start'), V(500, 1000, 300).addScaledVector(dir, 30))
    close(selectionPivot([p], [], 'end'), V(100, 600, -100).addScaledVector(dir, 45))
  })

  for (const stored of [false, true]) for (const mode of ['start', 'end', 'center'] as const) {
    it(`pins the workbench ${mode} with ${stored ? 'stored' : 'automatic'} cuts in one undo step`, () => {
      const built = TEMPLATES.find((t) => t.id === 'bench')!.build({ w: 1500, d: 700, h: 900 })
      const all = stored ? withFixedProfileCuts(built) : built
      const selected = all.find((p) => p.position[0] === 0 && p.position[1] === 900 && p.position[2] === 710)!
      const originalPivot = point(selected, all, mode)
      const before = all.map((p) => ({ id: p.id, length: computeTrims(p, all).cutLength, ...body(p, all) }))
      expect(computeTrims(selected, all).start.trim).toBe(-20)
      expect(computeTrims(selected, all).end.trim).toBe(-20)
      load(all, [selected.id])
      useToolStore.getState().setPivotMode(mode)
      expect(rotateSelected('y', 90)).toBe(true)
      const after = useStore.getState().profiles
      close(point(after.find((p) => p.id === selected.id)!, after, mode), originalPivot)
      for (const original of before) {
        const changed = after.find((p) => p.id === original.id)!
        expect(computeTrims(changed, after).cutLength).toBe(original.length)
        if (original.id === selected.id) continue
        close(body(changed, after).start, original.start)
        close(body(changed, after).end, original.end)
      }
      expect(useStore.getState().past).toHaveLength(1)
      useStore.getState().undo()
      expect(useStore.getState().profiles).toEqual(all)
    })
  }

  it('excludes a selected locked reference from the actual turning pivot', () => {
    const rail = { ...member('moving', V(0, 800, 0), V(600, 800, 0)), fixedTrims: { start: 20, end: 40 } }
    const locked = { ...member('locked', V(1500, 800, 0), V(2100, 800, 0)), locked: true }
    load([rail, locked], ['moving', 'locked'])
    useToolStore.getState().setPivotMode('end')
    expect(rotateSelected('y', 90)).toBe(true)
    const after = useStore.getState().profiles
    close(body(after[0], after).end, V(560, 800, 0))
    expect(after[1].position).toEqual(locked.position)
    expect(after[1].quaternion).toEqual(locked.quaternion)
  })

  it('checks the full automatic extension when a rotation reaches the floor', () => {
    const rail = member('rail', V(0, 610, 0), V(600, 610, 0))
    const post = member('post', V(600, 0, 0), V(600, 610, 0))
    load([rail, post], ['rail'])
    expect(computeTrims(rail, [rail, post]).end.trim).toBe(-20)
    useToolStore.getState().setPivotMode('start')
    expect(rotateSelected('z', -90)).toBe(true)
    const turned = useStore.getState().profiles[0]
    expect(lowestPointY(turned)).toBeCloseTo(0, 3)
    expect(turned.fixedTrims).toEqual({ start: 0, end: -20 })
  })
})
