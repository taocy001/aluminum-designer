import { describe, expect, it, vi } from 'vitest'
import { RenderResources } from '../utils/renderResources'

describe('scene render resources', () => {
  const look = { color: '#94a3b8', metalness: .3, roughness: .55 }
  it('shares equal appearances and keeps selection, transparency and metal finishes separate', () => {
    const resources = new RenderResources()
    const normal = resources.standard(look)
    expect(resources.standard({ ...look, emissive: '#000000', emissiveIntensity: 1, opacity: 1, transparent: false })).toBe(normal)
    const selected = resources.standard({ ...look, color: '#60a5fa', emissive: '#1d4ed8', emissiveIntensity: .9 })
    expect(selected).not.toBe(normal)
    expect(normal.color.getHexString()).toBe('94a3b8')
    expect(normal.emissive.getHexString()).toBe('000000')
    expect(resources.standard({ ...look, transparent: true, opacity: .32 })).not.toBe(normal)
    expect(resources.standard({ ...look, metalness: .8, roughness: .2 })).not.toBe(normal)
    expect(resources.line('#475569', .8)).toBe(resources.line('#475569', .8))
    expect(resources.line('#475569', .5)).not.toBe(resources.line('#475569', .8))
    resources.dispose()
  })

  it('owns profile buffers per scene and releases every resource on teardown', () => {
    const a = new RenderResources(), b = new RenderResources()
    const profile = a.profile('2040'), material = a.standard(look), line = a.line('#475569', .8)
    expect(a.profile('2040')).toBe(profile)
    expect(a.profile('2020')).not.toBe(profile)
    expect(b.profile('2040')).not.toBe(profile)
    profile.computeBoundingBox()
    expect(profile.boundingBox!.max.z - profile.boundingBox!.min.z).toBe(1)
    const callbacks = [profile, material, line].map(resource => {
      const callback = vi.fn()
      resource.addEventListener('dispose', callback)
      return callback
    })
    a.dispose()
    callbacks.forEach(callback => expect(callback).toHaveBeenCalledTimes(1))
    // React can restart effects using the same resource owner.
    expect(a.profile('2040').getAttribute('position').count).toBeGreaterThan(0)
    expect(a.standard(look)).toBe(material)
    a.dispose()
    callbacks.forEach(callback => expect(callback).toHaveBeenCalledTimes(2))
    b.dispose()
  })
})
