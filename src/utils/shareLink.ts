import type { ConnectorData, FittingData, PanelData, ProfileData } from '../store/useStore'

/**
 * The drawing, in a link.
 *
 * An open tool spreads by being sent to people, and a file attachment is not being sent to
 * people — it is being asked to download something. The whole drawing goes in the URL, so a
 * link is the drawing: no account, no server, nothing to trust. It also means a link keeps
 * working after this tool stops being maintained, which is the kind of promise a file format
 * makes and a database does not.
 *
 * The cost is length. A drawing is mostly repeated keys and round numbers, so it is packed
 * into short arrays first and then deflated — about a twentieth of the JSON, which keeps a
 * cabinet inside what every browser and chat app will carry.
 */

export interface ShareDoc {
  profiles: ProfileData[]
  connectors: ConnectorData[]
  panels: PanelData[]
  fittings: FittingData[]
}

/** what most links will exceed, and every browser will still carry */
export const COMFORTABLE_URL = 8000

const r3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * Columns rather than records.
 *
 * `[{id, spec, length}, {id, spec, length}]` spends most of its bytes on the words `id`,
 * `spec` and `length`. The same data as parallel arrays says each word once.
 */
function pack(doc: ShareDoc): unknown[] {
  return [
    1,
    doc.profiles.map((p) => [p.spec, r3(p.length), p.position.map(r3), p.quaternion.map(r3), p.locked ? 1 : 0]),
    doc.connectors.map((c) => [c.type, c.series ?? 20, c.position.map(r3), c.quaternion.map(r3)]),
    doc.panels.map((b) => [r3(b.width), r3(b.height), r3(b.thickness), b.position.map(r3), b.quaternion.map(r3), b.material]),
    doc.fittings.map((f) => [
      f.kind, r3(f.width), r3(f.height), r3(f.depth), f.position.map(r3), f.quaternion.map(r3),
      f.material, f.hinge ?? '', f.hingeType ?? '', f.overlay ?? '', f.swing ?? 0,
    ]),
  ]
}

function unpack(raw: unknown): ShareDoc {
  const [version, profiles, connectors, panels, fittings] = raw as [number, unknown[], unknown[], unknown[], unknown[]]
  if (version !== 1) throw new Error('unknown link version')
  let n = 0
  const id = (p: string) => `${p}-s${(n++).toString(36)}`
  return {
    profiles: (profiles ?? []).map((row) => {
      const [spec, length, position, quaternion, locked] = row as [string, number, number[], number[], number]
      return {
        id: id('p'), spec: spec as ProfileData['spec'], length,
        position: position as [number, number, number],
        quaternion: quaternion as [number, number, number, number],
        miterCuts: [], holes: [], ...(locked ? { locked: true } : {}),
      }
    }),
    connectors: (connectors ?? []).map((row) => {
      const [type, series, position, quaternion] = row as [string, number, number[], number[]]
      return {
        id: id('c'), type, series: series as ConnectorData['series'],
        position: position as [number, number, number],
        quaternion: quaternion as [number, number, number, number],
      }
    }),
    panels: (panels ?? []).map((row) => {
      const [width, height, thickness, position, quaternion, material] = row as [number, number, number, number[], number[], string]
      return {
        id: id('b'), width, height, thickness,
        position: position as [number, number, number],
        quaternion: quaternion as [number, number, number, number],
        material: material as PanelData['material'],
      }
    }),
    fittings: (fittings ?? []).map((row) => {
      const [kind, width, height, depth, position, quaternion, material, hinge, hingeType, overlay, swing] =
        row as [string, number, number, number, number[], number[], string, string, string, string, number]
      return {
        id: id('f'), kind: kind as FittingData['kind'], width, height, depth,
        position: position as [number, number, number],
        quaternion: quaternion as [number, number, number, number],
        material: material as PanelData['material'], open: 0,
        ...(hinge ? { hinge: hinge as FittingData['hinge'] } : {}),
        ...(hingeType ? { hingeType: hingeType as FittingData['hingeType'] } : {}),
        ...(overlay ? { overlay: overlay as FittingData['overlay'] } : {}),
        ...(swing ? { swing } : {}),
      }
    }),
  }
}

/** base64url: '+' and '/' are not safe in a URL, and '=' is only padding */
function toUrlSafe(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromUrlSafe(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

async function deflate(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function inflate(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Response(stream).text()
}

/** The whole drawing as a link to this page */
export async function encodeShareLink(doc: ShareDoc, base = window.location.href): Promise<string> {
  const payload = toUrlSafe(await deflate(JSON.stringify(pack(doc))))
  const url = new URL(base)
  url.hash = `d=${payload}`
  return url.toString()
}

/**
 * Take the drawing out of the address bar and hand it back.
 *
 * Synchronous, and it clears before anything is decoded, for two reasons: a reload should
 * not reset the drawing to whatever was sent, and a link that turns out to be unreadable
 * should not sit in the bar either. Decoding is the caller's problem, and it can fail.
 */
export function takeShareLink(): string | null {
  const m = /(?:^#|&)d=([A-Za-z0-9\-_]+)/.exec(window.location.hash)
  if (!m) return null
  history.replaceState(null, '', window.location.pathname + window.location.search)
  return m[1]
}

/** The drawing a payload carries */
export async function decodeShare(payload: string): Promise<ShareDoc> {
  return unpack(JSON.parse(await inflate(fromUrlSafe(payload))))
}
