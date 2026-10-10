import { afterEach, expect, it, vi } from 'vitest'
import { buildStep, buildStepBytes, type StepInput } from '../utils/step'

afterEach(() => vi.useRealTimers())

it('chunked output exactly matches text, including escaping, ordering and final newline', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  const input: StepInput = {
    profiles: [], name: "柜体 '\\ test 🧰",
    panels: [{ id: '板材', material: 'ply', width: 400, height: 300, thickness: 18, position: [0, 100, 50], quaternion: [0, 0, 0, 1] }],
    connectors: Array.from({ length: 8 }, (_, i) => ({ id: `corner-${i}`, type: 'inside-corner', series: 20,
      position: [60 * i, 100, 50], quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2] })),
  }
  const text = buildStep(input)
  expect(text.split('\n').length).toBeGreaterThan(4096)
  expect(new Uint8Array(buildStepBytes(input))).toEqual(new TextEncoder().encode(text))
})

it('exports an empty assembly without adding blank records', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  const input = { profiles: [] }
  expect(new TextDecoder().decode(buildStepBytes(input))).toBe(buildStep(input))
})
