import { expect, it } from 'vitest'
import { Vector3 } from 'three'
import { buildProfile } from '../utils/profileFactory'
import { findSpecMismatches } from '../utils/specCompat'
import { setThroughRule } from '../utils/jointUtils'

const V = (x: number, y: number, z: number) => new Vector3(x, y, z)
it('accepts the shared B8/I8 inner bracket despite different outer section widths', () => {
  setThroughRule('rails')
  const profiles = [
    buildProfile(V(0, 0, 0), V(0, 300, 0), '3030')!,
    buildProfile(V(0, 100, 0), V(300, 100, 0), '4040')!,
  ]
  expect(findSpecMismatches(profiles)).toEqual([])
})
it('reports a B6/I8 mismatch even though both sections have a 40 mm side', () => {
  setThroughRule('rails')
  const profiles = [
    buildProfile(V(0, 0, 0), V(0, 300, 0), '4040')!,
    buildProfile(V(0, 100, 0), V(300, 100, 0), '2040')!,
  ]
  expect(findSpecMismatches(profiles)).toHaveLength(1)
  expect(findSpecMismatches(profiles)[0].kind).toBe('series')
})
