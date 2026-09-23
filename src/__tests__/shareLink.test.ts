import { describe, it, expect } from 'vitest'
import { encodeShareLink, decodeShare } from '../utils/shareLink'
import type { ShareDoc } from '../utils/shareLink'
import { TEMPLATES } from '../utils/templates'

const empty: ShareDoc = { profiles: [], connectors: [], panels: [], fittings: [] }

const fromTemplate = (id: string): ShareDoc => {
  const t = TEMPLATES.find((x) => x.id === id)!
  const v: Record<string, number> = {}
  for (const p of t.params) v[p.key] = p.value
  return { ...empty, profiles: t.build(v) }
}

const payloadOf = (link: string) => /#d=(.+)$/.exec(link)![1]

/**
 * A link is the drawing: no account, no upload, nothing to trust. That only holds if what
 * comes out the far end is the same drawing, down to the millimetre.
 */
describe('a drawing in a link', () => {
  it('survives the round trip unchanged', async () => {
    const doc = fromTemplate('bench')
    const back = await decodeShare(payloadOf(await encodeShareLink(doc, 'https://example.com/')))
    expect(back.profiles.length).toBe(doc.profiles.length)
    for (let i = 0; i < doc.profiles.length; i++) {
      expect(back.profiles[i].spec).toBe(doc.profiles[i].spec)
      expect(back.profiles[i].length).toBeCloseTo(doc.profiles[i].length, 2)
      expect(back.profiles[i].position.map((n) => Math.round(n * 100))).toEqual(doc.profiles[i].position.map((n) => Math.round(n * 100)))
      expect(back.profiles[i].quaternion.map((n) => Math.round(n * 1000))).toEqual(doc.profiles[i].quaternion.map((n) => Math.round(n * 1000)))
    }
  })

  it('carries boards, brackets and drawers too', async () => {
    const doc: ShareDoc = {
      profiles: fromTemplate('cabinet').profiles,
      connectors: [{ id: 'c1', type: 'inside-corner', series: 20, position: [10, 20, 30], quaternion: [0, 0, 0, 1] }],
      panels: [{ id: 'b1', width: 560, height: 350, thickness: 18, position: [1, 2, 3], quaternion: [0, 0, 0, 1], material: 'mdf' }],
      fittings: [{ id: 'f1', kind: 'door', position: [4, 5, 6], quaternion: [0, 0, 0, 1], width: 580, height: 760, depth: 600,
        material: 'mdf', open: 0, hinge: 'right', hingeType: 'slot', overlay: 'half', swing: 165 }],
    }
    const back = await decodeShare(payloadOf(await encodeShareLink(doc, 'https://example.com/')))
    expect(back.connectors[0].type).toBe('inside-corner')
    expect(back.panels[0].material).toBe('mdf')
    expect(back.fittings[0].hinge).toBe('right')
    expect(back.fittings[0].hingeType).toBe('slot')
    expect(back.fittings[0].overlay).toBe('half')
    expect(back.fittings[0].swing).toBe(165)
  })

  it('a door arrives shut, however it was sent', async () => {
    const doc: ShareDoc = { ...empty, fittings: [{ id: 'f', kind: 'drawer', position: [0, 0, 0], quaternion: [0, 0, 0, 1],
      width: 500, height: 200, depth: 500, material: 'ply', open: 1 }] }
    const back = await decodeShare(payloadOf(await encodeShareLink(doc, 'https://example.com/')))
    expect(back.fittings[0].open).toBe(0)
  })

  it('an empty drawing makes a link, and it is empty', async () => {
    const back = await decodeShare(payloadOf(await encodeShareLink(empty, 'https://example.com/')))
    expect(back.profiles).toEqual([])
  })

  it('the link is URL-safe throughout', async () => {
    const link = await encodeShareLink(fromTemplate('shelving'), 'https://example.com/')
    expect(payloadOf(link)).toMatch(/^[A-Za-z0-9\-_]+$/)
  })

  it('it is small enough to send: a frame in a fraction of its JSON', async () => {
    const doc = fromTemplate('shelving')
    const json = JSON.stringify(doc).length
    const link = (await encodeShareLink(doc, 'https://example.com/')).length
    expect(link).toBeLessThan(json / 2)
  })

  it('a link that is not ours is refused rather than half-read', async () => {
    await expect(decodeShare('bm90b3Vycw')).rejects.toBeTruthy()
  })

  it('every template fits in a link', async () => {
    for (const t of TEMPLATES) {
      const link = await encodeShareLink(fromTemplate(t.id), 'https://example.com/')
      expect(link.length).toBeLessThan(8000)
    }
  })
})
