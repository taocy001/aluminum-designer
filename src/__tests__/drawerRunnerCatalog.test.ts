import { beforeEach, expect, it } from 'vitest'
import type { FittingData } from '../store/useStore'
import { useStore } from '../store/useStore'
import { drawerLayout } from '../utils/drawerLayout'
import { ACCURIDE_3832E } from '../utils/drawerRunnerCatalog'
import { validFitting } from '../utils/fittingValidation'
import { buildBom } from '../utils/bom'
import { updateDrawerConfig } from '../utils/fittingOps'
import { fittingParts, openTransform } from '../utils/fittingGeometry'

const drawer = (extra: Partial<FittingData> = {}): FittingData => ({
  id: 'drawer', kind: 'drawer', width: 600, height: 240, depth: 500,
  material: 'ply', open: 0, position: [0, 0, 0], quaternion: [0, 0, 0, 1], ...extra,
})
const catalog = (length = 450): FittingData => drawer({ drawer: { runnerModel: 'accuride-3832e', runnerLength: length } })
beforeEach(() => useStore.setState({ profiles: [], connectors: [], panels: [], fittings: [drawer()], selectedIds: ['drawer'], past: [], future: [] }))

it('resolves an explicit model to supplier travel instead of clipping it to rail length', () => {
  const f = catalog()
  expect(validFitting(f)).toBe(true)
  expect(drawerLayout(f)).toMatchObject({ runnerLength: 450, travel: 457, boxWidth: 574, config: { sideClearance: 13 } })
  expect(fittingParts(f).travel).toBe(457)
  expect(openTransform({ ...f, open: 1 }).position.z).toBe(457)
})

it.each(ACCURIDE_3832E.variants)('accepts a $length/$travel rail in a sufficiently deep opening', ({ length, travel }) => {
  const f = { ...catalog(length), depth: 800 }
  expect(validFitting(f)).toBe(true)
  expect(drawerLayout(f).travel).toBe(travel)
})

it('preserves legacy and custom geometry without opting into a catalog', () => {
  const f = drawer()
  expect(drawerLayout(f)).toMatchObject({ boxWidth: 575, travel: 470, runnerLength: 480 })
  expect(fittingParts(drawer({ drawer: { runnerModel: 'custom' } }))).toEqual(fittingParts(f))
  expect(f.drawer).toBeUndefined()
})

it('requires a supported model, standard length and matching optional travel', () => {
  for (const config of [
    { runnerModel: 'unknown', runnerLength: 450 },
    { runnerModel: 'accuride-3832e' },
    { runnerModel: 'accuride-3832e', runnerLength: 460 },
    { runnerModel: 'accuride-3832e', runnerLength: 450, runnerTravel: 400 },
  ]) expect(validFitting(drawer({ drawer: config as FittingData['drawer'] }))).toBe(false)
  expect(validFitting(drawer({ drawer: { ...catalog().drawer, runnerTravel: 457 } }))).toBe(true)
})

it('enforces side-gap limits, rear clearance, inset setback and sufficient board height', () => {
  for (const sideClearance of [12.7, 13.5]) expect(validFitting(drawer({ drawer: { ...catalog().drawer, sideClearance } }))).toBe(true)
  for (const sideClearance of [12.5, 13.6]) expect(validFitting(drawer({ drawer: { ...catalog().drawer, sideClearance } }))).toBe(false)
  expect(validFitting(catalog(500))).toBe(false) // 20 mm rear clearance leaves 480 mm.
  expect(validFitting({ ...catalog(), height: 60 })).toBe(false) // 40 mm side cannot contain a 45.7 mm rail.
  const inset = { ...catalog(), depth: 490, overlay: 'inset' as const }
  expect(drawerLayout(inset).availableRunnerDepth).toBeCloseTo(448.8)
  expect(validFitting(inset)).toBe(false)
  expect(validFitting({ ...inset, depth: 491.2 })).toBe(true)
})

it('does not merge a catalog SKU with a custom rail of the same length', () => {
  const custom = drawer({ id: 'custom', drawer: { runnerLength: 450, runnerTravel: 300 } })
  const rows = buildBom([], [], new Map(), 'en', [], [catalog(), { ...catalog(), id: 'b' }, custom]).connectors
  expect(rows.find(r => r.key === 'runner-accuride-3832e-3832-E18')).toMatchObject({ qty: 2, label: 'Accuride 3832-E18 · 450 mm', spec: 'side-mount pair · travel 457 mm' })
  expect(rows.find(r => r.key === 'runner-450')).toMatchObject({ qty: 1 })
})

it('changes model in one transaction, restores the custom configuration on undo and rejects invalid dimensions atomically', () => {
  const custom = drawer({ drawer: { runnerLength: 430, runnerTravel: 300, sideClearance: 14 } })
  useStore.setState({ fittings: [custom] })
  expect(updateDrawerConfig(['drawer'], { runnerModel: 'accuride-3832e', runnerLength: 450, runnerTravel: undefined, sideClearance: 13 })).toBe(true)
  expect(useStore.getState().past).toHaveLength(1)
  expect(drawerLayout(useStore.getState().fittings[0]).travel).toBe(457)
  const before = useStore.getState()
  expect(updateDrawerConfig(['drawer'], { runnerLength: 500 })).toBe(false)
  expect(useStore.getState()).toBe(before)
  useStore.getState().undo()
  expect(useStore.getState().fittings[0]).toEqual(custom)
  useStore.getState().redo()
  expect(drawerLayout(useStore.getState().fittings[0]).travel).toBe(457)
})

it('rejects a mixed locked batch without history but allows an explicit unlocked subset', () => {
  const original = [drawer(), drawer({ id: 'locked', locked: true })]
  useStore.setState({ fittings: original })
  const before = useStore.getState()
  const patch = { runnerModel: 'accuride-3832e' as const, runnerLength: 450, sideClearance: 13 }
  expect(updateDrawerConfig(['drawer', 'locked'], patch)).toBe(false)
  expect(useStore.getState()).toBe(before)
  expect(updateDrawerConfig(['drawer'], patch)).toBe(true)
  expect(useStore.getState().past).toHaveLength(1)
  expect(useStore.getState().fittings[1]).toEqual(original[1])
  useStore.getState().undo()
  expect(useStore.getState().fittings).toEqual(original)
})
