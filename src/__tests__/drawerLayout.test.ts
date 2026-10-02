import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore, type FittingData, type ProfileData } from '../store/useStore'
import { drawerLayout } from '../utils/drawerLayout'
import { fittingParts, fittingSolids, openTransform } from '../utils/fittingGeometry'
import { validFitting } from '../utils/fittingValidation'
import { buildBom } from '../utils/bom'
import { updateDrawerConfig } from '../utils/fittingOps'
import { addDrawerSupports, buildDrawerSupport } from '../utils/drawerSupports'
import { buildProfile } from '../utils/profileFactory'
import { computeAllTrims, setThroughRule } from '../utils/jointUtils'
import { runnerFaults } from '../utils/runnerMount'
import { auditBrackets } from '../utils/bracketSeat'
import { obbPenetration } from '../utils/obb'
import { analyzeFrame } from '../utils/analysis'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const drawer = (extra: Partial<FittingData> = {}): FittingData => ({ id: 'drawer', kind: 'drawer',
  width: 600, height: 240, depth: 500, material: 'ply', open: 0, position: [0, 200, 0],
  quaternion: [0, 0, 0, 1], ...extra })
const posts = () => [-310, 310].flatMap((x) => [-260, 260].map((z) =>
  buildProfile(V(x, 0, z), V(x, 600, z), '2020')!))
beforeEach(() => {
  setThroughRule('rails')
  useStore.setState({ profiles: [], connectors: [], panels: [], fittings: [drawer()], selectedIds: ['drawer'], past: [], future: [] })
})

describe('drawer construction dimensions', () => {
  it('preserves legacy geometry and inset travel when options are absent or partial', () => {
    for (const overlay of ['full', 'half', 'inset'] as const) for (const frame of [0, 20, 40]) {
      const f = drawer({ overlay, frame })
      const parts = fittingParts(f)
      expect(parts.boards).toHaveLength(6)
      expect(drawerLayout(f).boxWidth).toBe(575)
      expect(drawerLayout(f).boxDepth).toBe(500 + frame - 20 - (overlay === 'inset' ? 18 : 0))
      expect(parts.travel).toBe(470)
      expect(fittingParts({ ...f, drawer: {} })).toEqual(parts)
      expect(validFitting({ ...f, drawer: { bottomThickness: 12 } })).toBe(true)
      expect(fittingParts({ ...f, drawer: { bottomThickness: 12 } }).travel).toBe(470)
    }
  })

  it('sizes all box boards, raises the base and emits real non-overlapping reinforcement strips', () => {
    const f = drawer({ drawer: { sideClearance: 20, boxThickness: 18, bottomThickness: 9, rearClearance: 30,
      runnerLength: 400, runnerTravel: 300, reinforcement: { count: 2, width: 40, height: 20 } } })
    const d = drawerLayout(f), boards = fittingParts(f).boards
    expect(d).toMatchObject({ boxWidth: 560, boxDepth: 470, boxHeight: 214, innerWidth: 524, innerDepth: 434, innerHeight: 185 })
    expect(boards.find((b) => b.key === 'base')).toMatchObject({ width: 524, height: 434, thickness: 9, position: [0, -95.5, 15] })
    expect(boards.filter((b) => b.role === 'reinforcement')).toHaveLength(2)
    expect(new Set(boards.map((b) => b.key)).size).toBe(8)
    const solids = fittingSolids(f, 0)
    for (let i = 0; i < solids.length; i++) for (let j = i + 1; j < solids.length; j++)
      expect(obbPenetration(solids[i], solids[j], 0.01)).toBeLessThanOrEqual(0.01)
    const bom = buildBom([], [], new Map(), 'en', [], [f])
    expect(bom.panels.reduce((sum, p) => sum + p.qty, 0)).toBe(8)
    expect(bom.totalBoardArea).toBeCloseTo(boards.reduce((sum, b) => sum + b.width * b.height / 1e6, 0))
    expect(bom.connectors.find((c) => c.key === 'runner-400')?.qty).toBe(1)
    expect(openTransform({ ...f, open: 0.5 }).position.z).toBe(150)
  })

  it('uses runner length for mounting checks', () => {
    const rail = buildDrawerSupport(drawer(), 'left', '2020', { back: 60, front: 250 }, 'rail')!
    const short = drawer({ drawer: { runnerLength: 180 } })
    expect(runnerFaults([rail], computeAllTrims([rail]), [short], [], false)).toEqual([{ id: 'drawer', side: 'right' }])
    expect(runnerFaults([rail], computeAllTrims([rail]), [drawer()], [], false)).toHaveLength(2)
  })

  it('limits derived travel when the user changes the rear space or runner length', () => {
    expect(drawerLayout(drawer({ frame: 20, drawer: { rearClearance: 400 } }))).toMatchObject({ boxDepth: 120, runnerLength: 120, travel: 120 })
    expect(drawerLayout(drawer({ drawer: { runnerLength: 300 } })).travel).toBe(300)
    expect(validFitting(drawer({ frame: 20, drawer: { rearClearance: 400 } }))).toBe(true)
  })

  it('does not create a support with overflowing length or world coordinates', () => {
    expect(buildDrawerSupport(drawer(), 'left', '2020', { back: -1e308, front: 1e308 }, 'rail')).toBeNull()
    expect(buildDrawerSupport(drawer({ position: [0, 0, 1e308] }), 'left', '2020', { back: 1e308, front: 1.1e308 }, 'rail')).toBeNull()
  })

  it.each([
    { boxThickness: 290 }, { bottomThickness: 214 }, { sideClearance: 300 }, { rearClearance: 490 },
    { runnerLength: 501 }, { runnerLength: 400, runnerTravel: 401 },
    { reinforcement: { count: 2, width: 300, height: 20 } },
    { reinforcement: { count: 1, width: 40, height: 200 } },
  ])('rejects construction with no usable space: %j', (config) => expect(validFitting(drawer({ drawer: config }))).toBe(false))
})

