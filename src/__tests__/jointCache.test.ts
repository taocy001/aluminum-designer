import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { ProfileData } from '../store/useStore'
import { computeAllTrims, computeTrims, getThroughRule, setThroughRule } from '../utils/jointUtils'

const loaded = import.meta.glob(['../../examples/*.json', '../../examples/flat/*.json'], { eager: true }) as
  Record<string, { default: { profiles: ProfileData[] } }>
const files = Object.entries(loaded).map(([name, { default: doc }]) => ({ name, profiles: doc.profiles }))

function expectUncachedResult(profiles: ProfileData[]) {
  const cached = computeAllTrims(profiles)
  for (const p of profiles) expect(cached.get(p.id), p.id).toEqual(computeTrims(p, profiles))
  return cached
}

describe('Per-calculation profile geometry', () => {
  it.each(files)('matches uncached trimming under both joint rules: $name', ({ profiles }) => {
    const previous = getThroughRule()
    try {
      for (const rule of ['rails', 'posts'] as const) {
        setThroughRule(rule)
        expectUncachedResult(profiles)
      }
    } finally { setThroughRule(previous) }
  })

  it('matches uncached contacts for rolled and diagonal members and never keeps an edited pose', () => {
    const profiles: ProfileData[] = []
    for (let i = 0; i < 25; i++) {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
        i % 3 === 0 ? Math.PI / 2 : i * 0.09, i % 3 === 1 ? Math.PI / 2 : 0, i * 0.17,
      ))
      profiles.push({ id: `p${i}`, spec: i % 2 ? '2040' : '2020', length: 600,
        position: [(i % 5) * 20, 200 + Math.floor(i / 5) * 20, 0],
        quaternion: [q.x, q.y, q.z, q.w], holes: [], miterCuts: [] })
    }
    const previous = getThroughRule()
    try {
      for (const rule of ['rails', 'posts'] as const) {
        setThroughRule(rule)
        profiles[0].position[0] = 0
        const before = expectUncachedResult(profiles)
        profiles[0].position[0] += 5000
        const after = expectUncachedResult(profiles)
        expect([...after]).not.toEqual([...before])
      }
    } finally { setThroughRule(previous) }
  })
})
