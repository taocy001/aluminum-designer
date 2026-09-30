import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { buildProfile } from '../utils/profileFactory'
import { runnerFaults } from '../utils/runnerMount'
import { computeAllTrims } from '../utils/jointUtils'
import type { FittingData, PanelData, ProfileData } from '../store/useStore'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const P = (a: THREE.Vector3, b: THREE.Vector3) => buildProfile(a, b, '2020')!
const drawer: FittingData = { id: 'drawer', kind: 'drawer', width: 600, height: 600, depth: 600,
  position: [0, 0, 0], quaternion: [0, 0, 0, 1], material: 'mdf', open: 0 }
const faults = (profiles: ProfileData[], f = drawer) => runnerFaults(profiles, computeAllTrims(profiles), [f])

describe('actual drawer runner mounting faces', () => {
  it('rejects diagonal rails whose world box only grazes the opening edge', () => {
    const near = 300 + 10 * Math.cos(Math.atan(1 / 3))
    const rails = [-1, 1].map((s) => P(V(s * near, -100, -300), V(s * (near + 200), -100, 300)))
    expect(faults(rails)).toEqual([{ id: 'drawer', side: 'left' }, { id: 'drawer', side: 'right' }])
  })

  it('rejects rising side faces without a continuous horizontal runner band', () => {
    const rails = [-1, 1].map((s) => P(V(s * 310, -280, -290), V(s * 310, 260, 290)))
    expect(faults(rails)).toEqual([{ id: 'drawer', side: 'left' }, { id: 'drawer', side: 'right' }])
  })

  it('keeps broad side panels available as runner mounting faces', () => {
    const q = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), Math.PI / 2)
    const panels: PanelData[] = [-1, 1].map((s) => ({ id: `side-${s}`, width: 600, height: 600, thickness: 18,
      position: [s * 309, 0, 0], quaternion: q.toArray() as PanelData['quaternion'], material: 'mdf' }))
    expect(runnerFaults([], new Map(), [drawer], panels)).toEqual([])
  })

  it('accepts full parallel mounting faces, including a rotated drawer assembly', () => {
    const rails = [-1, 1].map((s) => P(V(s * 310, -100, -300), V(s * 310, -100, 300)))
    expect(faults(rails)).toEqual([])
    const q = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), Math.PI / 4)
    const rotated = rails.map((p) => ({ ...p, position: V(...p.position).applyQuaternion(q).toArray() as ProfileData['position'],
      quaternion: q.clone().multiply(new THREE.Quaternion(...p.quaternion)).toArray() as ProfileData['quaternion'] }))
    expect(faults(rotated, { ...drawer, quaternion: q.toArray() as FittingData['quaternion'] })).toEqual([])
  })

  it('retains the front and back upright bridge mounting option', () => {
    const posts = [-1, 1].flatMap((s) => [-290, 290].map((z) => P(V(s * 310, -300, z), V(s * 310, 300, z))))
    expect(faults(posts)).toEqual([])
  })
})
