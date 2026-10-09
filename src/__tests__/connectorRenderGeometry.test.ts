import { expect, it } from 'vitest'
import { connectorMeshes } from '../utils/connectorGeometry'
import { connectorRenderMeshes } from '../utils/connectorRenderGeometry'
import { CONNECTOR_CATALOG } from '../utils/connectorCatalog'
import type { ConnectorMesh } from '../utils/connectorSolidPrimitives'

// Compare the rendered triangles, normals and materials, including non-indexed sources.
function triangles(parts: readonly Pick<ConnectorMesh, 'geometry' | 'dark' | 'polished' | 'previewDepthWrite'>[]) {
  return parts.flatMap(part => {
    const g = part.geometry, p = g.getAttribute('position'), n = g.getAttribute('normal')
    return Array.from({ length: (g.index?.count ?? p.count) / 3 }, (_, t) => {
      const vertices = [0, 1, 2].map(c => {
        const i = g.index?.getX(t * 3 + c) ?? t * 3 + c
        return [p.getX(i), p.getY(i), p.getZ(i), n.getX(i), n.getY(i), n.getZ(i)]
      })
      return JSON.stringify([!!part.dark, !!part.polished, !!part.previewDepthWrite, vertices])
    })
  }).sort()
}

for (const series of [20, 30, 40] as const) {
  it(`preserves all connector surfaces and shading in series ${series}`, () => {
    for (const { type } of CONNECTOR_CATALOG) {
      const source = connectorMeshes(type, series)
      const batched = connectorRenderMeshes(source)
      expect(triangles(batched), type).toEqual(triangles(source))
      expect(connectorRenderMeshes(source)).toBe(batched)
    }
  }, 30000)
}

it('reduces draw calls for threaded fasteners and preserves panel hardware', () => {
  const source = connectorMeshes('inside-corner')
  expect(connectorRenderMeshes(source).length).toBeLessThan(source.length)
  for (const mode of ['direct', undefined] as const) {
    const parts = connectorMeshes('bracket', 20, undefined, undefined, { mode, spacer: 2, boardThickness: 18, panelId: 'panel', profileId: 'profile' })
    expect(triangles(connectorRenderMeshes(parts))).toEqual(triangles(parts))
  }
})
