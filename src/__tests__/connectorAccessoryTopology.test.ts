import { describe, expect, it } from 'vitest'
import { connectorMeshes } from '../utils/connectorGeometry'

/** A STEP CLOSED_SHELL requires every welded edge to occur twice in opposite directions. */
describe('closed accessory connector meshes', () => {
  for (const type of ['flat-plate', 'joining-plate', 'end-cap', 'caster-mount', 'foot', 'cross-bracket', 't-bracket', 't-nut', 'hinge', 'pivot']) {
    it.each([20, 30, 40] as const)(`${type} series %s exports only closed, consistently oriented bodies`, (series) => {
      for (const { geometry } of connectorMeshes(type, series)) {
        const p = geometry.getAttribute('position'), index = geometry.getIndex()
        const edges = new Map<string, { count: number; orientation: number }>()
        let faces = 0
        for (let i = 0; i < (index?.count ?? p.count); i += 3) {
          const triangle = [0, 1, 2].map((j) => {
            const v = index ? index.getX(i + j) : i + j
            return [p.getX(v), p.getY(v), p.getZ(v)].map((n) => String(Math.round(n * 1e4) / 1e4)).join(',')
          })
          if (new Set(triangle).size < 3) continue
          faces++
          for (let j = 0; j < 3; j++) {
            const a = triangle[j], b = triangle[(j + 1) % 3], key = [a, b].sort().join('/')
            const edge = edges.get(key) ?? { count: 0, orientation: 0 }
            edge.count++; edge.orientation += a < b ? 1 : -1; edges.set(key, edge)
          }
        }
        expect(faces).toBeGreaterThan(0)
        expect([...edges.values()].filter((edge) => edge.count !== 2 || edge.orientation !== 0)).toEqual([])
      }
    })
  }
})
