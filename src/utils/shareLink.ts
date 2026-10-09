import type { PartGroup } from './groupMetadata'
import type { TemplateInstance } from './templateMetadata'
import type { ConnectorData, EquipmentData, FittingData, PanelData, ProfileData } from '../store/useStore'
import { parseProjectDocument, validateProjectDocument, PROJECT_VERSION, type ParsedProjectDocument } from './document'
import type { ThroughRule } from './jointUtils'

/** Encode project data as compact arrays, deflate it and store it in a URL fragment. */

export interface ShareDoc {
  templateInstances?: TemplateInstance[]
  groups?: PartGroup[]
  throughRule?: ThroughRule
  profiles: ProfileData[]
  connectors: ConnectorData[]
  panels: PanelData[]
  fittings: FittingData[]
  equipment?: EquipmentData[]
}

/** Base link-length threshold used by the sharing UI. */
export const COMFORTABLE_URL = 8000

/** Compact columns for geometry, stable IDs and bindings; reads link versions 1–12. */
function pack(doc: ShareDoc): unknown[] {
  const checked = validateProjectDocument(doc)
  return [
    12, checked.throughRule,
    checked.profiles.map((p) => [p.spec, p.length, p.position, p.quaternion, !!p.locked, p.miterCuts, p.holes, p.fixedTrims ?? null,
      p.id, p.runnerBinding ?? null]),
    checked.connectors.map((c) => [c.type, c.series ?? 20, c.position, c.quaternion, !!c.locked, c.id, c.supportBinding ?? null, c.profileSpec ?? null, c.mountSeries ?? null, c.panelMount ?? null]),
    checked.panels.map((b) => [b.width, b.height, b.thickness, b.position, b.quaternion, b.material, !!b.locked, b.id, b.openingBinding ?? null, b.fabrication ?? null]),
    checked.fittings.map((f) => [
      f.kind, f.width, f.height, f.depth, f.position, f.quaternion,
      f.material, f.hinge ?? '', f.hingeType ?? '', f.overlay ?? '', f.swing ?? 0,
      f.frame, f.stacked ?? null, !!f.locked, f.meeting ?? '', f.drawer ?? null, f.id, f.openingBinding ?? null, f.fabrication ?? null, f.handle ?? null,
    ]),
    checked.equipment.map((e) => [e.id, e.name, e.width, e.height, e.depth, e.position, e.quaternion, e.clearance, !!e.locked]),
    checked.templateInstances ?? null, checked.groups ?? null,
  ]
}

