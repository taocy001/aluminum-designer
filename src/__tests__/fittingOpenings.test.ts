import { beforeEach, expect, it } from 'vitest'
import { useStore, type FittingData } from '../store/useStore'
import { closeAllFittings, setFittingOpen, setFittingsOpen } from '../utils/fittingOps'
import { describeChange } from '../utils/opLog'

const fitting = (id: string, locked: boolean): FittingData => ({
  id, kind: 'drawer', width: 500, height: 200, depth: 400,
  material: 'ply', open: 0, locked, position: [0, 0, 0], quaternion: [0, 0, 0, 1],
})

beforeEach(() => {
  useStore.setState({ profiles: [], connectors: [], panels: [],
    fittings: [fitting('locked', true), fitting('free', false)], selectedIds: [], past: [], future: [] })
  useStore.getState().updateFitting('free', { width: 550 })
  useStore.getState().updateFitting('free', { width: 600 })
  useStore.getState().undo()
})

it('opens locked and unlocked fittings through all controls without changing design history or logs', () => {
  const before = useStore.getState()
  setFittingsOpen(['locked', 'free'], 0.5)
  expect(useStore.getState().fittings.map((f) => f.open)).toEqual([0.5, 0.5])
  setFittingOpen('locked', 1)
  expect(useStore.getState().fittings[0].open).toBe(1)
  const opened = useStore.getState()
  expect(opened.past).toBe(before.past)
  expect(opened.future).toBe(before.future)
  expect(describeChange(before, opened)).toBeNull()
  closeAllFittings()
  expect(useStore.getState().fittings.map((f) => f.open)).toEqual([0, 0])
  expect(useStore.getState().past).toBe(before.past)
  expect(useStore.getState().future).toBe(before.future)
  useStore.getState().redo()
  expect(useStore.getState().fittings[1].width).toBe(600)
  useStore.getState().undo()
  expect(useStore.getState().fittings[1].width).toBe(550)
})

it('retains lock protection for design edits', () => {
  const before = useStore.getState()
  useStore.getState().updateFitting('locked', { width: 800 })
  expect(useStore.getState()).toBe(before)
})

it.each([NaN, Infinity, -Infinity])('ignores a nonfinite opening %s', (open) => {
  const before = useStore.getState()
  setFittingsOpen(['locked', 'free'], open)
  expect(useStore.getState()).toBe(before)
})

it('clamps finite values and leaves unrelated fittings unchanged', () => {
  const untouched = useStore.getState().fittings[1]
  setFittingOpen('locked', 2)
  expect(useStore.getState().fittings[0].open).toBe(1)
  setFittingOpen('locked', -1)
  expect(useStore.getState().fittings[0].open).toBe(0)
  expect(useStore.getState().fittings[1]).toBe(untouched)
})

it('does not publish unchanged or unknown openings', () => {
  const before = useStore.getState()
  setFittingOpen('missing', 1)
  setFittingsOpen(['locked', 'locked', 'free'], 0)
  closeAllFittings()
  expect(useStore.getState()).toBe(before)
})