describe('drawer configuration transaction', () => {
  it('merges selected drawers independently, respects locks, and supports undo/redo', () => {
    const a = drawer({ drawer: { reinforcement: { count: 1, width: 30, height: 15 } } })
    const b = drawer({ id: 'b', drawer: { reinforcement: { count: 1, width: 50, height: 25 } } })
    const locked = drawer({ id: 'locked', locked: true })
    useStore.setState({ fittings: [a, b, locked] })
    expect(updateDrawerConfig(['drawer', 'b', 'locked'], { reinforcement: { count: 2 } })).toBe(true)
    const next = useStore.getState().fittings
    expect(next.map((f) => f.drawer?.reinforcement)).toEqual([{ count: 2, width: 30, height: 15 }, { count: 2, width: 50, height: 25 }, undefined])
    expect(useStore.getState().past).toHaveLength(1)
    useStore.getState().undo()
    expect(useStore.getState().fittings).toEqual([a, b, locked])
    useStore.getState().redo()
    expect(useStore.getState().fittings).toEqual(next)
    const before = useStore.getState()
    expect(updateDrawerConfig(['drawer', 'b'], { runnerTravel: 1000 })).toBe(false)
    expect(useStore.getState()).toBe(before)
  })
})

describe('connected drawer supports', () => {
  it('adds two rails and four legal brackets without changing existing cuts, then is idempotent', () => {
    const frame = posts()
    useStore.setState({ profiles: frame })
    const before = computeAllTrims(frame)
    const result = addDrawerSupports(['drawer'])
    expect(result.failed).toEqual([])
    expect(result.generated).toHaveLength(2)
    const s = useStore.getState(), trims = computeAllTrims(s.profiles)
    expect(s.connectors).toHaveLength(4)
    expect(auditBrackets(s.profiles, s.connectors, trims)).toEqual([])
    expect(analyzeFrame(s.profiles, s.connectors).conflicts).toEqual([])
    expect(runnerFaults(s.profiles, trims, s.fittings, [], false)).toEqual([])
    for (const p of frame) expect(trims.get(p.id)?.cutLength).toBe(before.get(p.id)?.cutLength)
    expect(addDrawerSupports(['drawer'])).toEqual({ generated: [], failed: [] })
    expect(useStore.getState().past).toHaveLength(1)
    useStore.getState().undo()
    expect(useStore.getState().profiles).toEqual(frame)
    expect(useStore.getState().connectors).toEqual([])
    useStore.getState().redo()
    expect(useStore.getState().profiles).toEqual(s.profiles)
  })

  it('fills just the missing side and leaves other drawers untouched', () => {
    const f = drawer(), rail = buildDrawerSupport(f, 'left', '2020', { back: -250, front: 250 }, 'existing')!
    useStore.setState({ profiles: [...posts(), rail], fittings: [f, drawer({ id: 'other', position: [1000, 200, 0] })] })
    const result = addDrawerSupports(['drawer'])
    expect(result.failed).toEqual([])
    expect(result.generated.map((r) => [r.fittingId, r.side])).toEqual([['drawer', 'right']])
    expect(useStore.getState().profiles.find((p) => p.id === 'existing')).toBe(rail)
  })

  it('does not leave a half-built drawer when the second side has no mounts', () => {
    useStore.setState({ profiles: posts().filter((p) => p.position[0] < 0) })
    const before = useStore.getState()
    const result = addDrawerSupports(['drawer'])
    expect(result.generated).toEqual([])
    expect(result.failed).toEqual([{ fittingId: 'drawer', side: 'right', reason: 'no-mount' }])
    expect(useStore.getState()).toBe(before)
  })

  it('does not change locked drawers or generate floating rails', () => {
    useStore.setState({ fittings: [drawer({ locked: true })], profiles: posts() })
    const before = useStore.getState()
    expect(addDrawerSupports(['drawer']).failed.every((v) => v.reason === 'locked')).toBe(true)
    expect(useStore.getState()).toBe(before)
    useStore.setState({ fittings: [drawer()], profiles: [] })
    expect(addDrawerSupports(['drawer']).generated).toEqual([])
    expect(useStore.getState().profiles).toEqual([])
  })

  it('rejects rails obstructed by a board without adding profiles or connectors', () => {
    useStore.setState({ profiles: posts(), panels: [{ id: 'block', width: 100, height: 100, thickness: 18,
      material: 'ply', position: [-310, 187, 0], quaternion: [0, 0, 0, 1] }] })
    const before = useStore.getState()
    expect(addDrawerSupports(['drawer'])).toEqual({ generated: [], failed: [{ fittingId: 'drawer', side: 'left', reason: 'collision' }] })
    expect(useStore.getState()).toBe(before)
  })

  it('rejects a mixed-series joint without shared mounting slots', () => {
    const frame = [-315, 315].flatMap((x) => [-265, 265].map((z) => buildProfile(V(x, 0, z), V(x, 600, z), '3030')!))
    useStore.setState({ profiles: frame })
    const before = useStore.getState()
    expect(addDrawerSupports(['drawer'], '2020')).toEqual({ generated: [], failed: [{ fittingId: 'drawer', side: 'left', reason: 'no-connection' }] })
    expect(useStore.getState()).toBe(before)
  })

  it('automatically chooses a compatible rail for 4040 posts', () => {
    useStore.setState({ profiles: [-320, 320].flatMap((x) => [-270, 270].map((z) =>
      buildProfile(V(x, 0, z), V(x, 600, z), '4040')!)) })
    const result = addDrawerSupports(['drawer'])
    expect(result.failed).toEqual([])
    expect(result.generated).toHaveLength(2)
    const s = useStore.getState()
    expect(result.generated.map((r) => s.profiles.find((p) => p.id === r.profileId)?.spec)).toEqual(['4040', '4040'])
    expect(auditBrackets(s.profiles, s.connectors, computeAllTrims(s.profiles))).toEqual([])
  })

  it('generates supports in a rotated opening frame', () => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, 0.7, -0.2))
    const rotate = (p: ProfileData): ProfileData => ({ ...p,
      position: V(...p.position).applyQuaternion(q).toArray() as ProfileData['position'],
      quaternion: q.clone().multiply(new THREE.Quaternion(...p.quaternion)).toArray() as ProfileData['quaternion'] })
    const f = drawer()
    useStore.setState({ profiles: posts().map(rotate), fittings: [{ ...f,
      position: V(...f.position).applyQuaternion(q).toArray() as FittingData['position'],
      quaternion: q.toArray() as FittingData['quaternion'] }] })
    const result = addDrawerSupports(['drawer'])
    expect(result.failed).toEqual([])
    expect(result.generated).toHaveLength(2)
  })
})