function unpack(raw: unknown): ParsedProjectDocument {
  if (!Array.isArray(raw)) throw new Error('invalid link')
  const version = raw[0]
  if (!Number.isInteger(version) || version < 1 || version > 12) throw new Error('unknown link version')
  const [profiles, connectors, panels, fittings, equipment = [], templateInstances = [], groups = []] = raw.slice(version >= 2 ? 2 : 1) as unknown[][]
  if (raw.length !== (version >= 10 ? 9 : version >= 7 ? 7 : version >= 2 ? 6 : 5)
    || ![profiles, connectors, panels, fittings, equipment].every(Array.isArray)) throw new Error('incomplete link')
  const throughRule = version >= 2 ? raw[1] : 'rails'
  let n = 0
  const id = (p: string) => `${p}-s${(n++).toString(36)}`
  return parseProjectDocument({
    version: version >= 7 ? PROJECT_VERSION : version === 6 ? 8 : version === 5 ? 7 : version === 4 ? 6 : undefined,
    throughRule,
    ...(version >= 10 && templateInstances !== null ? { templateInstances } : {}),
    ...(version >= 10 && groups !== null ? { groups } : {}),
    equipment: equipment.map((row) => {
      if (!Array.isArray(row) || row.length !== 9) throw new Error('invalid equipment link')
      const [id, name, width, height, depth, position, quaternion, clearance, locked] = row
      return { id, name, width, height, depth, position, quaternion, clearance, locked }
    }),
    profiles: (profiles ?? []).map((row) => {
      const [spec, length, position, quaternion, locked, miterCuts, holes, fixedTrims, originalId, runnerBinding] = row as [string, number, number[], number[], number, ProfileData['miterCuts'], ProfileData['holes'], ProfileData['fixedTrims'] | null, string, ProfileData['runnerBinding'] | null]
      return {
        id: version >= 6 ? originalId : id('p'), spec: spec as ProfileData['spec'], length,
        position: position as [number, number, number],
        quaternion: quaternion as [number, number, number, number],
        miterCuts: miterCuts ?? [], holes: holes ?? [], ...(locked ? { locked: true } : {}),
        ...(version >= 3 && fixedTrims !== null && fixedTrims !== undefined ? { fixedTrims } : {}),
        ...(version >= 6 && runnerBinding !== null && runnerBinding !== undefined ? { runnerBinding } : {}),
      }
    }),
    connectors: (connectors ?? []).map((row) => {
      const [type, series, position, quaternion, locked, originalId, supportBinding, profileSpec, mountSeries, panelMount] = row as [string, number, number[], number[], boolean, string, ConnectorData['supportBinding'] | null, ConnectorData['profileSpec'] | null, ConnectorData['mountSeries'] | null, ConnectorData['panelMount'] | null]
      return {
        id: version >= 6 ? originalId : id('c'), type, ...(locked ? { locked: true } : {}), series: series as ConnectorData['series'],
        position: position as [number, number, number],
        quaternion: quaternion as [number, number, number, number],
        ...(version >= 9 && panelMount != null ? { panelMount } : {}),
        ...(version >= 8 && profileSpec != null ? { profileSpec } : {}),
        ...(version >= 8 && mountSeries != null ? { mountSeries } : {}),
        ...(version >= 6 && supportBinding !== null && supportBinding !== undefined ? { supportBinding } : {}),
      }
    }),
    panels: (panels ?? []).map((row) => {
      const [width, height, thickness, position, quaternion, material, locked, originalId, openingBinding, fabrication] = row as [number, number, number, number[], number[], string, boolean, string, PanelData['openingBinding'] | null, PanelData['fabrication'] | null]
      return {
        id: version >= 6 ? originalId : id('b'), width, height, thickness, ...(locked ? { locked: true } : {}),
        position: position as [number, number, number],
        quaternion: quaternion as [number, number, number, number],
        material: material as PanelData['material'],
        ...(version >= 11 && fabrication != null ? { fabrication } : {}),
        ...(version >= 6 && openingBinding !== null && openingBinding !== undefined ? { openingBinding } : {}),
      }
    }),
    fittings: (fittings ?? []).map((row) => {
      const [kind, width, height, depth, position, quaternion, material, hinge, hingeType, overlay, swing, frame, stacked, locked, meeting, drawer, originalId, openingBinding, fabrication, handle] =
        row as [string, number, number, number, number[], number[], string, string, string, string, number, number, FittingData['stacked'], boolean, FittingData['meeting'] | '', FittingData['drawer'] | null, string, FittingData['openingBinding'] | null, FittingData['fabrication'] | null, FittingData['handle'] | null]
      return {
        id: version >= 6 ? originalId : id('f'), kind: kind as FittingData['kind'], width, height, depth,
        position: position as [number, number, number],
        quaternion: quaternion as [number, number, number, number],
        material: material as PanelData['material'],
        ...(version >= 11 && fabrication != null ? { fabrication } : {}),
        ...(version >= 12 && handle != null ? { handle } : {}), open: 0,
        ...(frame !== undefined && frame !== null ? { frame } : {}),
        ...(stacked ? { stacked } : {}),
        ...(locked ? { locked: true } : {}),
        ...(hinge ? { hinge: hinge as FittingData['hinge'] } : {}),
        ...(hingeType ? { hingeType: hingeType as FittingData['hingeType'] } : {}),
        ...(overlay ? { overlay: overlay as FittingData['overlay'] } : {}),
        ...(swing ? { swing } : {}),
        ...(version >= 4 && meeting !== undefined && meeting !== '' ? { meeting } : {}),
        ...(version >= 5 && drawer !== undefined && drawer !== null ? { drawer } : {}),
        ...(version >= 6 && openingBinding !== undefined && openingBinding !== null ? { openingBinding } : {}),
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
