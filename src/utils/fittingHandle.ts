import type { FittingData, HandleConfig } from '../store/useStore'
import { fittingHandle, frontBoard } from './fittingGeometry'
import { boardBlank } from './boardFabrication'

/** Seed an editable envelope from the existing illustration; applying confirms these dimensions. */
export function handleDraft(f: FittingData): HandleConfig {
  if (f.handle) return { ...f.handle }
  const front = frontBoard(f), { grip, mounts } = fittingHandle(f)
  const horizontal = f.kind === 'drawer' || f.hinge === 'top' || f.hinge === 'bottom'
  return { pitch: Math.max(16, grip.size[horizontal ? 0 : 1] - grip.size[2]),
    projection: grip.position[2] + grip.size[2] / 2 - front.position[2] - front.thickness / 2,
    thickness: grip.size[2], holeDiameter: 4.5,
    x: mounts[0].position[0] - front.position[0] + (horizontal ? (grip.size[0] - grip.size[2]) / 2 : 0),
    y: mounts[0].position[1] - front.position[1] + (horizontal ? 0 : (grip.size[1] - grip.size[2]) / 2) }
}

export function validHandleFields(v: unknown): v is HandleConfig {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const h = v as HandleConfig
  return ['pitch', 'projection', 'thickness', 'holeDiameter', 'x', 'y'].every(k =>
    typeof h[k as keyof HandleConfig] === 'number' && Number.isFinite(h[k as keyof HandleConfig]))
    && Object.keys(v).every(k => ['pitch', 'projection', 'thickness', 'holeDiameter', 'x', 'y'].includes(k))
    && h.thickness > 0 && h.pitch > h.thickness && h.projection > h.thickness
    && h.projection <= 200 && h.holeDiameter > 0 && h.holeDiameter < h.thickness
}

/** Hole centres in each board's local XY frame, shared by display and fabrication exports. */
export function fittingHandleHoles(f: FittingData, key: string): { x: number; y: number; diameter: number }[] {
  const front = frontBoard(f)
  if (!f.handle || key !== front.key) return []
  return fittingHandle(f).mounts.map(m => ({ x: m.position[0] - front.position[0],
    y: m.position[1] - front.position[1], diameter: f.handle!.holeDiameter }))
}

/** Both the envelope and the bores must fit the finished front and its unbanded blank. */
export function handleFitsFront(f: FittingData): boolean {
  if (!f.handle) return true
  if (!validHandleFields(f.handle)) return false
  const front = frontBoard(f), handle = fittingHandle(f)
  if ([handle.grip, ...handle.mounts].some(b => [0, 1].some(i =>
    Math.abs(b.position[i] - front.position[i]) + b.size[i] / 2 > (i ? front.height : front.width) / 2))) return false
  const fabrication = f.fabrication?.[front.key]
  let blank: { width: number; height: number }
  try { blank = boardBlank(front.width, front.height, fabrication) } catch { return false }
  return fittingHandleHoles(f, front.key).every(h => {
    const x = h.x + front.width / 2 - (fabrication?.bands[0] ?? 0)
    const y = h.y + front.height / 2 - (fabrication?.bands[2] ?? 0)
    const r = h.diameter / 2
    return x > r && y > r && x + r < blank.width && y + r < blank.height
  })
}
