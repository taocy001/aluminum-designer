import type { ConnectorData, FittingData, PanelData, ProfileData } from '../store/useStore'
import { parseProjectDocument, validateProjectDocument, PROJECT_VERSION, type ParsedProjectDocument } from './document'
import type { ThroughRule } from './jointUtils'

/** Encode project data as compact arrays, deflate it and store it in a URL fragment. */

export interface ShareDoc {
  throughRule?: ThroughRule
  profiles: ProfileData[]
  connectors: ConnectorData[]
  panels: PanelData[]
  fittings: FittingData[]
}

/** Base link-length threshold used by the sharing UI. */
export const COMFORTABLE_URL = 8000

/** Compact columns for geometry and fitting parameters; reads link versions 1–5. */
function pack(doc: ShareDoc): unknown[] {
  const checked = validateProjectDocument(doc)
  return [
    5, checked.throughRule,
    checked.profiles.map((p) => [p.spec, p.length, p.position, p.quaternion, !!p.locked, p.miterCuts, p.holes, p.fixedTrims ?? null]),
    checked.connectors.map((c) => [c.type, c.series ?? 20, c.position, c.quaternion, !!c.locked]),
    checked.panels.map((b) => [b.width, b.height, b.thickness, b.position, b.quaternion, b.material, !!b.locked]),
    checked.fittings.map((f) => [
      f.kind, f.width, f.height, f.depth, f.position, f.quaternion,
      f.material, f.hinge ?? '', f.hingeType ?? '', f.overlay ?? '', f.swing ?? 0,
      f.frame, f.stacked ?? null, !!f.locked, f.meeting ?? '', f.drawer ?? null,
    ]),
  ]
}

function unpack(raw: unknown): ParsedProjectDocument {
  if (!Array.isArray(raw)) throw new Error('invalid link')
  const version = raw[0]
  if (version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5) throw new Error('unknown link version')
  const [profiles, connectors, panels, fittings] = raw.slice(version >= 2 ? 2 : 1) as unknown[][]
  if (raw.length !== (version >= 2 ? 6 : 5)
    || ![profiles, connectors, panels, fittings].every(Array.isArray)) throw new Error('incomplete link')
  const throughRule = version >= 2 ? raw[1] : 'rails'
  let n = 0
  const id = (p: string) => `${p}-s${(n++).toString(36)}`
  return parseProjectDocument({
    version: version >= 5 ? PROJECT_VERSION : version === 4 ? 6 : undefined,
    throughRule,
    profiles: (profiles ?? []).map((row) => {
      const [spec, length, position, quaternion, locked, miterCuts, holes, fixedTrims] = row as [string, number, number[], number[], number, ProfileData['miterCuts'], ProfileData['holes'], ProfileData['fixedTrims'] | null]
      return {
        id: id('p'), spec: spec as ProfileData['spec'], length,
        position: position as [number, number, number],
        quaternion: quaternion as [number, number, number, number],
        miterCuts: miterCuts ?? [], holes: holes ?? [], ...(locked ? { locked: true } : {}),
        ...(version >= 3 && fixedTrims !== null && fixedTrims !== undefined ? { fixedTrims } : {}),
      }
    }),
    connectors: (connectors ?? []).map((row) => {
      const [type, series, position, quaternion, locked] = row as [string, number, number[], number[], boolean]
      return {
        id: id('c'), type, ...(locked ? { locked: true } : {}), series: series as ConnectorData['series'],
        position: position as [number, number, number],
        quaternion: quaternion as [number, number, number, number],
      }
    }),
    panels: (panels ?? []).map((row) => {
      const [width, height, thickness, position, quaternion, material, locked] = row as [number, number, number, number[], number[], string, boolean]
      return {
        id: id('b'), width, height, thickness, ...(locked ? { locked: true } : {}),
        position: position as [number, number, number],
        quaternion: quaternion as [number, number, number, number],
        material: material as PanelData['material'],
      }
    }),
    fittings: (fittings ?? []).map((row) => {
      const [kind, width, height, depth, position, quaternion, material, hinge, hingeType, overlay, swing, frame, stacked, locked, meeting, drawer] =
        row as [string, number, number, number, number[], number[], string, string, string, string, number, number, FittingData['stacked'], boolean, FittingData['meeting'] | '', FittingData['drawer'] | null]
      return {
        id: id('f'), kind: kind as FittingData['kind'], width, height, depth,
        position: position as [number, number, number],
        quaternion: quaternion as [number, number, number, number],
        material: material as PanelData['material'], open: 0,
        ...(frame !== undefined && frame !== null ? { frame } : {}),
        ...(stacked ? { stacked } : {}),
        ...(locked ? { locked: true } : {}),
        ...(hinge ? { hinge: hinge as FittingData['hinge'] } : {}),
        ...(hingeType ? { hingeType: hingeType as FittingData['hingeType'] } : {}),
        ...(overlay ? { overlay: overlay as FittingData['overlay'] } : {}),
        ...(swing ? { swing } : {}),
        ...(version >= 4 && meeting !== undefined && meeting !== '' ? { meeting } : {}),
        ...(version >= 5 && drawer !== undefined && drawer !== null ? { drawer } : {}),
      }
    }),
  })
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
  if (bytes.length > 1_000_000) throw new Error('link too large')
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > 5_000_000) { await reader.cancel(); throw new Error('project too large') }
    chunks.push(value)
  }
  return new Blob(chunks as BlobPart[]).text()
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
export async function decodeShare(payload: string): Promise<ParsedProjectDocument> {
  if (payload.length > 1_400_000) throw new Error('link too large')
  return unpack(JSON.parse(await inflate(fromUrlSafe(payload))))
}
