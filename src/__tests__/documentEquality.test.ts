import { expect, it } from 'vitest'
import { sameDocumentValue } from '../utils/documentEquality'

it('compares document values with optional fields and shared subtrees', () => {
  const shared = { supports: ['p1', 'p2'], orientation: [0, 0, 0, 1] }
  const a = { position: [1, 2, 3], binding: shared, locked: undefined }
  expect(sameDocumentValue(a, { binding: shared, position: [1, 2, 3] })).toBe(true)
  expect(sameDocumentValue(a, JSON.parse(JSON.stringify(a)))).toBe(true)
  expect(sameDocumentValue(a, { ...a, position: [1, 2, 4] })).toBe(false)
  expect(sameDocumentValue(a, { ...a, binding: { ...shared, supports: ['p2', 'p1'] } })).toBe(false)
  expect(sameDocumentValue(a, { ...a, locked: true })).toBe(false)
  expect(sameDocumentValue([1, 2], { 0: 1, 1: 2 })).toBe(false)
  expect(sameDocumentValue(null, {})).toBe(false)
})
