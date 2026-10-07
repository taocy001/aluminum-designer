import { describe, expect, it } from 'vitest'
import { CONNECTOR_CATALOG } from '../utils/connectorCatalog'
import manifest from '../assets/connectorThumbnails.json'
import { checkThumbnails } from '../../scripts/connector-thumbnail-sources.mjs'

describe('offline connector thumbnails', () => {
  it('includes the complete picker catalogue in every supported series', () => {
    const expected = CONNECTOR_CATALOG.flatMap(({ type }) => [20, 30, 40].map((series) => `${type}:${series}`))
    expect(Object.keys(manifest.images).sort()).toEqual(expected.sort())
    expect(manifest.width).toBe(168)
    expect(manifest.height).toBe(168)
  })

  it('matches the geometry sources and the checked-in PNG contents', () => {
    expect(() => checkThumbnails()).not.toThrow()
  })
})
